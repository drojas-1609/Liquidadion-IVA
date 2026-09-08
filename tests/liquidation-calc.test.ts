import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { computeLiquidation, type PeriodForCalc } from "@/lib/liquidation-calc";

const D = (v: string) => new Prisma.Decimal(v);

function inv(category: "SALES" | "PURCHASES", net: string, rate: string) {
  const netD = D(net);
  const vat = netD.times(rate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return { category, netAmount: netD, vatAmount: vat, totalAmount: netD.plus(vat) };
}
function tax(type: string, amount: string) {
  return { type, amount: D(amount) };
}

describe("lib/liquidation-calc", () => {
  it("liquidación completa: débito/crédito/saldo, IIBB con alícuota de 6 decimales (caso 5)", () => {
    const period: PeriodForCalc = {
      client: { defaultIibbRate: D("3.523456") },
      invoices: [
        inv("SALES", "100000.00", "21"),
        inv("SALES", "50000.00", "10.5"),
        inv("PURCHASES", "80000.00", "21"),
      ],
      taxRecords: [tax("RETENCION IVA", "1234.56"), tax("PERCEPCION IIBB", "500.00"), tax("SIRCREB", "250.00")],
    };

    const r = computeLiquidation(period);

    expect(r.sales.net.toFixed(2)).toBe("150000.00");
    expect(r.sales.vat.toFixed(2)).toBe("26250.00"); // 21000 + 5250
    expect(r.purchases.vat.toFixed(2)).toBe("16800.00");
    expect(r.iva.balance.toFixed(2)).toBe("9450.00"); // 26250 - 16800
    expect(r.iva.retentions.toFixed(2)).toBe("1234.56");
    expect(r.iva.payable.toFixed(2)).toBe("8215.44");

    expect(r.iibb.rate.toString()).toBe("3.523456");
    // 150000 * 3.523456 / 100 = 5285.184 -> HALF_UP 2 -> 5285.18
    expect(r.iibb.tax.toFixed(2)).toBe("5285.18");
    expect(r.iibb.retentions.toFixed(2)).toBe("750.00"); // 500 IIBB + 250 SIRCREB
    expect(r.iibb.payable.toFixed(2)).toBe("4535.18");
  });

  it("caso 14 (integración): 750 ventas de 0.10 no derivan en la sumatoria de la liquidación", () => {
    const invoices = Array.from({ length: 750 }, () => inv("SALES", "0.10", "21"));
    const period: PeriodForCalc = {
      client: { defaultIibbRate: D("3") },
      invoices,
      taxRecords: [],
    };
    const r = computeLiquidation(period);
    expect(r.sales.net.toFixed(2)).toBe("75.00"); // 750 * 0.10
    // vat por comprobante: 0.10 * 21% = 0.021 -> HALF_UP -> 0.02 ; * 750 = 15.00
    expect(r.sales.vat.toFixed(2)).toBe("15.00");
  });

  it("defaultIibbRate null -> usa 3 por defecto", () => {
    const period: PeriodForCalc = {
      client: { defaultIibbRate: null },
      invoices: [inv("SALES", "1000.00", "21")],
      taxRecords: [],
    };
    const r = computeLiquidation(period);
    expect(r.iibb.rate.toString()).toBe("3");
    expect(r.iibb.tax.toFixed(2)).toBe("30.00");
  });
});
