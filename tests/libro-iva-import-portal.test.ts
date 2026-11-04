import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { parsePortalDownload, extractSingleCsv, PORTAL_HEADERS } from "@/lib/libro-iva-import/portal-csv";
import { buildImportPreview, type PreviewContext } from "@/lib/libro-iva-import/build";
import { parseLidFile } from "@/lib/libro-iva-import/format";
import { parseImportRequest } from "@/lib/libro-iva-import/request";
import { ansiFile, cuit, portalCsv, zipOne, salesAliquotLine, salesVoucherLine, type SynthPortalRow } from "./helpers/libro-iva-synth";

// Datos SINTÉTICOS con la forma de la descarga «comprobantes del período» de Portal IVA.
const BUYER = cuit("2070000003"), SELLER = cuit("3071111111");
const ctx = (category: "SALES" | "PURCHASES", over: Partial<PreviewContext> = {}): PreviewContext => ({
    category, period: { month: 10, year: 2026 }, settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: false },
    existingKeys: new Set(), source: "PORTAL_CSV", ...over,
});
const sale = (over: Partial<SynthPortalRow> = {}): SynthPortalRow => ({
    date: "2026-10-05", code: 1, pos: 5, number: 35, doc: BUYER, name: "CLIENTE SINTETICO SA", total: "1210.00", rates: { "21": ["1000.00", "210.00"] }, ...over,
});
const purchase = (over: Partial<SynthPortalRow> = {}): SynthPortalRow => ({
    date: "2026-10-03", code: 1, pos: 1, number: 900, doc: SELLER, name: "PROVEEDOR SINTETICO SRL", total: "1210.00", computableCredit: "210.00", rates: { "21": ["1000.00", "210.00"] }, ...over,
});
function preview(category: "SALES" | "PURCHASES", bytes: Uint8Array, c = ctx(category)) {
    const p = parsePortalDownload(bytes, category);
    return buildImportPreview(c, p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.totalColumnNotes });
}
const m = (d: Prisma.Decimal) => d.toFixed(2);

describe("descarga de Portal IVA: lectura", () => {
    it("el generador sintético usa el mismo encabezado que el lector (copiado de forma independiente)", () => {
        const text = new TextDecoder("windows-1252").decode(portalCsv("SALES", []));
        expect(text.trim().split(";").map((x) => x.replace(/"/g, ""))).toEqual(PORTAL_HEADERS.SALES);
    });
    it("venta A 21 %: OK con el modelo del TXT", () => {
        const p = preview("SALES", portalCsv("SALES", [sale()]));
        expect(p.fileErrors).toEqual([]);
        expect(p.rows.map((r) => r.status)).toEqual(["OK"]);
        expect([m(p.reconciliation.importable.CONSOLIDATED.taxedNet), m(p.reconciliation.importable.CONSOLIDATED.vat)]).toEqual(["1000.00", "210.00"]);
        expect(p.rows[0].model?.vatLines.map((l) => [l.vatRateCode, m(l.netAmount), m(l.vatAmount)])).toEqual([[5, "1000.00", "210.00"]]);
    });
    it("notas de crédito: ya vienen negativas; el signo contable no se invierte dos veces", () => {
        const p = preview("SALES", portalCsv("SALES", [sale(), sale({ code: 3, number: 2, total: "-121.00", rates: { "21": ["-100.00", "-21.00"] } })]));
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "OK"]);
        expect(m(p.rows[1].model!.totalVatAmount)).toBe("21.00");
        expect(m(p.reconciliation.importable.CONSOLIDATED.vat)).toBe("189.00");
        expect(m(p.reconciliation.signBridge.signedTotal)).toBe("1089.00");
    });
    it("signo incoherente: NC en positivo o factura en negativo quedan para revisión", () => {
        const p = preview("SALES", portalCsv("SALES", [sale({ code: 3, number: 2, total: "121.00", rates: { "21": ["100.00", "21.00"] } }), sale({ number: 3, total: "-1210.00", rates: { "21": ["-1000.00", "-210.00"] } })]));
        expect(p.rows.map((r) => r.status)).toEqual(["REVIEW", "REVIEW"]);
        expect(p.rows[0].messages.join(" ")).toMatch(/se esperan negativos/);
        expect(p.rows[1].messages.join(" ")).toMatch(/no es nota de crédito/);
    });
    it("FC A sólo exenta y su NC exenta: sin alícuotas, OK con nota de código de operación", () => {
        const p = preview("SALES", portalCsv("SALES", [sale({ number: 40, total: "500.00", exempt: "500.00", rates: undefined }), sale({ code: 3, number: 41, total: "-500.00", exempt: "-500.00", rates: undefined })]));
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "OK"]);
        expect(p.rows[0].notes.join(" ")).toMatch(/no informa el código de operación/);
        expect(m(p.reconciliation.importable.CONSOLIDATED.exempt)).toBe("0.00");
    });
    it("compra B con columnas en cero: sin discriminar, sin crédito; compra con 21 % y 10,5 %", () => {
        const zeros = { "0": ["0", "0"], "21": ["0", "0"] } as Record<string, [string, string]>;
        const p = preview("PURCHASES", portalCsv("PURCHASES", [
            purchase({ code: 6, number: 10, total: "300.00", computableCredit: "0", rates: zeros }),
            purchase({ number: 11, total: "2315.00", computableCredit: "315.00", rates: { "21": ["1000.00", "210.00"], "10,5": ["1000.00", "105.00"] } }),
        ]));
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "OK"]);
        expect([m(p.rows[0].model!.netWithoutVatBreakdownAmount), p.rows[0].model!.vatLines.length]).toEqual(["300.00", 0]);
        expect(p.rows[1].model!.vatLines.map((l) => l.vatRateCode).sort()).toEqual([4, 5]);
        expect(m(p.reconciliation.importable.CONSOLIDATED.computableCredit)).toBe("315.00");
    });
    it("«Total IVA» de la descarga distinto de la suma por alícuota: se usa la suma y se informa", () => {
        const p = preview("SALES", portalCsv("SALES", [sale({ totalVat: "210.03" })]));
        expect(p.rows[0].status).toBe("OK");
        expect(p.rows[0].notes[0]).toMatch(/Total IVA.*210\.03.*210\.00/);
        expect(m(p.rows[0].model!.totalVatAmount)).toBe("210.00");
    });
    it("datos faltantes: denominación vacía, TurIVA y 0 % gravado quedan para revisión con su motivo", () => {
        const p = preview("SALES", portalCsv("SALES", [
            sale({ code: 6, number: 50, docType: 96, doc: "30123456", name: "", total: "121.00", rates: { "21": ["100.00", "21.00"] } }),
            sale({ code: 195, number: 51 }),
            sale({ number: 52, total: "100.00", rates: { "0": ["100.00", "0"] } }),
        ]));
        expect(p.rows.map((r) => r.status)).toEqual(["REVIEW", "REVIEW", "REVIEW"]);
        expect(p.rows[0].messages[0]).toMatch(/no informa la denominación/);
        expect(p.rows[1].messages.join(" ")).toMatch(/no informa el reintegro TurIVA/);
        expect(p.rows[2].messages.join(" ")).toMatch(/0 %.*código de operación/);
    });
    it("archivo equivocado: otro libro, encabezado distinto o UTF-8 impiden confirmar", () => {
        expect(preview("PURCHASES", portalCsv("SALES", [sale()])).fileErrors[0]).toMatch(/es de ventas/);
        const changed = [...PORTAL_HEADERS.SALES]; changed[9] = "Total";
        expect(preview("SALES", portalCsv("SALES", [sale()], changed)).fileErrors[0]).toMatch(/encabezado no coincide/);
        const utf8 = new TextEncoder().encode(new TextDecoder("windows-1252").decode(portalCsv("SALES", [sale()])));
        expect(preview("SALES", utf8).fileErrors[0]).toMatch(/encabezado no coincide/);
        expect(preview("SALES", new Uint8Array(0)).fileErrors[0]).toMatch(/vacío/);
    });
    it("fila con columnas de menos o fecha inválida: fila con error", () => {
        const good = portalCsv("SALES", [sale()]);
        const text = new TextDecoder("windows-1252").decode(good).trimEnd() + "\n2026-10-31;1;5\n2026-02-30" + ";x".repeat(32) + "\n";
        const p = preview("SALES", ansiFile(text.split("\n").filter(Boolean), "\n"));
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "ERROR", "ERROR"]);
    });
    it("misma clave que el TXT: un comprobante ya importado por TXT queda «ya cargado» desde la descarga", () => {
        const txt = buildImportPreview({ ...ctx("SALES"), source: "LID_TXT" },
            parseLidFile(ansiFile([salesVoucherLine({ date: "20261005", code: 1, pos: 5, number: 35, doc: BUYER, name: "CLIENTE SINTETICO SA", total: "1210.00", aliquotCount: 1 })]), "SALES", "VOUCHERS"),
            parseLidFile(ansiFile([salesAliquotLine({ code: 1, pos: 5, number: 35, net: "1000.00", rate: 5, vat: "210.00" })]), "SALES", "ALIQUOTS"));
        const key = txt.rows[0].key!;
        const p = preview("SALES", portalCsv("SALES", [sale()]), ctx("SALES", { existingKeys: new Set([key]) }));
        expect(p.rows[0].status).toBe("DUPLICATE");
    });
});

describe("lo que queda afuera antes de confirmar", () => {
    it("dos ventas para revisar por denominación vacía: su débito se ve separado de lo que se importa", () => {
        const p = preview("SALES", portalCsv("SALES", [
            sale(),
            sale({ code: 6, number: 60, docType: 96, doc: "30123456", name: "", total: "121.00", rates: { "21": ["100.00", "21.00"] } }),
            sale({ code: 6, number: 61, docType: 96, doc: "30123457", name: "", total: "242.00", rates: { "21": ["200.00", "42.00"] } }),
            sale({ number: 62, doc: BUYER.slice(0, 10) + String((Number(BUYER[10]) + 1) % 10), total: "605.00", rates: { "21": ["500.00", "105.00"] } }),
        ]));
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "REVIEW", "REVIEW", "ERROR"]);
        const r = p.reconciliation;
        expect([r.importable.CONSOLIDATED.count, m(r.importable.CONSOLIDATED.vat)]).toEqual([1, "210.00"]);
        expect([r.notImported.REVIEW.count, m(r.notImported.REVIEW.vat), m(r.notImported.REVIEW.taxedNet)]).toEqual([2, "63.00", "300.00"]);
        expect([r.notImported.ERROR.count, m(r.notImported.ERROR.informedTotal)]).toEqual([1, "605.00"]);
        expect(r.notImported.DUPLICATE.count).toBe(0);
        // Lo del archivo = lo que se importa + lo que queda afuera (IVA de alícuotas, sin la fila con error).
        expect(r.importable.CONSOLIDATED.vat.plus(r.notImported.REVIEW.vat).toFixed(2)).toBe("273.00");
    });
    it("regresión: una fila para revisar que ya está cargada (completada desde el TXT) queda «ya cargada», no pendiente", () => {
        const pending = sale({ code: 6, number: 60, docType: 96, doc: "30123456", name: "", total: "121.00", rates: { "21": ["100.00", "21.00"] } });
        const first = preview("SALES", portalCsv("SALES", [pending]));
        expect(first.rows[0].status).toBe("REVIEW");
        const again = preview("SALES", portalCsv("SALES", [pending]), ctx("SALES", { existingKeys: new Set([first.rows[0].key!]) }));
        expect(again.rows[0].status).toBe("DUPLICATE");
        expect(again.rows[0].messages[0]).toBe("ya cargado para este cliente: se omite");
        expect(again.rows[0].messages.join(" ")).toMatch(/no informa la denominación/);
        expect([again.reconciliation.notImported.REVIEW.count, again.reconciliation.notImported.DUPLICATE.count, again.reconciliation.notImported.DUPLICATE.vat.toFixed(2)]).toEqual([0, 1, "21.00"]);
    });
});

describe("descarga de Portal IVA: ZIP", () => {
    const csv = portalCsv("SALES", [sale()]);
    it("el ZIP con un único CSV se lee igual que el CSV", () => {
        const z = extractSingleCsv(zipOne("comprobantes_periodo_202610_ventas_x (montos expresados en pesos).csv", csv));
        expect(z.ok && Buffer.from(z.bytes).equals(Buffer.from(csv))).toBe(true);
        expect(preview("SALES", zipOne("a.csv", csv)).rows.map((r) => r.status)).toEqual(["OK"]);
    });
    it("rechaza CRC dañado, más de una entrada, otra extensión y basura", () => {
        expect(preview("SALES", zipOne("a.csv", csv, { breakCrc: true })).fileErrors[0]).toMatch(/CRC/);
        expect(preview("SALES", zipOne("a.csv", csv, { extraEntry: true })).fileErrors[0]).toMatch(/único archivo/);
        expect(preview("SALES", zipOne("a.txt", csv)).fileErrors[0]).toMatch(/único archivo \.csv/);
        expect(preview("SALES", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])).fileErrors[0]).toMatch(/ZIP inválido/);
    });
});

describe("solicitud con formato PORTAL_CSV", () => {
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    const base = { clientId: "c1", category: "SALES", vouchersFile: b64(portalCsv("SALES", [sale()])) };
    it("un solo archivo; no admite archivo de alícuotas; formato inválido rechazado", () => {
        expect(parseImportRequest({ ...base, format: "PORTAL_CSV" }, { requireToken: false })).toMatchObject({ ok: true, data: { format: "PORTAL_CSV" } });
        expect(parseImportRequest({ ...base, format: "PORTAL_CSV", aliquotsFile: "AAAA" }, { requireToken: false })).toMatchObject({ ok: false, field: "aliquotsFile" });
        expect(parseImportRequest({ ...base, format: "XLS" }, { requireToken: false })).toMatchObject({ ok: false, field: "format" });
        expect(parseImportRequest(base, { requireToken: false })).toMatchObject({ ok: false, field: "aliquotsFile" });
    });
});
