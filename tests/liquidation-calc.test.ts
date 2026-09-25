import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { computeLiquidation, type PeriodForCalc } from "@/lib/liquidation-calc";
import { MissingGlobalProrationCoefficientError } from "@/lib/invoice-model";

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

describe("lib/liquidation-calc — Fase A: modelo contable", () => {
  const Z = () => D("0");
  /** Fila modelada: importes POSITIVOS, signo por voucherCode. */
  function modeled(
    category: "SALES" | "PURCHASES",
    voucherCode: number,
    net: string,
    vat: string,
    over: Record<string, unknown> = {},
  ) {
    const base = {
      category,
      voucherCode,
      taxedNetAmount: D(net),
      totalVatAmount: D(vat),
      netWithoutVatBreakdownAmount: Z(),
      directComputableVatCreditAmount: category === "PURCHASES" ? D(vat) : Z(),
      grossIncomeTaxBaseAmount: category === "SALES" ? D(net) : null,
      voucherTotalAmount: D(net).plus(D(vat)),
      vatLines:
        category === "PURCHASES"
          ? [{ vatAmount: D(vat), creditAllocation: "DIRECT_COMPUTABLE" }]
          : [{ vatAmount: D(vat), creditAllocation: "NOT_APPLICABLE" }],
      // columnas heredadas: valores deliberadamente distintos para probar que
      // en modo MODELED NO se usan.
      netAmount: D("999999"),
      vatAmount: D("999999"),
      totalAmount: D("999999"),
    };
    return { ...base, ...over };
  }
  const period = (invoices: PeriodForCalc["invoices"]): PeriodForCalc => ({
    client: { defaultIibbRate: D("3") },
    invoices,
    taxRecords: [],
  });

  it("una NC (código 3) RESTA débito y base IIBB aunque sus importes sean positivos", () => {
    const r = computeLiquidation(period([modeled("SALES", 1, "1000", "210"), modeled("SALES", 3, "100", "21")]));
    expect(r.iva.debit.toFixed(2)).toBe("189.00");
    expect(r.iibb.base.toFixed(2)).toBe("900.00");
    expect(r.sales.total.toFixed(2)).toBe("1089.00");
  });

  it("NC de compra (código 8) resta crédito", () => {
    const r = computeLiquidation(
      period([modeled("PURCHASES", 1, "1000", "210"), modeled("PURCHASES", 8, "100", "0", { directComputableVatCreditAmount: D("0") })]),
    );
    expect(r.iva.credit.toFixed(2)).toBe("210.00");
    expect(r.purchases.net.toFixed(2)).toBe("900.00");
  });

  it("el crédito usa el computable DIRECTO, no todo el IVA liquidado", () => {
    const r = computeLiquidation(
      period([modeled("SALES", 1, "1000", "210"), modeled("PURCHASES", 1, "500", "105", { directComputableVatCreditAmount: D("40") })]),
    );
    expect(r.purchases.vat.toFixed(2)).toBe("105.00"); // IVA liquidado (informativo)
    expect(r.iva.credit.toFixed(2)).toBe("40.00");
    expect(r.iva.balance.toFixed(2)).toBe("170.00");
  });

  it("la base IIBB sale de grossIncomeTaxBaseAmount (corregible), no del neto", () => {
    const r = computeLiquidation(period([modeled("SALES", 1, "1000", "210", { grossIncomeTaxBaseAmount: D("600") })]));
    expect(r.iibb.base.toFixed(2)).toBe("600.00");
    expect(r.iibb.tax.toFixed(2)).toBe("18.00");
  });

  it("percepciones informadas en el comprobante NO entran al cálculo (fase F)", () => {
    const withPerc = modeled("PURCHASES", 1, "1000", "210", {
      vatPerceptionAmount: D("30"),
      iibbPerceptionAmount: D("20"),
    });
    const r = computeLiquidation({ ...period([withPerc]), taxRecords: [] });
    expect(r.iva.credit.toFixed(2)).toBe("210.00");
    expect(r.iva.retentions.toFixed(2)).toBe("0.00");
    expect(r.iibb.retentions.toFixed(2)).toBe("0.00");
  });

  it("filas heredadas y modeladas conviven: las heredadas liquidan exactamente como antes", () => {
    const legacyNcPositive = { category: "SALES", netAmount: D("100"), vatAmount: D("21"), totalAmount: D("121") };
    const r = computeLiquidation(period([modeled("SALES", 1, "1000", "210"), legacyNcPositive]));
    expect(r.iva.debit.toFixed(2)).toBe("231.00");
    expect(r.iibb.base.toFixed(2)).toBe("1100.00");
  });

  it("compra B/C: sin IVA ni crédito; su neto sin IVA discriminado se muestra en el neto de compras", () => {
    const b = modeled("PURCHASES", 6, "0", "0", {
      netWithoutVatBreakdownAmount: D("500"),
      voucherTotalAmount: D("500"),
      directComputableVatCreditAmount: D("0"),
      vatLines: [],
    });
    const r = computeLiquidation(period([b]));
    expect(r.iva.credit.toFixed(2)).toBe("0.00");
    expect(r.purchases.net.toFixed(2)).toBe("500.00");
    expect(r.purchases.total.toFixed(2)).toBe("500.00");
  });

  it("código fuera del catálogo en una fila modelada -> falla cerrado", () => {
    expect(() => computeLiquidation(period([modeled("SALES", 201, "1", "0")]))).toThrow(/catálogo oficial/);
  });
});

describe("lib/liquidation-calc — asignación directa y prorrateo global", () => {
  const Z = () => D("0");
  function purchase(code: number, lines: Array<[string, string, string | null]>) {
    // lines: [IVA, atribución, computable]
    const vatLines = lines.map(([vat, allocation]) => ({ vatAmount: D(vat), creditAllocation: allocation }));
    const totalVat = lines.reduce((a, [v]) => a.plus(D(v)), D("0"));
    const direct = lines
      .filter(([, a]) => a === "DIRECT_COMPUTABLE")
      .reduce((a, [, , c]) => a.plus(D(c ?? "0")), D("0"));
    return {
      category: "PURCHASES",
      voucherCode: code,
      taxedNetAmount: totalVat.times(5),
      totalVatAmount: totalVat,
      netWithoutVatBreakdownAmount: Z(),
      directComputableVatCreditAmount: direct,
      grossIncomeTaxBaseAmount: null,
      voucherTotalAmount: totalVat.times(6),
      vatLines,
      netAmount: D("999999"),
      vatAmount: D("999999"),
      totalAmount: D("999999"),
    };
  }
  const withSettings = (invoices: PeriodForCalc["invoices"], vatSettings: PeriodForCalc["vatSettings"]): PeriodForCalc => ({
    client: { defaultIibbRate: D("3") },
    invoices,
    taxRecords: [],
    vatSettings,
  });

  it("crédito = directo computable + HALF_UP(coef × IVA global del período) + 0 por no computable", () => {
    const r = computeLiquidation(
      withSettings(
        [
          purchase(1, [
            ["21.00", "DIRECT_COMPUTABLE", "21.00"],
            ["10.00", "DIRECT_NON_COMPUTABLE", "0"],
            ["50.01", "GLOBAL_PRORATION", null],
          ]),
          purchase(1, [["30.00", "GLOBAL_PRORATION", null]]),
        ],
        { creditProrationMode: "DIRECT_AND_GLOBAL", globalCoefficient: D("0.5") },
      ),
    );
    expect(r.iva.creditDirect.toFixed(2)).toBe("21.00");
    expect(r.iva.globalProrationVat.toFixed(2)).toBe("80.01");
    expect(r.iva.creditProrated.toFixed(2)).toBe("40.01"); // 40.005 -> HALF_UP, una sola vez
    expect(r.iva.credit.toFixed(2)).toBe("61.01");
  });

  it("una NC con líneas globales resta de la base del prorrateo", () => {
    const r = computeLiquidation(
      withSettings(
        [purchase(1, [["100.00", "GLOBAL_PRORATION", null]]), purchase(3, [["40.00", "GLOBAL_PRORATION", null]])],
        { creditProrationMode: "GLOBAL", globalCoefficient: D("0.25") },
      ),
    );
    expect(r.iva.globalProrationVat.toFixed(2)).toBe("60.00");
    expect(r.iva.creditProrated.toFixed(2)).toBe("15.00");
  });

  it.each([
    ["sin configuración", undefined],
    ["modalidad NONE", { creditProrationMode: "NONE", globalCoefficient: null }],
    ["modalidad DIRECT con coeficiente", { creditProrationMode: "DIRECT", globalCoefficient: D("0.5") }],
    ["GLOBAL sin coeficiente", { creditProrationMode: "GLOBAL", globalCoefficient: null }],
  ])("líneas GLOBAL_PRORATION y %s -> falla cerrada con el mensaje exacto", (_l, settings) => {
    const period = withSettings([purchase(1, [["10.00", "GLOBAL_PRORATION", null]])], settings as PeriodForCalc["vatSettings"]);
    expect(() => computeLiquidation(period)).toThrow(MissingGlobalProrationCoefficientError);
    expect(() => computeLiquidation(period)).toThrow("Falta configurar el coeficiente de prorrateo global del período.");
  });

  it("sin líneas globales no se exige coeficiente", () => {
    const r = computeLiquidation(withSettings([purchase(1, [["21.00", "DIRECT_COMPUTABLE", "21.00"]])], undefined));
    expect(r.iva.credit.toFixed(2)).toBe("21.00");
    expect(r.iva.creditProrated.toFixed(2)).toBe("0.00");
  });

  it("compra modelada sin sus líneas cargadas -> falla cerrada (no asume que no hay prorrateo)", () => {
    const p = { ...purchase(1, [["21.00", "DIRECT_COMPUTABLE", "21.00"]]), vatLines: undefined };
    expect(() => computeLiquidation(withSettings([p], undefined))).toThrow(/vatLines no cargadas/);
  });
});
