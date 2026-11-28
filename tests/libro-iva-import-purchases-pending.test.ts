import { describe, it, expect } from "vitest";
import { parsePortalDownload } from "@/lib/libro-iva-import/portal-csv";
import { buildImportPreview, type PreviewContext, type ImportCorrections } from "@/lib/libro-iva-import/build";
import { parseCorrections } from "@/lib/libro-iva-import/request";
import { hasSmallReportedVatDifference, hasZeroRateWithoutCode } from "@/lib/libro-iva-import/rounding";
import { cuit, portalCsv, type SynthPortalRow } from "./helpers/libro-iva-synth";

// Datos SINTÉTICOS de compras de Portal IVA (decisiones del estudio, 28/11/2026).
const SELLER = cuit("3072222222");
const row = (over: Partial<SynthPortalRow>): SynthPortalRow => ({
    date: "2026-10-15", code: 1, pos: 7, number: 100, doc: SELLER, name: "PROVEEDOR SINTETICO SA", total: "1210.00", computableCredit: "210.00", rates: { "21": ["1000.00", "210.00"] }, ...over,
});
const ctx = (corrections?: ImportCorrections): PreviewContext => ({
    category: "PURCHASES", period: { month: 10, year: 2026 }, settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: false },
    existingKeys: new Set(), source: "PORTAL_CSV", corrections,
});
const run = (rows: SynthPortalRow[], corrections?: ImportCorrections) => {
    const p = parsePortalDownload(portalCsv("PURCHASES", rows), "PURCHASES");
    return buildImportPreview(ctx(corrections), p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.totalColumnNotes });
};

describe("compras: tipos 039 y 112", () => {
    it("039 (Otros comprobantes A RG 1415) se importa como comprobante clase A", () => {
        const p = run([row({ code: 39 })]);
        expect(p.rows[0].status).toBe("OK");
        expect([p.rows[0].voucherCode, p.rows[0].model!.voucherCode]).toEqual([39, 39]);
    });
    it("112 (Tique nota de crédito A) se importa como nota de crédito, con el signo de la descarga", () => {
        const p = run([row({ code: 112, total: "-1210.00", computableCredit: "-210.00", rates: { "21": ["-1000.00", "-210.00"] } })]);
        expect(p.rows[0].status).toBe("OK");
        expect(p.reconciliation.importable.GENERAL.vat.toFixed(2)).toBe("-210.00");
    });
});

describe("compras: IVA informado distinto del calculado", () => {
    const tique = row({ code: 81, total: "1210.35", computableCredit: "210.35", rates: { "21": ["1000.00", "210.35"] } });
    it("sin la corrección queda para revisar; con ella se registra el informado y queda la nota", () => {
        const sin = run([tique]);
        expect(sin.rows[0].status).toBe("REVIEW");
        expect(hasSmallReportedVatDifference(sin.rows[0].messages)).toBe(true);
        const con = run([tique], { acceptReportedVat: true });
        expect(con.rows[0].status).toBe("OK");
        expect(con.rows[0].model!.vatLines[0].vatAmount.toFixed(2)).toBe("210.35");
        expect(con.rows[0].notes.join(" ")).toMatch(/IVA informado 210\.35 registrado; el calculado es 210\.00/);
    });
    it("más de $1 de diferencia sigue para revisar aunque se elija la corrección", () => {
        const grande = row({ total: "1211.50", computableCredit: "211.50", rates: { "21": ["1000.00", "211.50"] } });
        expect(run([grande], { acceptReportedVat: true }).rows[0].status).toBe("REVIEW");
        expect(hasSmallReportedVatDifference(run([grande]).rows[0].messages)).toBe(false);
    });
    it("la corrección viaja en el pedido", () => {
        expect(parseCorrections({ acceptReportedVat: true })).toEqual({ ok: true, value: { acceptReportedVat: true } });
        expect(parseCorrections({ acceptReportedVat: "si" }).ok).toBe(false);
    });
});

describe("compras: neto gravado al 0 % sin código de operación", () => {
    const cero = row({ total: "1710.00", rates: { "21": ["1000.00", "210.00"], "0": ["500.00", "0.00"] } });
    it("se registra como no gravado (código N) cuando se elige", () => {
        const sin = run([cero]);
        expect(sin.rows[0].status).toBe("REVIEW");
        expect(hasZeroRateWithoutCode(sin.rows[0].messages)).toBe(true);
        const con = run([cero], { zeroRateOperationCode: "N" });
        expect(con.rows[0].status).toBe("OK");
        expect(con.rows[0].model!.operationCode).toBe("N");
    });
});
