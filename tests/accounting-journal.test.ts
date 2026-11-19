import { describe, expect, it } from "vitest";
import { D } from "@/lib/decimal";
import { buildIibbEntry, buildTaxPaymentEntry, buildTaxPaymentInput, buildVatEntry, lastDayOfMonth, totals } from "@/lib/accounting/journal";

const s = (lines: { role?: string; accountId?: string; debit: { toFixed: (n: number) => string }; credit: { toFixed: (n: number) => string } }[]) =>
    lines.map((l) => `${l.role ?? l.accountId}:${l.debit.toFixed(2)}/${l.credit.toFixed(2)}`);

describe("libro diario — asiento de IVA", () => {
    it("saldo a pagar: cancela débito con crédito, retenciones y percepciones", () => {
        const e = buildVatEntry({
            debit: "1000", creditPurchases: "600", creditSocialSecurityAnnexI: "50", creditSocialSecurityArt91: "0",
            previousTechnicalBalance: "100", technicalBalanceInFavor: "0", withholdings: "30", perceptions: "20", customsPerceptions: "0",
            previousFreeBalance: "0", balanceToPay: "200", freeBalanceInFavor: "0",
        }, 10, 2026);
        expect(e.date).toBe("2026-10-31");
        expect(s(e.lines)).toEqual([
            "VAT_DEBIT:1000.00/0.00", "VAT_CREDIT:0.00/600.00", "VAT_CREDIT:0.00/50.00", "VAT_TECH_BALANCE:0.00/100.00",
            "VAT_RETENTIONS:0.00/30.00", "VAT_PERCEPTIONS:0.00/20.00", "VAT_PAYABLE:0.00/200.00",
        ]);
    });
    it("saldo técnico a favor: se traslada al Debe y las retenciones van a libre disponibilidad", () => {
        const e = buildVatEntry({
            debit: "500", creditPurchases: "800", creditSocialSecurityAnnexI: "0", creditSocialSecurityArt91: "0",
            previousTechnicalBalance: "0", technicalBalanceInFavor: "300", withholdings: "40", perceptions: "0", customsPerceptions: "0",
            previousFreeBalance: "0", balanceToPay: "0", freeBalanceInFavor: "40",
        }, 2, 2026);
        expect(e.date).toBe("2026-02-28");
        const t = totals(e.lines);
        expect(t.debit.toFixed(2)).toBe("840.00");
        expect(t.credit.toFixed(2)).toBe("840.00");
    });
    it("no cuadra: error", () => {
        expect(() => buildVatEntry({
            debit: "100", creditPurchases: "0", creditSocialSecurityAnnexI: "0", creditSocialSecurityArt91: "0",
            previousTechnicalBalance: "0", technicalBalanceInFavor: "0", withholdings: "0", perceptions: "0", customsPerceptions: "0",
            previousFreeBalance: "0", balanceToPay: "90", freeBalanceInFavor: "0",
        }, 1, 2026)).toThrow(/no cuadra/);
    });
    it("débito negativo (sólo notas de crédito): pasa al Haber", () => {
        const e = buildVatEntry({
            debit: "-50", creditPurchases: "0", creditSocialSecurityAnnexI: "0", creditSocialSecurityArt91: "0",
            previousTechnicalBalance: "0", technicalBalanceInFavor: "50", withholdings: "0", perceptions: "0", customsPerceptions: "0",
            previousFreeBalance: "0", balanceToPay: "0", freeBalanceInFavor: "0",
        }, 3, 2026);
        expect(s(e.lines)).toEqual(["VAT_DEBIT:0.00/50.00", "VAT_TECH_BALANCE:50.00/0.00"]);
    });
});

describe("libro diario — asiento de IIBB", () => {
    it("separa SIRTAC de las retenciones y cierra con IIBB a pagar", () => {
        const e = buildIibbEntry({
            tax: "3000.00", otherDebits: "0", previousBalance: "500.00", withholdings: "900.00", sirtac: "200.00",
            perceptions: "300.00", customsPerceptions: "0", bankCollections: "100.00", paymentsOnAccount: "0", otherCredits: "0",
            balanceDgr: "1200.00", balanceTaxpayer: "0",
        }, 10, 2026);
        expect(s(e.lines)).toEqual([
            "IIBB_EXPENSE:3000.00/0.00", "IIBB_BALANCE:0.00/500.00", "IIBB_RETENTIONS:0.00/700.00", "IIBB_SIRTAC:0.00/200.00",
            "IIBB_PERCEPTIONS:0.00/300.00", "IIBB_SIRCREB:0.00/100.00", "IIBB_PAYABLE:0.00/1200.00",
        ]);
    });
    it("saldo a favor del contribuyente al Debe", () => {
        const e = buildIibbEntry({
            tax: "100", otherDebits: "0", previousBalance: "0", withholdings: "150", sirtac: "0",
            perceptions: "0", customsPerceptions: "0", bankCollections: "0", paymentsOnAccount: "0", otherCredits: "0",
            balanceDgr: "0", balanceTaxpayer: "50",
        }, 10, 2026);
        expect(s(e.lines)).toEqual(["IIBB_EXPENSE:100.00/0.00", "IIBB_BALANCE:50.00/0.00", "IIBB_RETENTIONS:0.00/150.00"]);
    });
});

describe("libro diario — pago con VEP", () => {
    it("IDCB 100 % computable con certificado micro/pequeña", () => {
        const e = buildTaxPaymentEntry({ tax: "IIBB", date: "2026-11-18", capital: "1000.00", interest: "10.00", idcb: "6.06", idcbPercent: 100, paymentAccountId: "acc_wallet", reference: "VEP 1" });
        expect(e.description).toBe("Pago de Ingresos Brutos · VEP 1");
        expect(s(e.lines)).toEqual(["IIBB_PAYABLE:1000.00/0.00", "TAX_INTEREST:10.00/0.00", "IDCB_COMPUTABLE:6.06/0.00", "acc_wallet:0.00/1016.06"]);
    });
    it("IDCB 33 %: el resto va a gasto", () => {
        const e = buildTaxPaymentEntry({ tax: "VAT", date: "2026-11-18", capital: "100", interest: "0", idcb: "10.00", idcbPercent: 33, paymentAccountId: "acc_bank", reference: null });
        expect(s(e.lines)).toEqual(["VAT_PAYABLE:100.00/0.00", "IDCB_COMPUTABLE:3.30/0.00", "IDCB_EXPENSE:6.70/0.00", "acc_bank:0.00/110.00"]);
    });
    it("valida el formulario", () => {
        expect(buildTaxPaymentInput({ tax: "IIBB", date: "2026-11-18", capital: "1.234,56", paymentAccountId: "a" }).ok).toBe(true);
        const r = buildTaxPaymentInput({ tax: "IIBB", date: "2026-11-18", capital: "1.234,56", paymentAccountId: "a" });
        if (r.ok) expect(D(r.value.capital).toFixed(2)).toBe("1234.56");
        expect(buildTaxPaymentInput({ tax: "X", date: "2026-11-18", capital: "1", paymentAccountId: "a" })).toMatchObject({ ok: false, field: "tax" });
        expect(buildTaxPaymentInput({ tax: "VAT", date: "2026-11-18", capital: "0", paymentAccountId: "a" })).toMatchObject({ ok: false, field: "capital" });
        expect(buildTaxPaymentInput({ tax: "VAT", date: "18/11/2026", capital: "1", paymentAccountId: "a" })).toMatchObject({ ok: false, field: "date" });
        expect(buildTaxPaymentInput({ tax: "VAT", date: "2026-11-18", capital: "-1", paymentAccountId: "a" })).toMatchObject({ ok: false, field: "capital" });
        expect(buildTaxPaymentInput({ tax: "VAT", date: "2026-11-18", capital: "1", paymentAccountId: "" })).toMatchObject({ ok: false, field: "paymentAccountId" });
    });
    it("último día del mes", () => {
        expect(lastDayOfMonth(2028, 2)).toBe("2028-02-29");
        expect(lastDayOfMonth(2026, 12)).toBe("2026-12-31");
    });
});
