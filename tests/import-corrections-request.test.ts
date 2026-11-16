import { describe, it, expect } from "vitest";
import { parseCorrections } from "@/lib/libro-iva-import/request";

describe("parseCorrections: validación de las correcciones elegidas en la app", () => {
    it("acepta sólo claves conocidas, códigos del catálogo e importes positivos con dos decimales", () => {
        const result = parseCorrections({ acceptRounding: true, exemptSaleOperationCode: "E", zeroRateOperationCode: "N", lineAmounts: { "12": { otherTaxes: "9000" } } });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toEqual({ acceptRounding: true, exemptSaleOperationCode: "E", zeroRateOperationCode: "N", lineAmounts: { "12": { otherTaxes: "9000.00" } } });
    });

    it.each([
        [{ unknown: true }],
        [{ exemptSaleOperationCode: "Q" }],
        [{ acceptRounding: "si" }],
        [{ lineAmounts: { "0": { exempt: "1" } } }],
        [{ lineAmounts: { "3": { exempt: "-1" } } }],
        [{ lineAmounts: { "3": { exempt: "1.234" } } }],
        [{ lineAmounts: { "3": { vatAmount: "1" } } }],
        [[]],
    ])("rechaza %j", (raw) => {
        expect(parseCorrections(raw).ok).toBe(false);
    });
});
