import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { computeLiquidation, type PeriodForCalc } from "@/lib/liquidation-calc";

/**
 * Punto 4: la extracción a computeLiquidation no cambia reglas funcionales.
 *
 * `oldFormula` reimplementa exactamente la lógica que estaba triplicada en
 * origin/main (export/route.ts, liquidation/page.tsx, period/[periodId]/page.tsx),
 * pero con Prisma.Decimal para poder comparar sin ruido binario.
 *
 * Diferencias esperadas y aprobadas (decisión #4 del brief: redondear los
 * importes calculados por la app):
 *  - `iibbTax`: NUEVO redondea a 2 decimales ROUND_HALF_UP; el viejo dejaba
 *    precisión completa.  -> `iibbPayable` cambia por ≤ 0.005.
 *  - fallback de alícuota: NUEVO usa `?? 3` (sólo null); viejo `|| 3.0`.
 *    Con Decimal ambos coinciden salvo si el cliente tiene alícuota 0
 *    EXPLÍCITA: el viejo la trataba como 3% (bug), el nuevo respeta 0%.
 *
 * Sin cambios de clasificación / inclusión / signo: filtros SALES/PURCHASES,
 * retenciones IVA (`type.includes("IVA")`), retenciones IIBB
 * (`includes("IIBB") || SIRCREB || SIRTAC`) y todos los signos son idénticos.
 */

type Inv = { category: string; netAmount: Prisma.Decimal; vatAmount: Prisma.Decimal; totalAmount: Prisma.Decimal };
type Tax = { type: string; amount: Prisma.Decimal };
const D = (v: string) => new Prisma.Decimal(v);

function oldFormula(period: { invoices: Inv[]; taxRecords: Tax[]; client: { defaultIibbRate: Prisma.Decimal | null } }) {
  const sales = period.invoices.filter((i) => i.category === "SALES");
  const purchases = period.invoices.filter((i) => i.category === "PURCHASES");
  const S = (arr: Prisma.Decimal[]) => arr.reduce((a, c) => a.plus(c), new Prisma.Decimal(0));

  const totalSalesNet = S(sales.map((s) => s.netAmount));
  const totalSalesVAT = S(sales.map((s) => s.vatAmount));
  const totalSales = S(sales.map((s) => s.totalAmount));
  const totalPurchasesNet = S(purchases.map((p) => p.netAmount));
  const totalPurchasesVAT = S(purchases.map((p) => p.vatAmount));
  const totalPurchases = S(purchases.map((p) => p.totalAmount));

  const ivaDebit = totalSalesVAT;
  const ivaCredit = totalPurchasesVAT;
  const ivaTechnicalBalance = ivaDebit.minus(ivaCredit);
  const ivaRetentions = S(period.taxRecords.filter((t) => t.type.includes("IVA")).map((t) => t.amount));
  const ivaPayable = ivaTechnicalBalance.minus(ivaRetentions);

  const iibbRate = period.client.defaultIibbRate ?? new Prisma.Decimal("3");
  const iibbTax = totalSalesNet.times(iibbRate).div(100); // SIN redondeo (viejo)
  const iibbRetentions = S(
    period.taxRecords
      .filter((t) => t.type.includes("IIBB") || t.type === "SIRCREB" || t.type === "SIRTAC")
      .map((t) => t.amount),
  );
  const iibbPayable = iibbTax.minus(iibbRetentions);

  return {
    sales: { net: totalSalesNet, vat: totalSalesVAT, total: totalSales },
    purchases: { net: totalPurchasesNet, vat: totalPurchasesVAT, total: totalPurchases },
    iva: { debit: ivaDebit, credit: ivaCredit, balance: ivaTechnicalBalance, retentions: ivaRetentions, payable: ivaPayable },
    iibb: { rate: iibbRate, base: totalSalesNet, tax: iibbTax, retentions: iibbRetentions, payable: iibbPayable },
  };
}

const ROUND2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

function mkPeriod(rate: string): PeriodForCalc {
  return {
    client: { defaultIibbRate: D(rate) },
    invoices: [
      { category: "SALES", netAmount: D("100000.00"), vatAmount: D("21000.00"), totalAmount: D("121000.00") },
      { category: "SALES", netAmount: D("33333.33"), vatAmount: D("3500.00"), totalAmount: D("36833.33") },
      { category: "PURCHASES", netAmount: D("80000.00"), vatAmount: D("16800.00"), totalAmount: D("96800.00") },
    ],
    taxRecords: [
      { type: "RETENCION IVA", amount: D("1234.56") },
      { type: "PERCEPCION IIBB", amount: D("500.00") },
      { type: "SIRCREB", amount: D("250.00") },
      { type: "SIRTAC", amount: D("10.00") },
    ],
  };
}

describe("paridad liquidación vieja vs nueva (punto 4)", () => {
  it("fixture con iibbTax entero de centavos: viejo === nuevo EN TODOS los campos", () => {
    // rate 3 -> iibbTax = 133333.33 * 3 / 100 = 3999.9999 -> viejo sin round,
    // elegimos base que dé exacto: net 100000 -> 3000.00 exacto.
    const period: PeriodForCalc = {
      client: { defaultIibbRate: D("3") },
      invoices: [{ category: "SALES", netAmount: D("100000.00"), vatAmount: D("21000.00"), totalAmount: D("121000.00") }],
      taxRecords: [{ type: "PERCEPCION IIBB", amount: D("100.00") }],
    };
    const oldR = oldFormula(period);
    const newR = computeLiquidation(period);
    expect(newR.iibb.tax.equals(oldR.iibb.tax)).toBe(true); // 3000.00
    expect(newR.iibb.payable.equals(oldR.iibb.payable)).toBe(true);
    expect(newR.iva.payable.equals(oldR.iva.payable)).toBe(true);
    expect(newR.sales.total.equals(oldR.sales.total)).toBe(true);
  });

  it("fixture general: identidad salvo el redondeo aprobado de iibbTax", () => {
    const period = mkPeriod("3.523456");
    const oldR = oldFormula(period);
    const newR = computeLiquidation(period);

    // Idénticos (sin cambio de regla / signo / clasificación):
    for (const seg of ["sales", "purchases"] as const) {
      for (const k of ["net", "vat", "total"] as const) {
        expect(newR[seg][k].equals(oldR[seg][k]), `${seg}.${k}`).toBe(true);
      }
    }
    for (const k of ["debit", "credit", "balance", "retentions", "payable"] as const) {
      expect(newR.iva[k].equals(oldR.iva[k]), `iva.${k}`).toBe(true);
    }
    expect(newR.iibb.rate.equals(oldR.iibb.rate)).toBe(true);
    expect(newR.iibb.base.equals(oldR.iibb.base)).toBe(true);
    expect(newR.iibb.retentions.equals(oldR.iibb.retentions)).toBe(true);

    // Única diferencia: iibbTax redondeado (decisión #4).
    expect(oldR.iibb.tax.decimalPlaces()).toBeGreaterThan(2); // el viejo NO estaba redondeado
    expect(newR.iibb.tax.equals(ROUND2(oldR.iibb.tax))).toBe(true);
    // el delta en iibbPayable es exactamente el del redondeo y es < 0.005
    const delta = newR.iibb.payable.minus(oldR.iibb.payable).abs();
    expect(delta.lessThan("0.005")).toBe(true);
    expect(newR.iibb.payable.equals(ROUND2(oldR.iibb.tax).minus(oldR.iibb.retentions))).toBe(true);
  });

  it("alícuota 0 explícita: nuevo respeta 0% (viejo la habría tratado como 3% por `|| 3.0`)", () => {
    const period: PeriodForCalc = {
      client: { defaultIibbRate: D("0") },
      invoices: [{ category: "SALES", netAmount: D("100000.00"), vatAmount: D("21000.00"), totalAmount: D("121000.00") }],
      taxRecords: [],
    };
    const newR = computeLiquidation(period);
    expect(newR.iibb.rate.equals(0)).toBe(true);
    expect(newR.iibb.tax.equals(0)).toBe(true);
    // documentado: con Float y `|| 3.0` el viejo daba 3000.00 (bug de exención).
  });
});
