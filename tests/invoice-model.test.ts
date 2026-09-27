import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  voucherSign,
  voucherType,
  voucherDisplayLabel,
  vatRateOf,
  vatRateCodeFor,
  computeLineVat,
  computeVoucherTotal,
  purchaseHasNoVatBreakdown,
  modelFromVoucher,
  legacyColumnsFor,
  normalizeInvoiceRow,
  UnknownCatalogCodeError,
  defaultComputableVat,
  vatLineError,
  directComputableOf,
  globalProrationVatOf,
  globalCoefficientOf,
  computeProratedCredit,
  lidSectionError,
  isoDate,
  TURIVA_NOT_INCLUDED_MESSAGE,
  type VoucherModelInput,
  type VoucherAmounts,
  type VatLineData,
} from "@/lib/invoice-model";
import { VOUCHER_TYPES } from "@/lib/arca/catalogs";

const D = (v: string | number) => new Prisma.Decimal(v);
const f2 = (d: Prisma.Decimal) => d.toFixed(2);

const zeroAmounts = (): VoucherAmounts => ({
  taxedNetAmount: D(0),
  totalVatAmount: D(0),
  netWithoutVatBreakdownAmount: D(0),
  nonTaxedAmount: D(0),
  exemptAmount: D(0),
  vatPerceptionAmount: D(0),
  nationalPerceptionAmount: D(0),
  iibbPerceptionAmount: D(0),
  municipalPerceptionAmount: D(0),
  internalTaxesAmount: D(0),
  otherTaxesAmount: D(0),
});

/** Alta manual por código oficial (documento ya validado y normalizado). */
const voucherInput = (over: Partial<VoucherModelInput> = {}): VoucherModelInput => ({
  category: "SALES",
  voucherCode: 1,
  date: new Date("2026-05-31T00:00:00.000Z"),
  pointOfSale: 1,
  number: 100,
  counterpartyDocType: 80,
  counterpartyDocNumber: "30999999995",
  counterpartyName: "Contraparte SA",
  netAmount: D("1000"),
  vatRate: D("21"),
  lidSection: "GENERAL",
  ...over,
});
/** Modelo válido o falla el test (con el error de la función). */
const modelOf = (over: Partial<VoucherModelInput> = {}) => {
  const r = modelFromVoucher(voucherInput(over));
  if (!r.ok) throw new Error(`${r.field}: ${r.error}`);
  return r.model;
};

describe("voucherSign — ÚNICA regla de signo contable", () => {
  it("−1 para notas de crédito, +1 para facturas y notas de débito (todo el catálogo)", () => {
    for (const v of VOUCHER_TYPES) {
      expect(voucherSign(v.code), String(v.code)).toBe(v.kind === "CREDIT_NOTE" ? -1 : 1);
    }
    expect([3, 8, 13, 21, 53, 197].map(voucherSign)).toEqual([-1, -1, -1, -1, -1, -1]);
    expect([1, 2, 6, 7, 11, 12, 19, 20, 51, 52].map(voucherSign)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("código fuera del catálogo -> lanza (nunca asume un signo)", () => {
    for (const code of [0, 4, 63, 201, 999, Number.NaN]) {
      expect(() => voucherSign(code), String(code)).toThrow(UnknownCatalogCodeError);
    }
  });

  it("entrada del catálogo por código", () => {
    expect(voucherType(11).letter).toBe("C");
    expect(voucherType(3).kind).toBe("CREDIT_NOTE");
  });

  it("rótulo: etiqueta heredada si existe (columna type); si no, denominación oficial (019–021, 051–053)", () => {
    expect(voucherDisplayLabel(19)).toBe("FACTURAS DE EXPORTACION");
    expect(voucherDisplayLabel(53)).toBe("NOTAS DE CREDITO M");
    expect(voucherDisplayLabel(1)).toBe("FC A");
  });
});

describe("alícuotas y redondeo HALF_UP (carga manual)", () => {
  it("porcentaje por código oficial; código desconocido lanza", () => {
    expect(vatRateOf(4).toString()).toBe("10.5");
    expect(vatRateOf(8).toString()).toBe("5");
    expect(vatRateOf(9).toString()).toBe("2.5");
    expect(() => vatRateOf(7)).toThrow(UnknownCatalogCodeError);
  });

  it("porcentaje -> código (igualdad decimal exacta)", () => {
    expect(vatRateCodeFor(D("10.500000"))).toBe(4);
    expect(vatRateCodeFor(D("21"))).toBe(5);
    expect(vatRateCodeFor(D("0"))).toBe(3);
    expect(vatRateCodeFor(D("1"))).toBeNull();
    expect(vatRateCodeFor(D("10.49"))).toBeNull();
  });

  it.each([
    // [neto, código, IVA esperado]
    ["0.10", 5, "0.02"], // 0.021 -> 0.02
    ["0.12", 5, "0.03"], // 0.0252 -> 0.03
    ["0.50", 4, "0.05"], // 0.0525 -> 0.05 (HALF_UP en el 3er decimal: 2 < 5)
    ["0.10", 4, "0.01"], // 0.0105 -> 0.01
    ["0.02", 9, "0.00"], // 0.0005 -> 0.00 (el 5 está en el 4to decimal)
    ["0.20", 9, "0.01"], // 0.005 -> 0.01 (exactamente la mitad: sube)
    ["0.01", 5, "0.00"], // 0.0021 -> 0.00
    ["0.03", 6, "0.01"], // 0.0081 -> 0.01
    ["1234.56", 4, "129.63"], // 129.6288 -> 129.63
    ["100.10", 8, "5.01"], // 5.005 -> 5.01 (mitad exacta: sube)
    ["100.30", 8, "5.02"], // 5.015 -> 5.02 (mitad exacta: sube, no "par")
    ["1000", 3, "0.00"],
    ["9999999999999999.99", 3, "0.00"],
  ])("IVA(%s, código %i) = %s", (net, code, expected) => {
    expect(f2(computeLineVat(D(net), code))).toBe(expected);
  });

  it("nunca redondea 'siempre hacia arriba': 0.0104 -> 0.01, 0.0149 -> 0.01", () => {
    // 0.099 * 10.5 % = 0.010395 ; 0.142 * 10.5 % = 0.01491
    expect(f2(computeLineVat(D("0.099"), 4))).toBe("0.01");
    expect(f2(computeLineVat(D("0.142"), 4))).toBe("0.01");
  });
});

describe("computeVoucherTotal — fórmula exacta", () => {
  it("suma exacta de los 11 componentes", () => {
    const a = zeroAmounts();
    a.taxedNetAmount = D("100.01");
    a.totalVatAmount = D("21.00");
    a.netWithoutVatBreakdownAmount = D("1.10");
    a.nonTaxedAmount = D("2.20");
    a.exemptAmount = D("3.30");
    a.vatPerceptionAmount = D("4.40");
    a.nationalPerceptionAmount = D("5.50");
    a.iibbPerceptionAmount = D("6.60");
    a.municipalPerceptionAmount = D("7.70");
    a.internalTaxesAmount = D("8.80");
    a.otherTaxesAmount = D("9.90");
    expect(f2(computeVoucherTotal(a))).toBe("170.51");
  });

  it("todo en cero -> 0.00", () => {
    expect(f2(computeVoucherTotal(zeroAmounts()))).toBe("0.00");
  });
});

describe("purchaseHasNoVatBreakdown — regla oficial compras B/C", () => {
  it("compras B y C: sí; compras A y cualquier venta: no", () => {
    for (const code of [6, 7, 8, 11, 12, 13]) expect(purchaseHasNoVatBreakdown("PURCHASES", code)).toBe(true);
    for (const code of [1, 2, 3]) expect(purchaseHasNoVatBreakdown("PURCHASES", code)).toBe(false);
    for (const code of [1, 6, 11]) expect(purchaseHasNoVatBreakdown("SALES", code)).toBe(false);
  });
});

describe("modelFromVoucher + legacyColumnsFor", () => {
  it("venta 001 (FC A) 21 %: modelo positivo, una línea código 5, base IIBB = neto", () => {
    const m = modelOf();
    expect(m.voucherCode).toBe(1);
    expect(m.vatLines.map((l) => [l.vatRateCode, f2(l.netAmount), f2(l.vatAmount)])).toEqual([[5, "1000.00", "210.00"]]);
    expect(f2(m.voucherTotalAmount)).toBe("1210.00");
    expect(f2(m.directComputableVatCreditAmount)).toBe("0.00");
    expect(m.vatLines[0]).toMatchObject({ creditAllocation: "NOT_APPLICABLE", computableVatAmount: null });
    expect(m.lidSection).toBe("GENERAL");
    expect(f2(m.turivaRefundAmount)).toBe("0.00");
    expect(m.reportedComputableVatCreditAmount).toBeNull();
    expect(f2(m.grossIncomeTaxBaseAmount!)).toBe("1000.00");
    expect(m.counterpartyDocNumber).toBe("30999999995");
    expect(m.currencyCode).toBe("PES");
  });

  it("compra: línea DIRECT_COMPUTABLE, crédito directo = IVA liquidado; sin base IIBB", () => {
    const m = modelOf({ category: "PURCHASES", vatRate: D("10.5") });
    expect(f2(m.directComputableVatCreditAmount)).toBe(f2(m.totalVatAmount));
    expect(m.vatLines[0].creditAllocation).toBe("DIRECT_COMPUTABLE");
    expect(f2(m.vatLines[0].computableVatAmount!)).toBe(f2(m.vatLines[0].vatAmount));
    expect(m.grossIncomeTaxBaseAmount).toBeNull();
  });

  it("IVA por línea HALF_UP: 1234,56 al 10,5 % -> 129,63; total 1364,19", () => {
    const m = modelOf({ netAmount: D("1234.56"), vatRate: D("10.5") });
    expect(f2(m.totalVatAmount)).toBe("129.63");
    expect(f2(m.voucherTotalAmount)).toBe("1364.19");
  });

  it("NC (003) con neto negativo o positivo: modelo idéntico y positivo", () => {
    const a = modelOf({ voucherCode: 3, netAmount: D("-500") });
    const b = modelOf({ voucherCode: 3, netAmount: D("500") });
    expect(f2(a.taxedNetAmount)).toBe("500.00");
    expect(f2(a.voucherTotalAmount)).toBe(f2(b.voucherTotalAmount));
  });

  it("rechaza: factura negativa, código desconocido, alícuota no oficial, compra B/C con IVA", () => {
    const cases: Array<[Partial<VoucherModelInput>, string]> = [
      [{ netAmount: D("-1") }, "netAmount"],
      [{ voucherCode: 999 }, "voucherCode"],
      [{ vatRate: D("1") }, "vatRate"],
      [{ category: "PURCHASES", voucherCode: 6, vatRate: D("21") }, "vatRate"],
      [{ category: "PURCHASES", voucherCode: 11, vatRate: D("10.5") }, "vatRate"],
    ];
    for (const [over, field] of cases) {
      const r = modelFromVoucher(voucherInput(over));
      expect(r.ok, JSON.stringify(over)).toBe(false);
      if (!r.ok) expect(r.field).toBe(field);
    }
  });

  it("compra C (011) con alícuota 0: cero líneas, neto sin IVA discriminado, sin clasificar como exento/no gravado", () => {
    const m = modelOf({ category: "PURCHASES", voucherCode: 11, vatRate: D("0") });
    expect(m.vatLines).toEqual([]);
    expect(f2(m.netWithoutVatBreakdownAmount)).toBe("1000.00");
    expect(f2(m.exemptAmount)).toBe("0.00");
    expect(f2(m.nonTaxedAmount)).toBe("0.00");
    expect(f2(m.voucherTotalAmount)).toBe("1000.00");
  });

  it("columnas heredadas: con signo, etiqueta y CUIT formateado; reproducen el cálculo anterior", () => {
    const l = legacyColumnsFor(modelOf({ voucherCode: 3, netAmount: D("100") }));
    expect(l.type).toBe("NC A");
    expect(l.entityCuit).toBe("30-99999999-5");
    expect(l.entityName).toBe("Contraparte SA");
    expect(l.date.toISOString()).toBe("2026-05-31T00:00:00.000Z");
    expect(l.vatRate?.toString()).toBe("21");
    expect([f2(l.netAmount), f2(l.vatAmount), f2(l.totalAmount)]).toEqual(["-100.00", "-21.00", "-121.00"]);
  });

  it("columnas heredadas en compras: vatAmount = crédito DIRECTO con signo", () => {
    const m = { ...modelOf({ category: "PURCHASES" }), directComputableVatCreditAmount: D("50") };
    expect(f2(legacyColumnsFor(m).vatAmount)).toBe("50.00");
  });

  it("columnas heredadas de 019–021 y 051–053: type = denominación oficial", () => {
    expect(legacyColumnsFor(modelOf({ voucherCode: 51 })).type).toBe("FACTURAS M");
    expect(legacyColumnsFor(modelOf({ voucherCode: 19, vatRate: D("0") })).type).toBe("FACTURAS DE EXPORTACION");
  });

  it("documento no CUIT: entityCuit recibe el número (compatibilidad transitoria); varias líneas -> vatRate NULL", () => {
    expect(legacyColumnsFor(modelOf({ voucherCode: 6, counterpartyDocType: 96, counterpartyDocNumber: "12345678" })).entityCuit).toBe("12345678");
    const base = modelOf();
    const m = {
      ...base,
      counterpartyDocType: 96,
      counterpartyDocNumber: "12345678",
      vatLines: [
        ...base.vatLines,
        {
          vatRateCode: 4,
          netAmount: D(1),
          vatAmount: D("0.11"),
          creditAllocation: "NOT_APPLICABLE" as const,
          computableVatAmount: null,
          computableOverridden: false,
        },
      ],
    };
    const l = legacyColumnsFor(m);
    expect(l.entityCuit).toBe("12345678");
    expect(l.vatRate).toBeNull();
  });
});

describe("normalizeInvoiceRow — lectura compatible", () => {
  const legacyRow = (over: Record<string, unknown> = {}) => ({
    category: "SALES",
    netAmount: D("100"),
    vatAmount: D("21"),
    totalAmount: D("121"),
    date: new Date("2026-05-31T00:00:00.000Z"),
    type: "NC A",
    entityName: "X",
    ...over,
  });

  it("fila heredada (voucherCode NULL): usa las columnas heredadas TAL CUAL (liquida como antes)", () => {
    const n = normalizeInvoiceRow(legacyRow());
    expect(n.mode).toBe("LEGACY");
    // una NC guardada en positivo se sigue liquidando como antes (sin reinterpretar)
    expect([f2(n.vatDebit), f2(n.grossIncomeTaxBase), f2(n.signedTotal)]).toEqual(["21.00", "100.00", "121.00"]);
    expect(n.voucherDate).toBe("2026-05-31");
    expect(n.voucherLabel).toBe("NC A");
  });

  it("columnas nuevas incompletas -> sigue en modo heredado", () => {
    expect(normalizeInvoiceRow(legacyRow({ voucherCode: 1, taxedNetAmount: D(100) })).mode).toBe("LEGACY");
  });

  it("fila modelada: signo por código, crédito computable, base IIBB del campo", () => {
    const model = modelOf({ category: "PURCHASES", voucherCode: 3, netAmount: D("200") });
    const row = { ...legacyColumnsFor(model), ...model, directComputableVatCreditAmount: D("30") };
    const n = normalizeInvoiceRow(row);
    expect(n.mode).toBe("MODELED");
    expect(f2(n.vatDirectCredit)).toBe("-30.00"); // NC resta crédito, y usa el DIRECTO
    expect(f2(n.globalProrationVat!)).toBe("0.00");
    expect(n.hasGlobalProrationLines).toBe(false);
    expect(f2(n.vatDebit)).toBe("0.00");
    expect(f2(n.signedVat)).toBe("-42.00"); // IVA liquidado mostrado
  });

  it("modelada: fecha contable sin corrimiento por zona horaria", () => {
    const model = modelOf();
    const n = normalizeInvoiceRow({ ...legacyColumnsFor(model), ...model });
    expect(n.voucherDate).toBe("2026-05-31");
  });

  it("modelada con código fuera del catálogo -> lanza (falla cerrado)", () => {
    const model = modelOf();
    expect(() => normalizeInvoiceRow({ ...legacyColumnsFor(model), ...model, voucherCode: 201 })).toThrow(
      UnknownCatalogCodeError,
    );
  });

  it("paridad: para toda entrada válida, modo nuevo y modo heredado liquidan igual (IVA, crédito, IIBB, neto, total)", () => {
    for (const [category, code, net, rate] of [
      ["SALES", 1, "1000", "21"],
      ["SALES", 3, "-250.55", "10.5"],
      ["SALES", 11, "999.99", "0"],
      ["SALES", 51, "100", "21"],
      ["SALES", 19, "500", "0"],
      ["PURCHASES", 1, "123.45", "27"],
      ["PURCHASES", 3, "80", "5"],
      ["PURCHASES", 6, "300", "0"],
    ] as const) {
      const model = modelOf({ category, voucherCode: code, netAmount: D(net), vatRate: D(rate) });
      const legacy = legacyColumnsFor(model);
      const modeled = normalizeInvoiceRow({ ...legacy, ...model });
      const asLegacy = normalizeInvoiceRow({ ...legacy, category });
      expect(modeled.mode).toBe("MODELED");
      expect(asLegacy.mode).toBe("LEGACY");
      for (const k of ["vatDebit", "vatDirectCredit", "grossIncomeTaxBase", "signedNet", "signedTotal"] as const) {
        expect(f2(modeled[k]), `${code}/${category}/${k}`).toBe(f2(asLegacy[k]));
      }
    }
  });
});

describe("atribución del crédito fiscal por línea", () => {
  const line = (over: Partial<VatLineData>): VatLineData => ({
    vatRateCode: 5,
    netAmount: D("100"),
    vatAmount: D("21"),
    creditAllocation: "DIRECT_COMPUTABLE",
    computableVatAmount: D("21"),
    computableOverridden: false,
    ...over,
  });

  it("computable por defecto: DIRECT_COMPUTABLE = IVA; NON_COMPUTABLE = 0; GLOBAL y NOT_APPLICABLE = NULL", () => {
    expect(f2(defaultComputableVat("DIRECT_COMPUTABLE", D("21"))!)).toBe("21.00");
    expect(f2(defaultComputableVat("DIRECT_NON_COMPUTABLE", D("21"))!)).toBe("0.00");
    expect(defaultComputableVat("GLOBAL_PRORATION", D("21"))).toBeNull();
    expect(defaultComputableVat("NOT_APPLICABLE", D("21"))).toBeNull();
  });

  it("ventas: sólo NOT_APPLICABLE y sin computable", () => {
    expect(vatLineError("SALES", line({ creditAllocation: "NOT_APPLICABLE", computableVatAmount: null }))).toBeNull();
    for (const a of ["DIRECT_COMPUTABLE", "DIRECT_NON_COMPUTABLE", "GLOBAL_PRORATION"] as const) {
      expect(vatLineError("SALES", line({ creditAllocation: a })), a).not.toBeNull();
    }
    expect(vatLineError("SALES", line({ creditAllocation: "NOT_APPLICABLE", computableVatAmount: D(0) }))).not.toBeNull();
  });

  it("compras: NOT_APPLICABLE rechazado", () => {
    expect(vatLineError("PURCHASES", line({ creditAllocation: "NOT_APPLICABLE", computableVatAmount: null }))).not.toBeNull();
  });

  it("DIRECT_COMPUTABLE: 0 ≤ computable ≤ IVA (corrección manual admitida dentro del rango)", () => {
    expect(vatLineError("PURCHASES", line({}))).toBeNull();
    expect(vatLineError("PURCHASES", line({ computableVatAmount: D("10.50"), computableOverridden: true }))).toBeNull();
    expect(vatLineError("PURCHASES", line({ computableVatAmount: D("0"), computableOverridden: true }))).toBeNull();
    expect(vatLineError("PURCHASES", line({ computableVatAmount: D("21.01") }))).not.toBeNull();
    expect(vatLineError("PURCHASES", line({ computableVatAmount: D("-0.01") }))).not.toBeNull();
    expect(vatLineError("PURCHASES", line({ computableVatAmount: null }))).not.toBeNull();
  });

  it("DIRECT_NON_COMPUTABLE: computable = 0, sin corrección", () => {
    expect(vatLineError("PURCHASES", line({ creditAllocation: "DIRECT_NON_COMPUTABLE", computableVatAmount: D(0) }))).toBeNull();
    expect(vatLineError("PURCHASES", line({ creditAllocation: "DIRECT_NON_COMPUTABLE", computableVatAmount: D(1) }))).not.toBeNull();
    expect(
      vatLineError("PURCHASES", line({ creditAllocation: "DIRECT_NON_COMPUTABLE", computableVatAmount: D(0), computableOverridden: true })),
    ).not.toBeNull();
  });

  it("GLOBAL_PRORATION: computable NULL (el prorrateo es por período)", () => {
    expect(vatLineError("PURCHASES", line({ creditAllocation: "GLOBAL_PRORATION", computableVatAmount: null }))).toBeNull();
    expect(vatLineError("PURCHASES", line({ creditAllocation: "GLOBAL_PRORATION", computableVatAmount: D(0) }))).not.toBeNull();
  });

  it("importes negativos en la línea -> error", () => {
    expect(vatLineError("PURCHASES", line({ netAmount: D(-1) }))).not.toBeNull();
  });

  it("crédito directo = Σ computable DIRECT_COMPUTABLE; IVA global = Σ IVA GLOBAL_PRORATION", () => {
    const lines = [
      line({ vatAmount: D("21"), computableVatAmount: D("21") }),
      line({ vatRateCode: 4, vatAmount: D("10.50"), computableVatAmount: D("5.25"), computableOverridden: true }),
      line({ vatAmount: D("42"), creditAllocation: "DIRECT_NON_COMPUTABLE", computableVatAmount: D(0) }),
      line({ vatAmount: D("63"), creditAllocation: "GLOBAL_PRORATION", computableVatAmount: null }),
    ];
    expect(f2(directComputableOf(lines))).toBe("26.25");
    expect(f2(globalProrationVatOf(lines))).toBe("63.00");
  });
});

describe("prorrateo global — coeficiente por período y redondeo único", () => {
  it("sin configuración o modalidad sin GLOBAL -> sin coeficiente utilizable", () => {
    expect(globalCoefficientOf(null)).toBeNull();
    expect(globalCoefficientOf(undefined)).toBeNull();
    expect(globalCoefficientOf({ creditProrationMode: "NONE", globalCoefficient: D("0.5") })).toBeNull();
    expect(globalCoefficientOf({ creditProrationMode: "DIRECT", globalCoefficient: D("0.5") })).toBeNull();
    expect(globalCoefficientOf({ creditProrationMode: "GLOBAL", globalCoefficient: null })).toBeNull();
  });

  it("GLOBAL y DIRECT_AND_GLOBAL con coeficiente -> se usa tal cual (10 decimales)", () => {
    expect(globalCoefficientOf({ creditProrationMode: "GLOBAL", globalCoefficient: D("0.1234567891") })?.toString()).toBe("0.1234567891");
    expect(globalCoefficientOf({ creditProrationMode: "DIRECT_AND_GLOBAL", globalCoefficient: D("1") })?.toString()).toBe("1");
  });

  it.each([
    ["0.5", "100.01", "50.01"],
    ["0.3333333333", "100.00", "33.33"],
    ["0.6666666667", "100.00", "66.67"],
    ["0", "999.99", "0.00"],
    ["1", "999.99", "999.99"],
    ["0.5", "-100.01", "-50.01"],
  ])("HALF_UP(%s × %s, 2) = %s", (coef, base, expected) => {
    expect(f2(computeProratedCredit(D(coef), D(base)))).toBe(expected);
  });

  it("redondeo UNA vez sobre el total: 3 líneas de 0.01 al 0,5 -> 0.02 (por línea daría 0.03)", () => {
    const total = ["0.01", "0.01", "0.01"].reduce((a, v) => a.plus(D(v)), D("0"));
    expect(f2(computeProratedCredit(D("0.5"), total))).toBe("0.02");
    const perLine = ["0.01", "0.01", "0.01"].map((v) => computeProratedCredit(D("0.5"), D(v)));
    expect(f2(perLine.reduce((a, v) => a.plus(v), D("0")))).toBe("0.03");
  });
});

describe("TurIVA", () => {
  it("pestaña TURIVA exige turivaIncluded en el período", () => {
    expect(lidSectionError("GENERAL", null)).toBeNull();
    expect(lidSectionError("TURIVA", null)).toBe(TURIVA_NOT_INCLUDED_MESSAGE);
    expect(lidSectionError("TURIVA", { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: false })).toBe(
      TURIVA_NOT_INCLUDED_MESSAGE,
    );
    expect(lidSectionError("TURIVA", { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: true })).toBeNull();
  });

  it("comprobantes clase T: signo por código (197 = nota de crédito)", () => {
    expect([195, 196, 197].map(voucherSign)).toEqual([1, 1, -1]);
    expect(voucherType(195).letter).toBe("T");
  });

  it("el reintegro TurIVA NO forma parte del total del comprobante", () => {
    const a = zeroAmounts();
    a.taxedNetAmount = D("100");
    a.totalVatAmount = D("21");
    expect(Object.keys(a)).not.toContain("turivaRefundAmount");
    expect(f2(computeVoucherTotal(a))).toBe("121.00");
  });

  it("compra clase T no está alcanzada por la regla B/C (puede llevar líneas)", () => {
    expect(purchaseHasNoVatBreakdown("PURCHASES", 195)).toBe(false);
  });
});

describe("isoDate — fecha @db.Date sin corrimiento por zona horaria", () => {
  it("toma el día UTC de la medianoche que devuelve Prisma para @db.Date", () => {
    expect(isoDate(new Date("2026-05-31T00:00:00.000Z"))).toBe("2026-05-31");
    expect(isoDate(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01");
    expect(isoDate(null)).toBeNull();
  });
});

describe("modelFromVoucher — núcleo del alta manual por código oficial", () => {
  it("todo código A/B/C del catálogo, en ventas y compras, con varios netos y alícuotas: modelo positivo con signo por código", () => {
    const ABC = VOUCHER_TYPES.filter((v) => ["A", "B", "C"].includes(v.letter));
    for (const v of ABC) {
      for (const category of ["SALES", "PURCHASES"] as const) {
        const noVat = category === "PURCHASES" && (v.letter === "B" || v.letter === "C");
        for (const [net, rate] of [["1000", "21"], ["1234.56", "10.5"], ["-500", "21"], ["800", "0"]] as const) {
          if (noVat && rate !== "0") continue;
          const r = modelFromVoucher(voucherInput({ category, voucherCode: v.code, netAmount: D(net), vatRate: D(rate) }));
          const tag = `${category} ${v.code} ${net}/${rate}`;
          if (net.startsWith("-") && v.kind !== "CREDIT_NOTE") {
            expect(r, tag).toMatchObject({ ok: false, field: "netAmount" });
            continue;
          }
          expect(r.ok, tag).toBe(true);
          if (!r.ok) continue;
          expect(r.model.taxedNetAmount.isNegative() || r.model.voucherTotalAmount.isNegative(), tag).toBe(false);
          expect(f2(legacyColumnsFor(r.model).totalAmount), tag).toBe(f2(r.model.voucherTotalAmount.times(voucherSign(v.code))));
        }
      }
    }
  });

  it("063 y códigos fuera del catálogo -> error voucherCode", () => {
    for (const code of [63, 0, 4, 201, 999]) {
      const r = modelFromVoucher(voucherInput({ voucherCode: code }));
      expect(r, String(code)).toMatchObject({ ok: false, field: "voucherCode" });
    }
  });

  it("019–021 y 051–053 se construyen por código (no tienen etiqueta heredada)", () => {
    for (const code of [19, 20, 21, 51, 52, 53]) {
      const r = modelFromVoucher(voucherInput({ voucherCode: code, netAmount: D(code === 21 || code === 53 ? "-100" : "100") }));
      expect(r.ok, String(code)).toBe(true);
      if (r.ok) {
        expect(r.model.voucherCode).toBe(code);
        expect(r.model.lidSection).toBe("GENERAL");
      }
    }
  });

  it("clase T exige TURIVA; los demás exigen GENERAL (error de campo lidSection)", () => {
    for (const code of [195, 196, 197]) {
      expect(modelFromVoucher(voucherInput({ voucherCode: code, lidSection: "GENERAL" })), String(code)).toMatchObject({
        ok: false,
        field: "lidSection",
      });
      const ok = modelFromVoucher(voucherInput({ voucherCode: code, lidSection: "TURIVA", counterpartyDocType: 94, counterpartyDocNumber: "AB123456" }));
      expect(ok.ok, String(code)).toBe(true);
      if (ok.ok) expect(ok.model.lidSection).toBe("TURIVA");
    }
    for (const code of [1, 6, 11, 19, 51]) {
      expect(modelFromVoucher(voucherInput({ voucherCode: code, lidSection: "TURIVA" })), String(code)).toMatchObject({
        ok: false,
        field: "lidSection",
      });
    }
  });

  it("documento y nombre de la contraparte se toman del input (no se fuerza CUIT)", () => {
    const r = modelFromVoucher(voucherInput({ voucherCode: 6, counterpartyDocType: 96, counterpartyDocNumber: "12345678", counterpartyName: "Consumidor" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.counterpartyDocType).toBe(96);
      expect(r.model.counterpartyDocNumber).toBe("12345678");
      expect(r.model.counterpartyName).toBe("Consumidor");
    }
  });

  it("conserva las reglas existentes: neto negativo en factura, alícuota fuera de tabla y compras B/C con alícuota", () => {
    expect(modelFromVoucher(voucherInput({ netAmount: D("-1") }))).toMatchObject({ ok: false, field: "netAmount" });
    expect(modelFromVoucher(voucherInput({ vatRate: D("1") }))).toMatchObject({ ok: false, field: "vatRate" });
    expect(modelFromVoucher(voucherInput({ category: "PURCHASES", voucherCode: 11, vatRate: D("21") }))).toMatchObject({
      ok: false,
      field: "vatRate",
    });
  });
});
