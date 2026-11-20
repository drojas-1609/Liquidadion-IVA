import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { iibbByActivity, resolveActivity, type IibbActivityConfig } from "@/lib/iibb/activity-base";
import { buildActivityAssignmentInput, buildActivityConfigInput } from "@/lib/iibb/activity-input";
import { computeLiquidation, type PeriodForCalc } from "@/lib/liquidation-calc";

const D = (v: string) => new Prisma.Decimal(v);

// Datos ficticios: códigos y alícuotas de ejemplo, no de un cliente real.
const cfg: IibbActivityConfig = {
  jurisdictionCode: "920",
  principalCode: "471190",
  posMap: { 3: "492110" },
  activities: [
    { code: "471190", description: "Venta minorista", rate: D("3"), exempt: false },
    { code: "492110", description: "Transporte", rate: D("1.5"), exempt: false },
    { code: "620100", description: "Servicios informáticos", rate: null, exempt: false },
    { code: "851010", description: "Enseñanza", rate: null, exempt: true },
  ],
};

describe("resolveActivity: manual → punto de venta → principal", () => {
  it("la corrección manual manda", () => {
    expect(resolveActivity({ pointOfSale: 3, manualCode: "620100" }, cfg)).toEqual({ code: "620100", source: "MANUAL" });
  });
  it("sin manual, el punto de venta asignado", () => {
    expect(resolveActivity({ pointOfSale: 3, manualCode: null }, cfg)).toEqual({ code: "492110", source: "POS" });
  });
  it("sin manual ni PDV asignado, la principal", () => {
    expect(resolveActivity({ pointOfSale: 1, manualCode: null }, cfg)).toEqual({ code: "471190", source: "PRINCIPAL" });
  });
  it("un código que ya no está en la ficha se ignora", () => {
    expect(resolveActivity({ pointOfSale: 1, manualCode: "999999" }, cfg)).toEqual({ code: "471190", source: "PRINCIPAL" });
  });
  it("sin principal ni PDV: sin actividad", () => {
    expect(resolveActivity({ pointOfSale: 1, manualCode: null }, { ...cfg, principalCode: null })).toEqual({ code: null, source: "NONE" });
  });
});

describe("iibbByActivity", () => {
  it("suma por actividad con su alícuota y redondea por actividad", () => {
    const r = iibbByActivity(
      [
        { pointOfSale: 1, manualCode: null, base: D("1000.00") },
        { pointOfSale: 3, manualCode: null, base: D("333.33") },
        { pointOfSale: 1, manualCode: null, base: D("-100.00") }, // nota de crédito
      ],
      cfg,
      D("3.5"),
    );
    expect(r.lines.map((l) => [l.code, l.base.toFixed(2), l.rate.toString(), l.tax.toFixed(2), l.rateSource])).toEqual([
      ["471190", "900.00", "3", "27.00", "ACTIVITY"],
      ["492110", "333.33", "1.5", "5.00", "ACTIVITY"],
    ]);
    expect(r.base.toFixed(2)).toBe("1233.33");
    expect(r.tax.toFixed(2)).toBe("32.00");
    expect(r.warnings).toEqual([]);
  });

  it("actividad exenta: alícuota 0 sin advertencia", () => {
    const r = iibbByActivity([{ pointOfSale: 1, manualCode: "851010", base: D("500") }], cfg, D("3.5"));
    expect(r.lines[0]).toMatchObject({ code: "851010", rateSource: "EXEMPT" });
    expect(r.tax.toFixed(2)).toBe("0.00");
    expect(r.warnings).toEqual([]);
  });

  it("actividad sin alícuota: usa la de respaldo y lo advierte", () => {
    const r = iibbByActivity([{ pointOfSale: 1, manualCode: "620100", base: D("200") }], cfg, D("3.5"));
    expect(r.lines[0]).toMatchObject({ code: "620100", rateSource: "FALLBACK" });
    expect(r.tax.toFixed(2)).toBe("7.00");
    expect(r.warnings[0]).toContain("620100");
  });

  it("sin actividad principal: ventas sin actividad a la alícuota de respaldo, con dos advertencias", () => {
    const r = iibbByActivity([{ pointOfSale: 1, manualCode: null, base: D("100") }], { ...cfg, principalCode: null }, D("3.5"));
    expect(r.lines[0]).toMatchObject({ code: null, rateSource: "FALLBACK", sources: ["NONE"] });
    expect(r.warnings).toHaveLength(2);
  });

  it("alícuota efectiva = impuesto / base", () => {
    const r = iibbByActivity(
      [
        { pointOfSale: 1, manualCode: null, base: D("100") },
        { pointOfSale: 3, manualCode: null, base: D("100") },
      ],
      cfg,
      D("3.5"),
    );
    expect(r.effectiveRate.toString()).toBe("2.25");
  });
});

describe("computeLiquidation con IIBB por actividad", () => {
  const base: PeriodForCalc = {
    client: { defaultIibbRate: D("3.5") },
    invoices: [{ category: "SALES", netAmount: D("1100.00"), vatAmount: D("231.00"), totalAmount: D("1331.00") }],
    taxRecords: [],
  };

  it("usa el detalle por actividad cuando cuadra con la base del período", () => {
    const r = computeLiquidation({
      ...base,
      iibbActivities: {
        config: cfg,
        slices: [
          { pointOfSale: 1, manualCode: null, base: D("1000.00") },
          { pointOfSale: 3, manualCode: null, base: D("100.00") },
        ],
      },
    });
    expect(r.iibb.byActivity).toHaveLength(2);
    expect(r.iibb.tax.toFixed(2)).toBe("31.50");
  });

  it("sin detalle por actividad sigue la alícuota única", () => {
    const r = computeLiquidation(base);
    expect(r.iibb.byActivity).toBeNull();
    expect(r.iibb.tax.toFixed(2)).toBe("38.50");
  });

  it("si la base por actividad no cuadra, falla cerrado", () => {
    expect(() =>
      computeLiquidation({ ...base, iibbActivities: { config: cfg, slices: [{ pointOfSale: 1, manualCode: null, base: D("999.99") }] } }),
    ).toThrow();
  });
});

describe("validación de entradas", () => {
  const codes = ["471190", "492110"];
  it("config: principal y PDV válidos", () => {
    expect(buildActivityConfigInput({ principalCode: "471190", pos: [{ pointOfSale: 3, activityCode: "492110" }] }, codes)).toEqual({
      ok: true,
      value: { principalCode: "471190", pos: [{ pointOfSale: 3, activityCode: "492110" }] },
    });
  });
  it("config: rechaza actividad ajena, PDV repetido y campos extra", () => {
    expect(buildActivityConfigInput({ principalCode: "999999", pos: [] }, codes).ok).toBe(false);
    expect(buildActivityConfigInput({ principalCode: null, pos: [{ pointOfSale: 3, activityCode: "471190" }, { pointOfSale: 3, activityCode: "492110" }] }, codes).ok).toBe(false);
    expect(buildActivityConfigInput({ principalCode: null, pos: [], extra: 1 }, codes).ok).toBe(false);
    expect(buildActivityConfigInput({ principalCode: null, pos: [{ pointOfSale: 0, activityCode: "471190" }] }, codes).ok).toBe(false);
  });
  it("asignación: acepta null (quitar corrección) y rechaza códigos ajenos", () => {
    expect(buildActivityAssignmentInput({ assignments: [{ invoiceId: "cabcdefghij123", code: null }] }, codes).ok).toBe(true);
    expect(buildActivityAssignmentInput({ assignments: [{ invoiceId: "cabcdefghij123", code: "999999" }] }, codes).ok).toBe(false);
    expect(buildActivityAssignmentInput({ assignments: [] }, codes).ok).toBe(false);
  });
});
