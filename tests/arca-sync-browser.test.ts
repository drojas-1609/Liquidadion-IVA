import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { downloadArca, ArcaBrowserError, type ArcaDownloadTask } from "@/lib/arca-sync/browser";
import { sealCredential } from "@/lib/arca-sync/credential-crypto";
import { fakeArca, syntheticTaxText, type FakeArcaOptions } from "./_fixtures/fake-arca";

/**
 * Recorrido del conector contra un ARCA simulado (tests/_fixtures/fake-arca.ts).
 * Necesita un Chromium ejecutable: ARCA_TEST_CHROMIUM o, en Linux, el de
 * @sparticuz/chromium (el mismo que usa la función). Si no hay, se omite.
 */
const ADMIN = "20111111112";
const COMPANY = "30222222223";
const KEY = "ab".repeat(32);
const scope = { clientId: "client", organizationId: "org", targetCuit: COMPANY };

let executablePath: string | undefined;
beforeAll(async () => {
    if (process.env.ARCA_TEST_CHROMIUM) executablePath = process.env.ARCA_TEST_CHROMIUM;
    else if (process.platform === "linux") {
        const chromium = (await import("@sparticuz/chromium")).default;
        executablePath = await chromium.executablePath();
    }
    if (executablePath && !existsSync(executablePath)) executablePath = undefined;
    vi.stubEnv("ARCA_CLIENT_CREDENTIAL_KEY", KEY);
}, 60_000);
afterAll(() => vi.unstubAllEnvs());

const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
afterEach(() => warn.mockClear());
const steps = () => warn.mock.calls.map((call) => String(call[0]));

function task(source: ArcaDownloadTask["source"]): ArcaDownloadTask {
    const envelope = sealCredential({ cuit: ADMIN, password: "clave-de-prueba" }, scope, Buffer.from(KEY, "hex"));
    return { cuit: COMPANY, clientId: "client", organizationId: "org", storedCredential: { targetCuit: COMPANY, envelope }, year: 2026, month: 10, source };
}

function arca(extra: Partial<FakeArcaOptions> = {}) {
    return fakeArca({ loginCuit: ADMIN, loginName: "ADMINISTRADOR DE PRUEBA", represented: [{ cuit: COMPANY, name: "SOCIEDAD DE PRUEBA S. A. S." }], ...extra });
}

async function run(source: ArcaDownloadTask["source"], fake: ReturnType<typeof fakeArca>) {
    return downloadArca(task(source), { executablePath, prepareContext: fake.install });
}

const failure = async (promise: Promise<unknown>) => promise.then(() => "sin error", (error) => error instanceof ArcaBrowserError ? error.code : `otro: ${String(error)}`);
const perception = { agent: "30333333334", tax: "767", regime: "493", date: "15/10/2026", certificate: "497700", operation: "PERCEPCION", amount: "103,10", number: "507343663" };
const retention = { ...perception, tax: "216", regime: "831", operation: "RETENCION", certificate: "000012345678", amount: "1.250,00" };

describe.skipIf(process.platform !== "linux" && !process.env.ARCA_TEST_CHROMIUM)("conector de ARCA contra pantallas simuladas", { timeout: 90_000 }, () => {
    describe("Mis Retenciones, versión anterior, de una sociedad representada", () => {
        it("percepciones: completa el formulario y toma el texto que se abre en la pestaña", async () => {
            const text = syntheticTaxText([perception]);
            const fake = arca({ taxExports: { "767:Percepcion": text } });
            const result = await run("PERCEPTIONS", fake);
            expect(result.empty).toBe(false);
            expect(result.files).toHaveLength(1);
            expect(Buffer.from(result.files[0].file, "base64").equals(Buffer.from(text))).toBe(true);
            expect(fake.log.taxQueries).toEqual([expect.objectContaining({
                cuitRetenido: COMPANY, impuesto: "767", retencionPercepcion: "Percepcion", fechaRetencionDesde: "01102026", fechaRetencionHasta: "31102026",
            })]);
        });

        it("retenciones: acepta que el impuesto 216 deje visible un solo tipo y consulta también el 767", async () => {
            const text = syntheticTaxText([retention]);
            const fake = arca({ taxExports: { "216:Retencion": text } });
            const result = await run("RETENTIONS", fake);
            expect(result.files).toHaveLength(1);
            expect(Buffer.from(result.files[0].file, "base64").equals(Buffer.from(text))).toBe(true);
            expect(fake.log.taxQueries.map((q) => `${q.impuesto}:${q.retencionPercepcion}`)).toEqual(["216:Retencion", "767:Retencion"]);
        });

        it("sin datos en ningún impuesto: informa vacío, no un error de representación", async () => {
            const result = await run("RETENTIONS", arca());
            expect(result).toEqual({ files: [], empty: true });
        });

        it("también acepta la exportación cuando llega como descarga", async () => {
            const text = syntheticTaxText([perception]);
            const result = await run("PERCEPTIONS", arca({ taxExports: { "767:Percepcion": text }, taxExportMode: "download" }));
            expect(Buffer.from(result.files[0].file, "base64").equals(Buffer.from(text))).toBe(true);
        });

        it("no acepta un resultado de otro contribuyente", async () => {
            const fake = arca({ taxExports: { "767:Percepcion": syntheticTaxText([perception]) }, activeOverride: ADMIN });
            expect(await failure(run("PERCEPTIONS", fake))).toBe("REPRESENTATION_REQUIRED");
            expect(steps()).toContain("[arca-sync] fail step=tax-result-taxpayer code=REPRESENTATION_REQUIRED");
            expect(fake.log.taxExports).toEqual([]);
        });

        it("sesión vencida: lo informa como sesión, no como formato", async () => {
            expect(await failure(run("PERCEPTIONS", arca({ legacySessionExpired: true })))).toBe("ARCA_SESSION");
        });
    });

    describe("Mis Comprobantes de una sociedad representada", () => {
        const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

        it("ventas: elige la sociedad, consulta el mes y entrega el archivo de emitidos", async () => {
            const fake = arca({ vouchers: { emitidos: zip } });
            const result = await run("SALES", fake);
            expect(result.empty).toBe(false);
            expect(result.files).toEqual([{ file: Buffer.from(zip).toString("base64"), format: "MIS_COMPROBANTES" }]);
            expect(fake.log.voucherQueries).toEqual([{ kind: "emitidos", range: "01/10/2026 - 31/10/2026", cuit: COMPANY }]);
        });

        it("compras: consulta los recibidos; sin comprobantes informa vacío", async () => {
            const fake = arca();
            expect(await run("PURCHASES", fake)).toEqual({ files: [], empty: true });
            expect(fake.log.voucherQueries).toEqual([{ kind: "recibidos", range: "01/10/2026 - 31/10/2026", cuit: COMPANY }]);
        });

        it("no consulta si ARCA muestra activa a otra persona", async () => {
            const fake = arca({ vouchers: { emitidos: zip }, activeOverride: ADMIN });
            expect(await failure(run("SALES", fake))).toBe("REPRESENTATION_REQUIRED");
            expect(steps()).toContain("[arca-sync] fail step=vouchers-confirm-taxpayer code=REPRESENTATION_REQUIRED");
            expect(fake.log.voucherQueries).toEqual([]);
        });

        it("no descarga si ARCA aplicó otro período", async () => {
            const fake = arca({ vouchers: { emitidos: zip }, appliedRangeOverride: "01/09/2026 - 30/09/2026" });
            expect(await failure(run("SALES", fake))).toBe("ARCA_PERIOD");
            expect(steps()).toContain("[arca-sync] fail step=vouchers-applied-period code=ARCA_PERIOD");
        });

        it("los registros no llevan CUIT, direcciones ni datos del archivo", async () => {
            await run("SALES", arca({ vouchers: { emitidos: zip } }));
            await failure(run("PERCEPTIONS", arca({ taxExports: { "767:Percepcion": syntheticTaxText([perception]) }, activeOverride: ADMIN })));
            for (const line of steps()) expect(line).not.toMatch(/\d{11}|https?:|\?|=.*=.*=/);
        });
    });
});
