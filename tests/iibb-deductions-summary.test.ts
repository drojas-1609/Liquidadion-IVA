import { describe, expect, it } from "vitest";
import { summarizeIibbDeductions } from "@/lib/iibb-deductions-summary";

describe("resumen de deducciones de IIBB por jurisdicción", () => {
    const rows = summarizeIibbDeductions([
        { type: "PERCEPCION IIBB", amount: "100.00", jurisdictionCode: "901", importSource: "ESICOL_PERCEPCIONES", fromInvoice: false },
        { type: "PERCEPCION IIBB", amount: "-10.00", jurisdictionCode: "901", importSource: null, fromInvoice: true },
        { type: "SIRCREB", amount: "50.00", jurisdictionCode: "920", importSource: "SANTA_CRUZ_BANCARIAS", fromInvoice: false },
        { type: "RETENCION IIBB", amount: "7.00", jurisdictionCode: null, importSource: null, fromInvoice: false },
        { type: "PERCEPCION IVA", amount: "999.00", jurisdictionCode: null, importSource: null, fromInvoice: false },
    ]);
    it("agrupa por jurisdicción (sin jurisdicción al final) e ignora IVA", () => {
        expect(rows.map((r) => [r.jurisdictionCode, r.total.toFixed(2)])).toEqual([["901", "90.00"], ["920", "50.00"], [null, "7.00"]]);
    });
    it("separa el origen: fisco, compras, manual", () => {
        const p = rows[0].cells["PERCEPCION IIBB"];
        expect([p.count, p.byOrigin.reported.toFixed(2), p.byOrigin.purchases.toFixed(2), p.byOrigin.manual.toFixed(2)]).toEqual([2, "100.00", "-10.00", "0.00"]);
        expect(rows[2].cells["RETENCION IIBB"].byOrigin.manual.toFixed(2)).toBe("7.00");
    });
});
