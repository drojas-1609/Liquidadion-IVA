import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  TAX_RECORD_TYPES,
  describeTaxRecordType,
  isTaxRecordType,
  taxRecordTypeLabel,
  type TaxRecordType,
} from "@/lib/tax-types";
import { computeLiquidation } from "@/lib/liquidation-calc";

const D = (v: string) => new Prisma.Decimal(v);

describe("lib/tax-types — catálogo cerrado de retenciones/percepciones", () => {
  it("valores, rótulos, impuesto y naturaleza exactos, en orden", () => {
    expect(TAX_RECORD_TYPES).toEqual([
      { value: "RETENCION IVA", label: "Retención IVA", tax: "IVA", nature: "RETENCION" },
      { value: "PERCEPCION IVA", label: "Percepción IVA", tax: "IVA", nature: "PERCEPCION" },
      { value: "RETENCION IIBB", label: "Retención IIBB", tax: "IIBB", nature: "RETENCION" },
      { value: "PERCEPCION IIBB", label: "Percepción IIBB", tax: "IIBB", nature: "PERCEPCION" },
      { value: "SIRCREB", label: "SIRCREB (recaudación bancaria IIBB)", tax: "IIBB", nature: "RECAUDACION" },
      { value: "SIRTAC", label: "SIRTAC (recaudación tarjetas IIBB)", tax: "IIBB", nature: "RECAUDACION" },
    ]);
  });

  it("es inmutable en tiempo de ejecución", () => {
    expect(Object.isFrozen(TAX_RECORD_TYPES)).toBe(true);
    for (const t of TAX_RECORD_TYPES) expect(Object.isFrozen(t)).toBe(true);
  });

  it("isTaxRecordType: los seis valores; nada más (vacío, desconocido, mayúsculas, espacios, no-string)", () => {
    for (const t of TAX_RECORD_TYPES) expect(isTaxRecordType(t.value)).toBe(true);
    for (const bad of ["", " ", "OTRO", "retencion iva", "Retencion IVA", " RETENCION IVA", "RETENCION IVA ", "RETENCIÓN IVA", "Sircreb", null, undefined, 1, {}]) {
      expect(isTaxRecordType(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("taxRecordTypeLabel: rótulo de cada tipo; fuera del catálogo lanza", () => {
    for (const t of TAX_RECORD_TYPES) expect(taxRecordTypeLabel(t.value)).toBe(t.label);
    expect(() => taxRecordTypeLabel("OTRO" as TaxRecordType)).toThrow();
  });

  it("describeTaxRecordType: conocido -> entrada completa; desconocido -> conserva el valor original tal cual", () => {
    expect(describeTaxRecordType("SIRCREB")).toEqual({
      known: true, value: "SIRCREB", label: "SIRCREB (recaudación bancaria IIBB)", tax: "IIBB", nature: "RECAUDACION",
    });
    for (const raw of ["RETENCION GANANCIAS", "retencion iva", "  RETENCION IVA ", ""]) {
      expect(describeTaxRecordType(raw)).toEqual({ known: false, value: raw });
    }
  });

  it("los seis tipos se clasifican en la liquidación vigente igual que en el catálogo (sin tocar el cálculo)", () => {
    for (const t of TAX_RECORD_TYPES) {
      const r = computeLiquidation({ client: { defaultIibbRate: D("3") }, invoices: [], taxRecords: [{ type: t.value, amount: D("10.00") }] });
      expect([r.iva.retentions.toFixed(2), r.iibb.retentions.toFixed(2)], t.value).toEqual(
        t.tax === "IVA" ? ["10.00", "0.00"] : ["0.00", "10.00"],
      );
    }
  });
});
