import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { otherConceptsOf } from "@/lib/invoice-list-view";
import { normalizeInvoiceRow } from "@/lib/invoice-model";

const D = (v: string) => new Prisma.Decimal(v);
const zero = {
    exemptAmount: D("0"), nonTaxedAmount: D("0"), vatPerceptionAmount: D("0"), nationalPerceptionAmount: D("0"), iibbPerceptionAmount: D("0"),
    municipalPerceptionAmount: D("0"), internalTaxesAmount: D("0"), otherTaxesAmount: D("0"),
};
/** Factura A y nota de crédito A sólo exentas (datos sintéticos): todo en exento, sin líneas de IVA. */
const stored = (voucherCode: number) => ({
    ...zero, voucherCode, category: "SALES", exemptAmount: D("12345.67"), taxedNetAmount: D("0"), totalVatAmount: D("0"),
    netWithoutVatBreakdownAmount: D("0"), directComputableVatCreditAmount: D("0"), voucherTotalAmount: D("12345.67"), grossIncomeTaxBaseAmount: D("0"),
    netAmount: D("0"), vatAmount: D("0"), totalAmount: D(voucherCode === 3 ? "-12345.67" : "12345.67"), date: null, type: null, entityName: null,
});

describe("lista de comprobantes: exento, no gravado y otros conceptos", () => {
    it("factura A y nota de crédito A sólo exentas: neto e IVA 0, el total lo explica el exento con su signo", () => {
        for (const [code, sign] of [[1, ""], [3, "-"]] as const) {
            const row = stored(code);
            const view = normalizeInvoiceRow(row);
            expect([view.signedNet.toFixed(2), view.signedVat.toFixed(2), view.signedTotal.toFixed(2)]).toEqual(["0.00", "0.00", `${sign}12345.67`]);
            expect(otherConceptsOf(row).map((c) => [c.label, c.signed.toFixed(2)])).toEqual([["Exento", `${sign}12345.67`]]);
            // Neto + IVA + otros conceptos = total (nada queda sin explicar).
            const others = otherConceptsOf(row).reduce((s, c) => s.plus(c.signed), D("0"));
            expect(view.signedNet.plus(view.signedVat).plus(others).equals(view.signedTotal)).toBe(true);
        }
        // El par se compensa en la lista y no genera débito.
        const pair = [stored(1), stored(3)].map((r) => normalizeInvoiceRow(r));
        expect(pair.reduce((s, v) => s.plus(v.signedTotal), D("0")).toFixed(2)).toBe("0.00");
        expect(pair.reduce((s, v) => s.plus(v.vatDebit), D("0")).toFixed(2)).toBe("0.00");
    });

    it("muestra sólo los conceptos con importe, en orden fijo; filas heredadas sin desglose", () => {
        const row = { ...zero, voucherCode: 1, otherTaxesAmount: D("30"), vatPerceptionAmount: D("12.5"), nonTaxedAmount: D("1") };
        expect(otherConceptsOf(row).map((c) => c.label)).toEqual(["No gravado", "Perc. IVA", "Otros tributos"]);
        expect(otherConceptsOf({ ...row, voucherCode: null })).toEqual([]);
    });
});
