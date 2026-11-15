import { chromium, type Browser, type BrowserContext, type Page, type Download } from "playwright-core";
import lambdaChromium from "@sparticuz/chromium";
import { readFile } from "node:fs/promises";
import { credentialKey, openCredential } from "./credential-crypto";
import { syncCredentials } from "./auth";

export type ArcaTimeoutStage = "LOGIN" | "SERVICE" | "REPRESENTATION" | "QUERY" | "EXPORT";

/**
 * Códigos que distinguen dónde falló la descarga:
 *  - ARCA_SESSION / VERIFICATION_REQUIRED: sesión vencida o verificación pendiente;
 *  - REPRESENTATION_REQUIRED: ARCA no confirmó el CUIT del cliente;
 *  - ARCA_PERIOD: ARCA no confirmó el período pedido;
 *  - ARCA_PAGE: la pantalla no tiene los controles esperados (no hay archivo);
 *  - ARCA_DOWNLOAD: la exportación no entregó contenido;
 *  - ARCA_FORMAT: el archivo descargado es inutilizable (vacío o excedido).
 * Si el importador rechaza el contenido, la tarea queda con IMPORT_REJECTED.
 * «Sin resultados» no es un error: la tarea termina EMPTY.
 */
export type ArcaErrorCode = "ARCA_SESSION" | "ARCA_DOWNLOAD" | "ARCA_FORMAT" | "ARCA_PAGE" | "ARCA_PERIOD" | "CREDENTIALS_MISSING"
    | "VERIFICATION_REQUIRED" | "REPRESENTATION_REQUIRED" | `ARCA_TIMEOUT_${ArcaTimeoutStage}`;

export class ArcaBrowserError extends Error {
    constructor(readonly code: ArcaErrorCode) {
        super(code);
        this.name = "ArcaBrowserError";
    }
}

async function atStage<T>(stage: ArcaTimeoutStage, operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            throw new ArcaBrowserError(`ARCA_TIMEOUT_${stage}`);
        }
        throw error;
    }
}

// Los registros sólo llevan nombres de pasos y códigos fijos del conector:
// nunca claves, cookies, direcciones con parámetros ni datos de comprobantes.
async function traceStep<T>(step: string, operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            console.warn(`[arca-sync] timeout step=${step}`);
        }
        throw error;
    }
}

function fail(code: ArcaErrorCode, step: string): never {
    console.warn(`[arca-sync] fail step=${step} code=${code}`);
    throw new ArcaBrowserError(code);
}

const dashedCuit = (cuit: string) => `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
const periodDates = (task: { year: number; month: number }) => {
    const month = String(task.month).padStart(2, "0");
    const last = new Date(Date.UTC(task.year, task.month, 0)).getUTCDate();
    return { start: `01/${month}/${task.year}`, end: `${last}/${month}/${task.year}` };
};

const MAX_EXPORT_BYTES = 2 * 1024 * 1024;

export interface ArcaDownloadTask {
    cuit: string;
    clientId?: string;
    organizationId?: string;
    storedCredential?: { targetCuit: string; envelope: string } | null;
    year: number;
    month: number;
    source: "SALES" | "PURCHASES" | "RETENTIONS" | "PERCEPTIONS";
}

type Credential = { cuit: string; password: string };
type ArcaFile = { file: string; format?: "PORTAL_CSV" | "MIS_COMPROBANTES" };
export type ArcaDownloadResult = { files: ArcaFile[]; empty: boolean };

function credentialFor(task: ArcaDownloadTask): Credential {
    if (task.storedCredential) {
        const key = credentialKey();
        if (key && task.clientId && task.organizationId && task.storedCredential.targetCuit === task.cuit) {
            try {
                return openCredential(task.storedCredential.envelope, {
                    clientId: task.clientId, organizationId: task.organizationId, targetCuit: task.cuit,
                }, key);
            } catch {
                throw new ArcaBrowserError("CREDENTIALS_MISSING");
            }
        }
        throw new ArcaBrowserError("CREDENTIALS_MISSING");
    }
    const credential = syncCredentials(task.cuit, task.clientId);
    if (!credential) throw new ArcaBrowserError("CREDENTIALS_MISSING");
    return credential;
}

async function verifySession(page: Page) {
    const text = await page.locator("body").innerText({ timeout: 15000 });
    if (/no se encuentra logueado|su sesión expiró|sesión.*vencida|expiredSession/i.test(text + page.url())) {
        throw new ArcaBrowserError("ARCA_SESSION");
    }
    if (/captcha|verificá que sos|verifica que eres/i.test(text)) throw new ArcaBrowserError("VERIFICATION_REQUIRED");
}

function serviceSearch(page: Page) {
    const label = /buscá trámites y servicios/i;
    return page.getByPlaceholder(label)
        .or(page.getByRole("searchbox", { name: label }))
        .or(page.getByRole("textbox", { name: label }));
}

async function login(context: BrowserContext, credential: Credential) {
    const page = await context.newPage();
    await page.goto("https://auth.afip.gob.ar/contribuyente_/login.xhtml", { waitUntil: "domcontentloaded" });
    await page.getByRole("spinbutton").fill(credential.cuit);
    await page.getByRole("button", { name: "Siguiente", exact: true }).click();
    if (new URL(page.url()).origin !== "https://auth.afip.gob.ar") throw new ArcaBrowserError("ARCA_SESSION");
    await page.locator('input[type="password"]').fill(credential.password);
    await page.getByRole("button", { name: "Ingresar", exact: true }).click();
    await page.waitForURL("https://portalcf.cloud.afip.gob.ar/portal/app/**", { timeout: 30000 });
    await serviceSearch(page).first().waitFor({ timeout: 20000 });
    await verifySession(page);
    const heading = await page.locator("body").innerText();
    if (!heading.replace(/\D/g, "").includes(credential.cuit)) throw new ArcaBrowserError("ARCA_SESSION");
    return page;
}

async function openService(context: BrowserContext, portal: Page, name: string) {
    const service = portal.getByText(name, { exact: true }).filter({ visible: true }).first();
    if (!(await service.isVisible())) {
        await serviceSearch(portal).first().fill(name);
    }
    await service.waitFor();
    const [page] = await Promise.all([
        context.waitForEvent("page", { timeout: 20000 }),
        service.click(),
    ]);
    await page.waitForLoadState("domcontentloaded");
    await verifySession(page);
    return page;
}

// Sólo se elige una representación si ARCA ofrece el CUIT exacto. Cada
// servicio abre su propia sesión y puede pedir que se vuelva a seleccionarlo.
async function selectRepresentedClient(page: Page, task: ArcaDownloadTask, loginCuit: string) {
    if (task.cuit === loginCuit) return;
    const formatted = `${task.cuit.slice(0, 2)}-${task.cuit.slice(2, 10)}-${task.cuit.slice(10)}`;
    const exactCuit = new RegExp(`(?:^|[^0-9])(?:${task.cuit}|${formatted})(?:[^0-9]|$)`);
    if (new URL(page.url()).origin === "https://siapweb.cloud.afip.gob.ar") {
        // Portal IVA separa el usuario autenticado del CUIT representado.
        const active = page.getByText(
            new RegExp(`representando\\s+a\\s*:\\s*[^\\[]*\\[\\s*CUIT\\s*:?\\s*(?:${task.cuit}|${formatted})\\s*\\]`, "i"),
        ).filter({ visible: true });
        if (await active.count() === 1) return;
        const relation = page.locator('[href*="#/changeRelation"]:visible');
        await traceStep("portal-open-representation", () => relation.click());
        await traceStep("portal-wait-chooser", () => page.waitForURL((url) => url.hash.split("?")[0] === "#/changeRelation"));
        const target = page.getByText(
            new RegExp(`\\[\\s*CUIT\\s*:?\\s*(?:${task.cuit}|${formatted})\\s*\\]$`, "i"),
        ).filter({ visible: true });
        await traceStep("portal-find-company", () => target.first().waitFor());
        if (await target.count() !== 1) throw new ArcaBrowserError("REPRESENTATION_REQUIRED");
        await traceStep("portal-select-company", () => target.click());
        await traceStep("portal-wait-return", () => page.waitForURL((url) => url.origin === "https://siapweb.cloud.afip.gob.ar"
            && url.hash.split("?")[0] !== "#/changeRelation"));
        await traceStep("portal-confirm-company", () => active.waitFor());
        await verifySession(page);
        return;
    }
    const chooser = page.locator("select:visible").filter({ has: page.locator("option").filter({ hasText: exactCuit }) });
    const roleOption = page.getByRole("option", { name: exactCuit });
    const representation = page.getByRole("combobox", { name: /represent|contribuyente|cuit/i });
    const representedAction = page.getByText("Seleccionar representado", { exact: true });
    const accountMenu = page.locator("#e-navbar-dropdown-toggle");
    const representedRow = page.getByRole("radio", { name: exactCuit })
        .or(page.getByRole("button", { name: exactCuit }))
        .or(page.getByRole("link", { name: exactCuit }));
    const selection = page.getByRole("button", { name: /^(aceptar|continuar|confirmar|ingresar)$/i });
    try {
        await chooser.or(representation).or(roleOption).or(accountMenu).or(representedRow).first().waitFor({ timeout: 15000 });
        if (await accountMenu.isVisible()) {
            await accountMenu.click();
            await representedAction.click();
        }
        await chooser.or(representation).or(roleOption).or(representedRow).first().waitFor({ timeout: 15000 });
        if (await chooser.count() === 1) {
            const option = chooser.locator("option").filter({ hasText: exactCuit });
            if (await option.count() !== 1) throw new Error();
            const label = await option.textContent();
            if (!label) throw new Error();
            await chooser.selectOption({ label: label.trim() });
        } else if (await representedRow.count() === 1) {
            await representedRow.click();
        } else {
            if (await representation.count() === 1) await representation.click();
            await roleOption.click();
        }
        if (await selection.count() === 1 && await selection.isVisible()) await selection.click();
        await verifySession(page);
        // Una opción del listado no prueba quién quedó activo. Se requiere
        // que el servicio muestre el CUIT en su contexto fuera del selector.
        const active = page.locator("header, nav, [role=banner], h1, h2").filter({ hasText: exactCuit });
        await active.first().waitFor({ timeout: 15000 });
        const contexts = await active.evaluateAll((elements) => elements
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                const visible: string[] = [];
                while (walker.nextNode()) {
                    const parent = walker.currentNode.parentElement;
                    if (!parent?.getClientRects().length || getComputedStyle(parent).visibility !== "visible") continue;
                    if (parent.closest("select, [role=listbox], [role=option], [role=menu], [hidden], [aria-hidden=true]")) continue;
                    visible.push(walker.currentNode.textContent ?? "");
                }
                return visible.join(" ");
            }));
        if (!contexts.some((text) => exactCuit.test(text))) throw new Error();
    } catch (error) {
        if (error instanceof ArcaBrowserError) throw error;
        throw new ArcaBrowserError("REPRESENTATION_REQUIRED");
    }
}

async function exportedFile(context: BrowserContext, page: Page, click: () => Promise<unknown>) {
    // Algunos exportadores abren otra pestaña. Capturamos el archivo en ambas.
    let resolveDownload!: (download: Download) => void;
    const downloadPromise = new Promise<Download>((resolve) => { resolveDownload = resolve; });
    const onDownload = (download: Download) => resolveDownload(download);
    const onPage = (popup: Page) => popup.on("download", onDownload);
    page.on("download", onDownload);
    context.on("page", onPage);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await click();
        const download = await Promise.race([
            downloadPromise,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ArcaBrowserError("ARCA_TIMEOUT_EXPORT")), 45000); }),
        ]);
        if (await download.failure()) fail("ARCA_DOWNLOAD", "export-download");
        const path = await download.path();
        if (!path) fail("ARCA_DOWNLOAD", "export-download");
        const bytes = await readFile(path);
        if (!bytes.length || bytes.length > MAX_EXPORT_BYTES) fail("ARCA_FORMAT", "export-size");
        return bytes.toString("base64");
    } finally {
        if (timer) clearTimeout(timer);
        page.off("download", onDownload);
        context.off("page", onPage);
    }
}

/**
 * Exportaciones que ARCA abre en la pestaña en lugar de descargarlas («Exportar
 * a Texto» de la versión anterior de Mis Retenciones: text/plain sin
 * Content-Disposition, observado el 14/11/2026). Se pide la misma dirección
 * del enlace desde la página, con su sesión, y se toman los bytes tal como
 * llegan; sirve igual si ARCA la entrega como adjunto.
 */
async function linkedExport(page: Page, target: URL) {
    const result = await page.evaluate(async ({ url, limit }) => {
        try {
            const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(45000) });
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > limit) return { status: response.status, type: "", data: "", size: bytes.length };
            let binary = "";
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return { status: response.status, type: response.headers.get("content-type") ?? "", data: btoa(binary), size: bytes.length };
        } catch (error) {
            return { status: 0, type: error instanceof Error ? error.name : "", data: "", size: 0 };
        }
    }, { url: target.href, limit: MAX_EXPORT_BYTES });
    if (result.status === 0) {
        if (result.type === "TimeoutError") throw new ArcaBrowserError("ARCA_TIMEOUT_EXPORT");
        fail("ARCA_DOWNLOAD", "export-request");
    }
    if (result.status !== 200) fail("ARCA_DOWNLOAD", "export-status");
    if (!result.size || result.size > MAX_EXPORT_BYTES) fail("ARCA_FORMAT", "export-size");
    // Una sesión vencida responde con una página, no con el archivo.
    if (!/^text\/plain\b/i.test(result.type)) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await verifySession(page);
        fail("ARCA_DOWNLOAD", "export-content");
    }
    return result.data;
}

async function invoiceFiles(context: BrowserContext, portal: Page, task: ArcaDownloadTask, loginCuit: string): Promise<ArcaDownloadResult> {
    const page = await atStage("SERVICE", () => openService(context, portal, "Portal IVA"));
    await atStage("REPRESENTATION", () => selectRepresentedClient(page, task, loginCuit));
    await traceStep("portal-open-periods", () => page.getByRole("button", { name: /nueva\.declaracion\.alt|^ingresar$/i }).click());
    const period = `${String(task.month).padStart(2, "0")}/${task.year}`;
    await traceStep("portal-select-period", () => page.getByRole("combobox").selectOption({ label: period }));
    await traceStep("portal-validate-period", () => page.getByRole("button", { name: /validar\.periodo|^continuar$/i }).click());
    await traceStep("portal-open-ledger", () => page.getByRole("button", { name: /btn.home.liva|^libro iva digital$/i }).click());
    await traceStep("portal-wait-ledger", () => page.waitForURL((url) => url.origin === "https://liva.afip.gob.ar"));
    await page.getByRole("link", { name: task.source === "SALES" ? /Libro Ventas Registr/ : /Libro Compras Registr/ }).click();
    await verifySession(page);
    const text = await page.locator("body").innerText();
    if (!text.includes(period)) fail("ARCA_PERIOD", "portal-ledger-period");
    const file = await atStage("EXPORT", () => exportedFile(context, page, () => page.getByRole("button", { name: "CSV", exact: true }).click()));
    return { files: [{ file, format: "PORTAL_CSV" }], empty: false };
}

const VOUCHERS_ORIGIN = "https://fes.afip.gob.ar";

/**
 * Mis Comprobantes es sólo consulta: no abre ni modifica una declaración. Se
 * usa para las sociedades representadas, cuyo Portal IVA deriva a IVA Simple.
 */
async function selectVoucherTaxpayer(page: Page, task: ArcaDownloadTask, loginCuit: string) {
    const menu = page.locator('a[href="comprobantesEmitidos.do"]');
    const row = page.getByRole("link").filter({ hasText: dashedCuit(task.cuit) });
    await traceStep("vouchers-wait-chooser", () => menu.or(row).first().waitFor());
    if (!(await menu.isVisible())) {
        // La persona con la que se ingresó figura dos veces (actual y elegible).
        const options = await row.count();
        if (options < 1 || (task.cuit !== loginCuit && options !== 1)) fail("REPRESENTATION_REQUIRED", "vouchers-find-taxpayer");
        await traceStep("vouchers-select-taxpayer", () => row.last().click());
        await traceStep("vouchers-wait-menu", () => menu.waitFor());
    }
    await verifySession(page);
    if (task.cuit === loginCuit) return;
    const header = await page.locator("#usernav").innerText();
    const active = new RegExp(`representando\\s+a\\s*:[^\\[]*\\[\\s*${dashedCuit(task.cuit)}\\s*\\]`, "i");
    if (!active.test(header)) fail("REPRESENTATION_REQUIRED", "vouchers-confirm-taxpayer");
}

async function voucherFiles(context: BrowserContext, portal: Page, task: ArcaDownloadTask, loginCuit: string): Promise<ArcaDownloadResult> {
    const page = await atStage("SERVICE", () => openService(context, portal, "Mis Comprobantes"));
    if (new URL(page.url()).origin !== VOUCHERS_ORIGIN) fail("ARCA_PAGE", "vouchers-origin");
    await atStage("REPRESENTATION", () => selectVoucherTaxpayer(page, task, loginCuit));
    const sales = task.source === "SALES";
    await traceStep("vouchers-open-query", () => page.locator(`a[href="${sales ? "comprobantesEmitidos.do" : "comprobantesRecibidos.do"}"]`).click());
    const { start, end } = periodDates(task);
    const range = `${start} - ${end}`;
    const dates = page.locator("#fechaEmision");
    await traceStep("vouchers-fill-period", async () => {
        await dates.click();
        await dates.press("ControlOrMeta+A");
        await dates.pressSequentially(range);
        await dates.press("Enter");
    });
    if ((await dates.inputValue()).trim() !== range) fail("ARCA_PERIOD", "vouchers-period-field");
    await traceStep("vouchers-submit-query", () => page.locator("#buscarComprobantes").click());
    const results = page.locator("#tabResultados");
    const outcome = results.locator(".dataTables_info:visible, .dataTables_empty:visible");
    await traceStep("vouchers-wait-results", () => outcome.first().waitFor({ timeout: 45000 }));
    await verifySession(page);
    // ARCA informa el filtro que aplicó: se exige el período y el CUIT del cliente.
    const applied = (await results.locator(".panel").filter({ hasText: "Filtro Aplicado" }).first().innerText()).replace(/\s+/g, " ");
    if (!new RegExp(`${sales ? "Emisor" : "Receptor"}\\s*:\\s*${task.cuit}(?!\\d)`).test(applied)) fail("REPRESENTATION_REQUIRED", "vouchers-applied-taxpayer");
    if (!applied.includes(`Fecha del Comprobante: ${start} a ${end}`)) fail("ARCA_PERIOD", "vouchers-applied-period");
    if (await results.locator(".dataTables_empty:visible").count()) {
        console.warn("[arca-sync] empty step=vouchers-results");
        return { files: [], empty: true };
    }
    const file = await atStage("EXPORT", () => exportedFile(context, page,
        () => traceStep("vouchers-export", () => results.locator('button[title="Exportar como CSV"]').click())));
    return { files: [{ file, format: "MIS_COMPROBANTES" }], empty: false };
}

const LEGACY_TAX_ORIGIN = "https://seti.afip.gob.ar";
const isLegacyTaxPage = (url: URL) => url.origin === LEGACY_TAX_ORIGIN
    && url.pathname === "/misret/consultaMisRetenciones.do";

async function openLegacyTaxPage(context: BrowserContext, page: Page) {
    if (isLegacyTaxPage(new URL(page.url()))) return page;
    const isLegacyService = (url: URL) => url.origin === LEGACY_TAX_ORIGIN
        && url.pathname.startsWith("/misret/");
    const legacy = Promise.any([
        page.waitForURL(isLegacyService).then(() => page),
        context.waitForEvent("page").then(async (popup) => {
            await popup.waitForURL(isLegacyService);
            return popup;
        }),
    ]).catch((error: AggregateError) => {
        if (error.errors.every((cause) => cause instanceof Error && cause.name === "TimeoutError")) {
            throw new ArcaBrowserError("ARCA_TIMEOUT_SERVICE");
        }
        throw error;
    });
    const [result] = await Promise.all([
        legacy,
        page.getByText(/^(?:click|clic) aqu[ií]$/i).click(),
    ]);
    await verifySession(result);
    if (!isLegacyTaxPage(new URL(result.url()))) {
        await result.getByText("Impositivas", { exact: true }).click();
        await result.waitForURL(isLegacyTaxPage);
    }
    return result;
}

const LEGACY_TAX_FORM = `${LEGACY_TAX_ORIGIN}/misret/consultaMisRetenciones.do?method=getForm`;

/**
 * Versión anterior de Mis Retenciones. Los campos se ubican por su nombre en
 * el formulario: los rótulos traen espacios duros y el propio formulario
 * oculta los tipos que no corresponden al impuesto elegido (con 216 sólo deja
 * «Retención», ya marcada).
 */
async function legacyTaxFiles(context: BrowserContext, page: Page, task: ArcaDownloadTask): Promise<ArcaDownloadResult> {
    const { start, end } = periodDates(task);
    const startField = start.replaceAll("/", "");
    const endField = end.replaceAll("/", "");
    const kind = task.source === "RETENTIONS" ? "Retencion" : "Percepcion";
    const codes = task.source === "RETENTIONS" ? ["216", "767"] : ["767"];
    const files: ArcaFile[] = [];

    for (const [index, code] of codes.entries()) {
        // Cada consulta parte del formulario limpio, sin depender del historial.
        if (index) await traceStep("tax-reopen-form", () => page.goto(LEGACY_TAX_FORM, { waitUntil: "domcontentloaded" }));
        await verifySession(page);
        const form = page.locator('form[name="formulario"]');
        await atStage("REPRESENTATION", async () => {
            const cuit = form.locator('select[name="cuitRetenido"]');
            await traceStep("tax-wait-form", () => cuit.waitFor());
            const target = cuit.locator("option").filter({ hasText: new RegExp(`^\\s*(?:${task.cuit}|${dashedCuit(task.cuit)})\\s*$`) });
            if (await target.count() !== 1) fail("REPRESENTATION_REQUIRED", "tax-find-taxpayer");
            const value = await target.getAttribute("value");
            if (!value) fail("REPRESENTATION_REQUIRED", "tax-find-taxpayer");
            await traceStep("tax-select-taxpayer", () => cuit.selectOption({ value }));
            if (await cuit.inputValue() !== value) fail("REPRESENTATION_REQUIRED", "tax-confirm-taxpayer");
        });
        const tax = form.locator("select#impuestos");
        const option = tax.locator("option").filter({ hasText: new RegExp(`^\\s*${code}\\s*[-–—]`) });
        if (await option.count() !== 1) fail("ARCA_PAGE", "tax-find-code");
        const value = await option.getAttribute("value");
        if (!value) fail("ARCA_PAGE", "tax-find-code");
        await traceStep("tax-select-code", () => tax.selectOption({ value }));

        const radio = form.locator(`input[type="radio"][name="retencionPercepcion"][value="${kind}"]`);
        if (await radio.count() !== 1) fail("ARCA_PAGE", "tax-kind-fields");
        if (await radio.isVisible()) await traceStep("tax-select-kind", () => radio.check());
        // Oculto y sin marcar: el impuesto no admite ese tipo de consulta.
        if (!(await radio.isChecked())) fail("ARCA_PAGE", "tax-kind-unavailable");

        const from = form.locator('input[name="fechaRetencionDesde"]');
        const to = form.locator('input[name="fechaRetencionHasta"]');
        if (await from.count() !== 1 || await to.count() !== 1) fail("ARCA_PAGE", "tax-date-fields");
        await traceStep("tax-fill-start", () => from.fill(startField));
        await traceStep("tax-fill-end", () => to.fill(endField));
        if (await from.inputValue() !== startField || await to.inputValue() !== endField) fail("ARCA_PERIOD", "tax-period-fields");

        // La respuesta llega por POST a la misma dirección, sin parámetros.
        await traceStep("tax-submit-query", () => Promise.all([
            page.waitForURL((url) => isLegacyTaxPage(url) && url.search === "", { waitUntil: "domcontentloaded" }),
            form.locator('input[type="submit"]').click(),
        ]));
        await verifySession(page);

        const result = (await page.locator("body").innerText()).replace(/\s+/g, " ");
        // Sin datos, ARCA no muestra el encabezado de la consulta.
        if (/no se han encontrado datos para esta consulta/i.test(result)) {
            console.warn(`[arca-sync] empty step=tax-results tax=${code}`);
            continue;
        }
        if (!new RegExp(`CUIT del Retenido\\s*:\\s*${task.cuit}(?!\\d)`, "i").test(result)) fail("REPRESENTATION_REQUIRED", "tax-result-taxpayer");
        if (!new RegExp(`Fecha desde de la ret\\./perc\\.\\s*:\\s*${start}(?!\\d)`, "i").test(result)
            || !new RegExp(`Fecha hasta de la ret\\./perc\\.\\s*:\\s*${end}(?!\\d)`, "i").test(result)) fail("ARCA_PERIOD", "tax-result-period");
        if (!new RegExp(`Impuesto retenido\\s*:\\s*${code}\\s*-`, "i").test(result)) fail("ARCA_PAGE", "tax-result-code");

        const exportLink = page.getByRole("link", { name: "Exportar a Texto", exact: true });
        if (await exportLink.count() !== 1) fail("ARCA_PAGE", "tax-export-link");
        // La dirección del enlace repite la consulta: se comprueba antes de pedirla.
        const reference = /'([^']*consultaMisRetenciones\.do\?[^']*)'/.exec(await exportLink.getAttribute("href") ?? "")?.[1];
        if (!reference) fail("ARCA_PAGE", "tax-export-link");
        const target = new URL(reference, page.url());
        const query = target.searchParams;
        if (!isLegacyTaxPage(target) || query.get("method") !== "exportTexto") fail("ARCA_PAGE", "tax-export-link");
        if (query.get("cuitRetenido") !== task.cuit) fail("REPRESENTATION_REQUIRED", "tax-export-taxpayer");
        if (query.get("fechaRetencionDesde") !== startField || query.get("fechaRetencionHasta") !== endField) fail("ARCA_PERIOD", "tax-export-period");
        if (query.get("impuesto") !== code || query.get("retencionPercepcion") !== kind) fail("ARCA_PAGE", "tax-export-query");
        const file = await atStage("EXPORT", () => traceStep("tax-export", () => linkedExport(page, target)));
        files.push({ file });
    }
    return { files, empty: files.length === 0 };
}

async function taxFiles(context: BrowserContext, portal: Page, task: ArcaDownloadTask, loginCuit: string): Promise<ArcaDownloadResult> {
    const page = await atStage("SERVICE", () => openService(context, portal, "Mis Retenciones"));
    if (task.cuit !== loginCuit || isLegacyTaxPage(new URL(page.url()))) {
        const legacy = await atStage("SERVICE", () => openLegacyTaxPage(context, page));
        return legacyTaxFiles(context, legacy, task);
    }
    const files: ArcaFile[] = [];
    const codes = task.source === "RETENTIONS" ? ["216", "767"] : ["767"];
    for (const [index, code] of codes.entries()) {
        if (index) await page.getByRole("button", { name: "Volver a Consultar", exact: true }).click();
        await page.getByRole("combobox", { name: "Impuesto *" }).click();
        await page.getByRole("group", { name: "Impositivas", exact: true })
            .getByRole("option", { name: new RegExp(`^${code} -`) }).click();
        await page.getByRole("radio", { name: task.source === "RETENTIONS" ? "Retención" : "Percepción", exact: true }).check();
        const dates = page.getByPlaceholder("dd/mm/aaaa");
        const month = String(task.month).padStart(2, "0");
        const last = new Date(Date.UTC(task.year, task.month, 0)).getUTCDate();
        await dates.nth(0).fill("");
        await dates.nth(0).pressSequentially(`01${month}${task.year}`);
        await dates.nth(1).fill("");
        await dates.nth(1).pressSequentially(`${last}${month}${task.year}`);
        await dates.nth(1).press("Tab");
        await page.getByRole("button", { name: "Consultar", exact: true }).click();
        await page.getByText("Resultados de la consulta", { exact: true }).waitFor();
        const noResults = page.getByRole("heading", { name: "No hay resultados para tu consulta", exact: true });
        const exportButton = page.getByRole("button", { name: /Exportar/ }).first();
        await noResults.or(exportButton).first().waitFor({ timeout: 30000 });
        await verifySession(page);
        if (await noResults.isVisible()) continue;
        // Elegimos el formato de aplicativo, que conserva certificado y régimen.
        const file = await atStage("EXPORT", () => exportedFile(context, page, async () => {
            await exportButton.click();
            const application = page.getByText(/Exportar para Aplicativo|IVA SIMPLE/i).last();
            if (await application.isVisible()) await application.click();
        }));
        files.push({ file });
    }
    return { files, empty: files.length === 0 };
}

export interface ArcaDownloadOptions {
    executablePath?: string;
    /** Sólo pruebas: permite interceptar la red del contexto antes de navegar. */
    prepareContext?: (context: BrowserContext) => Promise<unknown>;
}

export async function downloadArca(task: ArcaDownloadTask, options: ArcaDownloadOptions = {}): Promise<ArcaDownloadResult> {
    const credential = credentialFor(task);
    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({
            executablePath: options.executablePath ?? await lambdaChromium.executablePath(),
            args: options.executablePath ? [] : ["--disable-dev-shm-usage", "--no-zygote"],
            headless: true,
        });
        // Reautenticación limitada a un intento por fuente, siempre en contexto nuevo.
        for (let attempt = 0; attempt < 2; attempt++) {
            const context = await browser.newContext({ acceptDownloads: true, locale: "es-AR" });
            context.setDefaultTimeout(options.prepareContext ? 4000 : 20000);
            await options.prepareContext?.(context);
            try {
                const portal = await atStage("LOGIN", () => login(context, credential));
                return await atStage("QUERY", () => task.source === "SALES" || task.source === "PURCHASES"
                    // Portal IVA de una representada puede derivar a IVA Simple, que
                    // abre una declaración: sus comprobantes se consultan en Mis Comprobantes.
                    ? (task.cuit === credential.cuit ? invoiceFiles(context, portal, task, credential.cuit) : voucherFiles(context, portal, task, credential.cuit))
                    : taxFiles(context, portal, task, credential.cuit));
            } catch (error) {
                let cause = error;
                if (!(cause instanceof ArcaBrowserError) || cause.code.startsWith("ARCA_TIMEOUT_")) {
                    for (const page of context.pages()) {
                        try {
                            await verifySession(page);
                        } catch (sessionError) {
                            if (sessionError instanceof ArcaBrowserError) cause = sessionError;
                        }
                    }
                }
                if (attempt === 0 && cause instanceof ArcaBrowserError && cause.code === "ARCA_SESSION") continue;
                throw cause;
            } finally {
                await context.close();
            }
        }
        throw new ArcaBrowserError("ARCA_SESSION");
    } finally {
        await browser?.close();
    }
}
