import { describe, it, expect } from "vitest";
import {
  derivedVoucherClass,
  LEGEND_M_1000,
  LEGEND_OPERACION_SUJETA_A_RETENCION,
  RG_1575_START,
  RG_4627_START,
  RG_5762_START,
} from "@/lib/arca/voucher-legal-class";

describe("derivedVoucherClass — 051–053 por fecha (research-report.md §5)", () => {
  it("cortes normativos exactos", () => {
    expect([RG_1575_START, RG_4627_START, RG_5762_START]).toEqual(["2003-10-20", "2019-11-11", "2025-12-01"]);
  });

  it.each([[51], [52], [53]])("%s antes del 20/10/2003 -> sin clase derivada", (code) => {
    const d = derivedVoucherClass(code, "2003-10-19");
    expect(d.legalClass).toBeNull();
    expect(d.mandatoryLegend).toBeNull();
  });

  it.each([["2003-10-20"], ["2019-11-10"]])("%s -> clase M con la leyenda de $1.000", (date) => {
    const d = derivedVoucherClass(51, date);
    expect(d.legalClass).toBe("M");
    expect(d.mandatoryLegend).toBe(LEGEND_M_1000);
    expect(d.technicalLabel).toBe("FACTURAS M");
  });

  it.each([["2019-11-11"], ["2025-11-30"]])("%s -> clase M con OPERACIÓN SUJETA A RETENCIÓN", (date) => {
    const d = derivedVoucherClass(52, date);
    expect(d.legalClass).toBe("M");
    expect(d.mandatoryLegend).toBe(LEGEND_OPERACION_SUJETA_A_RETENCION);
    expect(d.technicalLabel).toBe("NOTAS DE DEBITO M");
  });

  it.each([["2025-12-01"], ["2030-01-01"]])("%s -> clase A con OPERACIÓN SUJETA A RETENCIÓN (la tabla sigue diciendo M)", (date) => {
    const d = derivedVoucherClass(53, date);
    expect(d.legalClass).toBe("A");
    expect(d.mandatoryLegend).toBe(LEGEND_OPERACION_SUJETA_A_RETENCION);
    expect(d.technicalLabel).toBe("NOTAS DE CREDITO M");
  });

  it("leyendas literales de la norma", () => {
    expect(LEGEND_M_1000).toBe("LA OPERACION IGUAL O MAYOR A UN MIL PESOS ($ 1.000.-) ESTA SUJETA A RETENCION");
    expect(LEGEND_OPERACION_SUJETA_A_RETENCION).toBe("OPERACIÓN SUJETA A RETENCIÓN");
  });
});

describe("derivedVoucherClass — otros códigos", () => {
  it("la clase es la letra técnica y no hay leyenda derivada", () => {
    expect(derivedVoucherClass(1, "2026-01-01")).toMatchObject({ legalClass: "A", mandatoryLegend: null });
    expect(derivedVoucherClass(8, "2026-01-01")).toMatchObject({ legalClass: "B", mandatoryLegend: null });
    expect(derivedVoucherClass(11, "2026-01-01")).toMatchObject({ legalClass: "C", mandatoryLegend: null });
    expect(derivedVoucherClass(19, "2026-01-01")).toMatchObject({ legalClass: "E", mandatoryLegend: null });
    expect(derivedVoucherClass(197, "2026-01-01")).toMatchObject({ legalClass: "T", mandatoryLegend: null });
  });

  it("código fuera del catálogo -> lanza", () => {
    expect(() => derivedVoucherClass(63, "2026-01-01")).toThrow();
  });
});
