import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { computeLiquidation, type PeriodForCalc } from "@/lib/liquidation-calc";

/**
 * Determinación del impuesto (F.2051) con ajustes al crédito fiscal por
 * contribuciones a la Seguridad Social y saldo técnico anterior. Cifras
 * SINTÉTICAS: reproducen la misma aritmética que el caso real controlado
 * localmente (débito − compras − ajuste − saldo anterior = saldo a favor), sin
 * ningún importe real.
 */

const D = (v: string) => new Prisma.Decimal(v);
const legacy = (category: "SALES" | "PURCHASES", net: string, vat: string) => ({
  category,
  netAmount: D(net),
  vatAmount: D(vat),
  totalAmount: D(net).plus(vat),
});
const tax = (type: string, amount: string) => ({ type, amount: D(amount) });

function period(over: Partial<PeriodForCalc> = {}): PeriodForCalc {
  return {
    client: { defaultIibbRate: D("3") },
    invoices: [legacy("SALES", "4761.90", "1000.00"), legacy("PURCHASES", "2857.14", "600.00")],
    taxRecords: [],
    vatSettings: { creditProrationMode: "NONE", globalCoefficient: null },
    ...over,
  };
}
const f = (d: Prisma.Decimal) => d.toFixed(2);

describe("liquidación de IVA — ajustes por contribuciones y saldo técnico anterior", () => {
  it("sin ajustes ni saldo anterior: igual que antes (crédito = compras)", () => {
    const r = computeLiquidation(period());
    expect([f(r.iva.debit), f(r.iva.creditPurchases), f(r.iva.credit), f(r.iva.balance)]).toEqual(["1000.00", "600.00", "600.00", "400.00"]);
    expect([f(r.iva.technicalBalanceArca), f(r.iva.technicalBalanceInFavor), f(r.iva.payable)]).toEqual(["400.00", "0.00", "400.00"]);
  });

  it("Anexo I Ley 27.541 + saldo técnico anterior: el saldo queda a favor del contribuyente (caso tipo F.2051)", () => {
    const r = computeLiquidation(
      period({
        vatSettings: { creditProrationMode: "NONE", globalCoefficient: null, previousTechnicalBalance: D("500.00") },
        vatCreditAdjustments: [{ regime: "LEY_27541_ANEXO_I", computableAmount: D("50.00") }],
      }),
    );
    // Total del crédito = 600 + 50; saldo técnico = 1000 − 650 − 500 = −150.
    expect(f(r.iva.creditSocialSecurityAnnexI)).toBe("50.00");
    expect(f(r.iva.credit)).toBe("650.00");
    expect(f(r.iva.previousTechnicalBalance)).toBe("500.00");
    expect(f(r.iva.balance)).toBe("-150.00");
    expect([f(r.iva.technicalBalanceArca), f(r.iva.technicalBalanceInFavor)]).toEqual(["0.00", "150.00"]);
    expect(f(r.iva.payable)).toBe("0.00");
  });

  it("Anexo I no tiene tope: puede generar saldo técnico a favor", () => {
    const r = computeLiquidation(period({ vatCreditAdjustments: [{ regime: "LEY_27541_ANEXO_I", computableAmount: D("900.00") }] }));
    expect(f(r.iva.credit)).toBe("1500.00");
    expect(f(r.iva.technicalBalanceInFavor)).toBe("500.00");
  });

  it("Art. 91 Ley 27.467: se computa hasta el débito fiscal; el excedente no genera saldo a favor", () => {
    const r = computeLiquidation(
      period({
        invoices: [legacy("SALES", "476.19", "100.00")],
        vatCreditAdjustments: [{ regime: "LEY_27467_ART_91", computableAmount: D("150.00") }],
      }),
    );
    expect(f(r.iva.creditSocialSecurityArt91Declared)).toBe("150.00");
    expect(f(r.iva.creditSocialSecurityArt91)).toBe("100.00");
    expect(f(r.iva.credit)).toBe("100.00");
    expect([f(r.iva.balance), f(r.iva.technicalBalanceInFavor)]).toEqual(["0.00", "0.00"]);
  });

  it("Art. 91 antes que las compras: el saldo a favor sólo puede venir de los demás créditos", () => {
    const r = computeLiquidation(
      period({
        invoices: [legacy("SALES", "476.19", "100.00"), legacy("PURCHASES", "142.86", "30.00")],
        vatCreditAdjustments: [{ regime: "LEY_27467_ART_91", computableAmount: D("150.00") }],
      }),
    );
    // Art. 91 aplicado 100 (tope débito) + compras 30 = 130; saldo a favor 30 (de las compras).
    expect(f(r.iva.creditSocialSecurityArt91)).toBe("100.00");
    expect(f(r.iva.credit)).toBe("130.00");
    expect(f(r.iva.technicalBalanceInFavor)).toBe("30.00");
  });

  it("Art. 91 sin débito fiscal: no computa nada", () => {
    const r = computeLiquidation(
      period({ invoices: [legacy("PURCHASES", "100.00", "21.00")], vatCreditAdjustments: [{ regime: "LEY_27467_ART_91", computableAmount: D("50.00") }] }),
    );
    expect(f(r.iva.creditSocialSecurityArt91)).toBe("0.00");
  });

  it("las retenciones sólo cancelan el saldo a favor de ARCA; con saldo técnico a favor son libre disponibilidad", () => {
    const enArca = computeLiquidation(period({ taxRecords: [tax("RETENCION IVA", "30.00")] }));
    expect([f(enArca.iva.technicalBalanceArca), f(enArca.iva.payable)]).toEqual(["400.00", "370.00"]);

    const aFavor = computeLiquidation(
      period({
        vatSettings: { creditProrationMode: "NONE", globalCoefficient: null, previousTechnicalBalance: D("550.00") },
        taxRecords: [tax("RETENCION IVA", "20.00")],
      }),
    );
    // Técnico: 1000 − 600 − 550 = −150 (se traslada); la retención no lo aumenta.
    expect(f(aFavor.iva.technicalBalanceInFavor)).toBe("150.00");
    expect(f(aFavor.iva.payable)).toBe("-20.00");
  });

  it("falla cerrada ante un régimen desconocido o importes negativos", () => {
    expect(() => computeLiquidation(period({ vatCreditAdjustments: [{ regime: "DECRETO_814", computableAmount: D("1") }] }))).toThrow(/régimen/);
    expect(() => computeLiquidation(period({ vatCreditAdjustments: [{ regime: "LEY_27541_ANEXO_I", computableAmount: D("-1") }] }))).toThrow(/negativo/);
    expect(() =>
      computeLiquidation(period({ vatSettings: { creditProrationMode: "NONE", globalCoefficient: null, previousTechnicalBalance: D("-1") } })),
    ).toThrow(/negativo/);
  });
});
