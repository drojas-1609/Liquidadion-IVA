import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { serializeInvoice, serializeClient, serializeTaxRecord } from "@/lib/serializers";

const D = (v: string) => new Prisma.Decimal(v);

describe("lib/serializers (caso 12: JSON -> string, serialización explícita)", () => {
  it("serializeInvoice expone todos los decimales como string", () => {
    const dto = serializeInvoice({
      id: "i1",
      date: new Date("2026-01-15T00:00:00.000Z"),
      type: "FC A",
      pointOfSale: 1,
      number: 1001,
      entityName: "Cliente Ejemplo SRL",
      entityCuit: "30-99999999-5",
      netAmount: D("1000"),
      vatRate: D("21"),
      vatAmount: D("210"),
      totalAmount: D("1210"),
      category: "SALES",
      periodId: "p1",
    });

    for (const k of ["netAmount", "vatRate", "vatAmount", "totalAmount"] as const) {
      expect(typeof dto[k], k).toBe("string");
    }
    expect(dto.netAmount).toBe("1000.00");
    expect(dto.vatAmount).toBe("210.00");
    expect(dto.totalAmount).toBe("1210.00");
    expect(dto.vatRate).toBe("21");

    // round-trip JSON estable
    const parsed = JSON.parse(JSON.stringify(dto));
    expect(parsed.netAmount).toBe("1000.00");
    expect(typeof parsed.totalAmount).toBe("string");
  });

  it("serializeInvoice: columnas del PR B; NULL en filas heredadas sin esas columnas", () => {
    const base = {
      id: "i1",
      date: new Date("2026-01-15T00:00:00.000Z"),
      type: "FC A",
      pointOfSale: 1,
      number: 1001,
      entityName: "Cliente Ejemplo SRL",
      entityCuit: "30-99999999-5",
      netAmount: D("1000"),
      vatRate: D("21"),
      vatAmount: D("210"),
      totalAmount: D("1210"),
      category: "SALES",
      periodId: "p1",
    };
    const legacy = serializeInvoice(base);
    expect(legacy.counterpartyVatConditionCode).toBeNull();
    expect(legacy.turivaRelationCode).toBeNull();
    expect(legacy.voucherVariant).toBeNull();

    const withNulls = serializeInvoice({ ...base, counterpartyVatConditionCode: null, turivaRelationCode: null, voucherVariant: null });
    expect(withNulls).toMatchObject({ counterpartyVatConditionCode: null, turivaRelationCode: null, voucherVariant: null });

    const modeled = serializeInvoice({
      ...base,
      voucherCode: 195,
      counterpartyVatConditionCode: 5,
      turivaRelationCode: "0001",
      voucherVariant: null,
    });
    expect(modeled).toMatchObject({ counterpartyVatConditionCode: 5, turivaRelationCode: "0001", voucherVariant: null });
    expect(serializeInvoice({ ...base, voucherCode: 1, voucherVariant: "PAGO_EN_CBU_INFORMADA" }).voucherVariant).toBe(
      "PAGO_EN_CBU_INFORMADA",
    );
    // Contrato mínimo: nada de organización ni autoría.
    for (const k of ["organizationId", "createdById", "updatedById", "clientId"]) expect(modeled).not.toHaveProperty(k);
  });

  it("serializeClient: defaultIibbRate como string canónico", () => {
    const dto = serializeClient({
      id: "c1",
      name: "X SA",
      cuit: "30-11111111-8",
      condition: "Responsable Inscripto",
      address: null,
      defaultIibbRate: D("3.523456"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(typeof dto.defaultIibbRate).toBe("string");
    expect(dto.defaultIibbRate).toBe("3.523456");
  });

  it("serializeTaxRecord: amount como string 2 decimales", () => {
    const dto = serializeTaxRecord({
      id: "t1",
      date: new Date("2026-01-10T00:00:00.000Z"),
      type: "RETENCION IVA",
      amount: D("25000"),
      description: "Banco Galicia",
      periodId: "p1",
    });
    expect(typeof dto.amount).toBe("string");
    expect(dto.amount).toBe("25000.00");
  });
});
