import { chromium, type Browser, type BrowserContext, type Page, type Download } from "playwright-core";
import lambdaChromium from "@sparticuz/chromium";
import { readFile } from "node:fs/promises";
import { credentialKey, openCredential } from "./credential-crypto";
import { syncCredentials } from "./auth";

export type ArcaTimeoutStage = "LOGIN" | "SERVICE" | "REPRESENTATION" | "QUERY" | "EXPORT";

export class ArcaBrowserError extends Error {
    constructor(readonly code: "ARCA_SESSION" | "ARCA_DOWNLOAD" | "ARCA_FORMAT" | "CREDENTIALS_MISSING" | "VERIFICATION_REQUIRED" | "REPRESENTATION_REQUIRED" | `ARCA_TIMEOUT_${ArcaTimeoutStage}`) {
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
type ArcaFile = { file: string; format?: "PORTAL_CSV" };
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
            new RegExp(`^representando\\s+a\\s*:\\s*.*?\\[\\s*CUIT\\s*:?\\s*(?:${task.cuit}|${formatted})\\s*\\]$`, "i"),
        ).filter({ visible: true });
        if (await active.count() === 1) return;
        const relation = page.locator('[href*="#/changeRelation"]:visible');
        await relation.click();
        await page.waitForURL((url) => url.hash.split("?")[0] === "#/changeRelation");
        const target = page.getByText(
            new RegExp(`\\[\\s*CUIT\\s*:?\\s*(?:${task.cuit}|${formatted})\\s*\\]$`, "i"),
        ).filter({ visible: true });
        await target.first().waitFor();
        if (await target.count() !== 1) throw new ArcaBrowserError("REPRESENTATION_REQUIRED");
        await target.click();
        await page.waitForURL((url) => url.origin === "https://siapweb.cloud.afip.gob.ar"
            && url.hash.split("?")[0] !== "#/changeRelation");
        await active.waitFor();
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
        const failure = await download.failure();
        if (failure) throw new ArcaBrowserError("ARCA_DOWNLOAD");
        const path = await download.path();
        if (!path) throw new ArcaBrowserError("ARCA_DOWNLOAD");
        const bytes = await readFile(path);
        if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new ArcaBrowserError("ARCA_FORMAT");
        return bytes.toString("base64");
    } finally {
        if (timer) clearTimeout(timer);
        page.off("download", onDownload);
        context.off("page", onPage);
    }
}

async function invoiceFiles(context: BrowserContext, portal: Page, task: ArcaDownloadTask, loginCuit: string): Promise<ArcaDownloadResult> {
    const page = await atStage("SERVICE", () => openService(context, portal, "Portal IVA"));
    await atStage("REPRESENTATION", () => selectRepresentedClient(page, task, loginCuit));
    await page.getByRole("button", { name: /nueva.declaracion.alt/ }).click();
    const period = `${String(task.month).padStart(2, "0")}/${task.year}`;
    await page.getByRole("combobox").selectOption({ label: period });
    await page.getByRole("button", { name: /validar.periodo/ }).click();
    await page.getByRole("button", { name: /btn.home.liva/ }).click();
    await page.waitForURL(/liva\.afip\.gob\.ar/);
    await page.getByRole("link", { name: task.source === "SALES" ? /Libro Ventas Registr/ : /Libro Compras Registr/ }).click();
    await verifySession(page);
    const text = await page.locator("body").innerText();
    if (!text.includes(period)) throw new ArcaBrowserError("ARCA_FORMAT");
    const file = await atStage("EXPORT", () => exportedFile(context, page, () => page.getByRole("button", { name: "CSV", exact: true }).click()));
    return { files: [{ file, format: "PORTAL_CSV" }], empty: false };
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

async function legacyTaxFiles(context: BrowserContext, page: Page, task: ArcaDownloadTask): Promise<ArcaDownloadResult> {
    const month = String(task.month).padStart(2, "0");
    const last = new Date(Date.UTC(task.year, task.month, 0)).getUTCDate();
    const startDate = `01/${month}/${task.year}`;
    const endDate = `${last}/${month}/${task.year}`;
    const codes = task.source === "RETENTIONS" ? ["216", "767"] : ["767"];
    const files: ArcaFile[] = [];

    for (const [index, code] of codes.entries()) {
        if (index) await page.goBack({ waitUntil: "domcontentloaded" });
        const row = (label: RegExp) => page.getByText(label, { exact: true }).locator("xpath=ancestor::tr[1]");
        await atStage("REPRESENTATION", async () => {
            const formatted = `${task.cuit.slice(0, 2)}-${task.cuit.slice(2, 10)}-${task.cuit.slice(10)}`;
            const option = page.locator("option").filter({
                hasText: new RegExp(`^\\s*(?:${task.cuit}|${formatted})\\s*$`),
            });
            const cuit = page.locator("select:visible").filter({ has: option });
            await cuit.waitFor();
            const target = cuit.locator("option").and(option);
            if (await target.count() !== 1) throw new ArcaBrowserError("REPRESENTATION_REQUIRED");
            const label = await target.textContent();
            if (!label) throw new ArcaBrowserError("REPRESENTATION_REQUIRED");
            await cuit.selectOption({ label: label.trim() });
        });
        const tax = row(/^Impuesto retenido\s*:?$/i).locator("select");
        const taxOption = tax.locator("option").filter({ hasText: new RegExp(`^\\s*${code}\\s*-`) });
        const taxLabel = (await taxOption.textContent())?.trim();
        if (!taxLabel) throw new ArcaBrowserError("ARCA_FORMAT");
        await tax.selectOption({ label: taxLabel });

        const kind = task.source === "RETENTIONS" ? "Retención" : "Percepción";
        const radio = row(new RegExp(`^${kind}\\s*:?$`, "i")).getByRole("radio");
        const labelled = page.getByRole("radio", { name: kind, exact: true });
        if (await labelled.count() === 1) {
            await labelled.check();
        } else {
            // El formulario anterior presenta los tres radios en orden fijo.
            if (await radio.count() !== 3) throw new ArcaBrowserError("ARCA_FORMAT");
            await radio.nth(task.source === "RETENTIONS" ? 0 : 1).check();
        }
        const dates = row(/^Fecha Ret\.\/Perc\.\s*:?$/i).locator('input[type="text"]:visible');
        if (await dates.count() !== 2) throw new ArcaBrowserError("ARCA_FORMAT");
        await dates.nth(0).fill(startDate.replaceAll("/", ""));
        await dates.nth(1).fill(endDate.replaceAll("/", ""));
        await page.getByRole("button", { name: "CONSULTAR", exact: true }).click();
        await verifySession(page);
        if (!isLegacyTaxPage(new URL(page.url()))) throw new ArcaBrowserError("ARCA_FORMAT");

        const result = await page.locator("body").innerText();
        const expectedCuit = new RegExp(`CUIT del Retenido\\s*:\\s*${task.cuit}(?!\\d)`, "i");
        if (!expectedCuit.test(result)) throw new ArcaBrowserError("REPRESENTATION_REQUIRED");
        if (!result.includes(startDate) || !result.includes(endDate) || !new RegExp(`Impuesto retenido\\s*:\\s*${code}\\s*-`, "i").test(result)) {
            throw new ArcaBrowserError("ARCA_FORMAT");
        }

        const exportLink = page.getByText("Exportar a Texto", { exact: true });
        if (!(await exportLink.isVisible()) && /no (?:se encontraron|hay|existen) (?:resultados|registros|datos)/i.test(result)) continue;
        const file = await atStage("EXPORT", () => exportedFile(context, page, () => exportLink.click()));
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

export async function downloadArca(task: ArcaDownloadTask, options: { executablePath?: string } = {}): Promise<ArcaDownloadResult> {
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
            context.setDefaultTimeout(20000);
            try {
                const portal = await atStage("LOGIN", () => login(context, credential));
                return await atStage("QUERY", () => task.source === "SALES" || task.source === "PURCHASES"
                    ? invoiceFiles(context, portal, task, credential.cuit)
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
