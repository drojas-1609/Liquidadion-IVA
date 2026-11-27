import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { parsePortalDownload } from "@/lib/libro-iva-import/portal-csv";
import { buildImportPreview, type PreviewContext } from "@/lib/libro-iva-import/build";
import { cuit, portalCsv, type SynthPortalRow } from "./helpers/libro-iva-synth";

// Datos SINTÉTICOS: compra con crédito computable informado menor al IVA (cliente con prorrateo global en IVA Simple).
const SELLER = cuit("3071111111");
const purchase = (over: Partial<SynthPortalRow> = {}): SynthPortalRow => ({
    date: "2026-10-03", code: 1, pos: 1, number: 900, doc: SELLER, name: "PROVEEDOR SINTETICO SRL", total: "1210.00", computableCredit: "107.78", rates: { "21": ["1000.00", "210.00"] }, ...over,
});
const ctx = (mode: "NONE" | "GLOBAL" | "DIRECT_AND_GLOBAL"): PreviewContext => ({
    category: "PURCHASES", period: { month: 10, year: 2026 }, settings: { creditProrationMode: mode, globalCoefficient: mode === "NONE" ? null : new Prisma.Decimal("0.5132"), turivaIncluded: false },
    existingKeys: new Set(), source: "PORTAL_CSV",
});
const run = (mode: "NONE" | "GLOBAL" | "DIRECT_AND_GLOBAL", rows = [purchase()]) => {
    const p = parsePortalDownload(portalCsv("PURCHASES", rows), "PURCHASES");
    return buildImportPreview(ctx(mode), p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.totalColumnNotes });
};

describe("compras de un período con prorrateo global", () => {
    it("GLOBAL: se importan con todo el IVA sujeto a prorrateo, sin crédito computable propio", () => {
        const p = run("GLOBAL");
        expect(p.rows.map((r) => r.status)).toEqual(["OK"]);
        const l = p.rows[0].model!.vatLines[0];
        expect([l.creditAllocation, l.computableVatAmount, l.vatAmount.toFixed(2)]).toEqual(["GLOBAL_PRORATION", null, "210.00"]);
        expect(p.rows[0].model!.directComputableVatCreditAmount.toFixed(2)).toBe("0.00");
        expect(p.rows[0].notes.join(" ")).toMatch(/prorrateo global.*107\.78.*referencia/);
    });
    it("factura B/C sin IVA discriminado: sin líneas ni nota", () => {
        const p = run("GLOBAL", [purchase({ code: 11, number: 5, total: "300.00", computableCredit: "0", rates: undefined })]);
        expect(p.rows[0].status).toBe("OK");
        expect(p.rows[0].model!.vatLines).toEqual([]);
    });
    it("sin prorrateo sigue para revisar; directa y global también", () => {
        expect(run("NONE").rows[0].messages.join(" ")).toMatch(/período sin prorrateo/);
        expect(run("DIRECT_AND_GLOBAL").rows[0].messages.join(" ")).toMatch(/asignación directa y global/);
    });
});
