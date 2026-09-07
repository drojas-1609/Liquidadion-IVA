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
      entityCuit: "30-99999999-1",
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

  it("serializeClient: defaultIibbRate como string canónico", () => {
    const dto = serializeClient({
      id: "c1",
      name: "X SA",
      cuit: "30-1",
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
