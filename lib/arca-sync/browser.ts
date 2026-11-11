import { chromium, type Browser, type BrowserContext, type Page, type Download } from "playwright-core";
import lambdaChromium from "@sparticuz/chromium";
import { readFile } from "node:fs/promises";
import { syncCredentials } from "./auth";

export class ArcaBrowserError extends Error {
    constructor(readonly code: "ARCA_SESSION" | "ARCA_DOWNLOAD" | "ARCA_FORMAT" | "CREDENTIALS_MISSING" | "VERIFICATION_REQUIRED") {
        super(code);
        this.name = "ArcaBrowserError";
    }
}

export interface ArcaDownloadTask {
    cuit: string;
    year: number;
    month: number;
    source: "SALES" | "PURCHASES" | "RETENTIONS" | "PERCEPTIONS";
}

type Credential = { cuit: string; password: string };
type ArcaFile = { file: string; format?: "PORTAL_CSV" };
export type ArcaDownloadResult = { files: ArcaFile[]; empty: boolean };

function credentialFor(cuit: string): Credential {
    const credential = syncCredentials(cuit);
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

async function login(context: BrowserContext, credential: Credential) {
    const page = await context.newPage();
    await page.goto("https://auth.afip.gob.ar/contribuyente_/login.xhtml", { waitUntil: "domcontentloaded" });
    await page.getByRole("spinbutton").fill(credential.cuit);
    await page.getByRole("button", { name: "Siguiente", exact: true }).click();
    if (new URL(page.url()).origin !== "https://auth.afip.gob.ar") throw new ArcaBrowserError("ARCA_SESSION");
    await page.locator('input[type="password"]').fill(credential.password);
    await page.getByRole("button", { name: "Ingresar", exact: true }).click();
    await page.waitForURL("https://portalcf.cloud.afip.gob.ar/portal/app/**", { timeout: 30000 });
    await page.getByText("Portal IVA", { exact: true }).first().waitFor({ timeout: 20000 });
    await verifySession(page);
    const heading = await page.locator("body").innerText();
    if (!heading.replace(/\D/g, "").includes(credential.cuit)) throw new ArcaBrowserError("ARCA_SESSION");
    return page;
}

async function openService(context: BrowserContext, portal: Page, name: string) {
    const [page] = await Promise.all([
        context.waitForEvent("page", { timeout: 20000 }),
        portal.getByText(name, { exact: true }).first().click(),
    ]);
    await page.waitForLoadState("domcontentloaded");
    await verifySession(page);
    return page;
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
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ArcaBrowserError("ARCA_DOWNLOAD")), 45000); }),
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

async function invoiceFiles(context: BrowserContext, portal: Page, task: ArcaDownloadTask): Promise<ArcaDownloadResult> {
    const page = await openService(context, portal, "Portal IVA");
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
    const file = await exportedFile(context, page, () => page.getByRole("button", { name: "CSV", exact: true }).click());
    return { files: [{ file, format: "PORTAL_CSV" }], empty: false };
}

async function taxFiles(context: BrowserContext, portal: Page, task: ArcaDownloadTask): Promise<ArcaDownloadResult> {
    const page = await openService(context, portal, "Mis Retenciones");
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
        const file = await exportedFile(context, page, async () => {
            await exportButton.click();
            const application = page.getByText(/Exportar para Aplicativo|IVA SIMPLE/i).last();
            if (await application.isVisible()) await application.click();
        });
        files.push({ file });
    }
    return { files, empty: files.length === 0 };
}

export async function downloadArca(task: ArcaDownloadTask, options: { executablePath?: string } = {}): Promise<ArcaDownloadResult> {
    const credential = credentialFor(task.cuit);
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
                const portal = await login(context, credential);
                return task.source === "SALES" || task.source === "PURCHASES"
                    ? await invoiceFiles(context, portal, task)
                    : await taxFiles(context, portal, task);
            } catch (error) {
                let cause = error;
                if (!(cause instanceof ArcaBrowserError)) {
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
