import { describe, it, expect } from "vitest";
import { buildInvoiceInput, buildTaxInput, buildClientInput, buildPeriodInput } from "@/lib/api-input";

const baseInvoice = {
  date: "2026-01-15",
  type: "FC A",
  pointOfSale: "1",
  number: "1001",
  entityName: "Cliente Ejemplo SRL",
  entityCuit: "30-99999999-1",
  category: "SALES",
  periodId: "p1",
};

describe("lib/api-input", () => {
  it("caso 13: la API IGNORA vatAmount/totalAmount del cliente y recalcula server-side", () => {
    const res = buildInvoiceInput({
      ...baseInvoice,
      netAmount: "1000",
      vatRate: "21",
      vatAmount: "999999.99", // valor mentiroso del cliente
      totalAmount: "0.01", // valor mentiroso del cliente
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.vatAmount.toFixed(2)).toBe("210.00");
      expect(res.data.totalAmount.toFixed(2)).toBe("1210.00");
      expect(res.data.netAmount.toFixed(2)).toBe("1000.00");
      expect(res.data.vatRate.toString()).toBe("21");
    }
  });

  it("caso 13b: recálculo con alícuota 10,5% y neto con 2 decimales", () => {
    const res = buildInvoiceInput({ ...baseInvoice, netAmount: "1234.56", vatRate: "10.5" });
    expect(res.ok).toBe(true);
    // 1234.56 * 10.5 / 100 = 129.6288 -> HALF_UP -> 129.63
    if (res.ok) {
      expect(res.data.vatAmount.toFixed(2)).toBe("129.63");
      expect(res.data.totalAmount.toFixed(2)).toBe("1364.19");
    }
  });

  it("nota de crédito: neto negativo permitido, total negativo coherente", () => {
    const res = buildInvoiceInput({ ...baseInvoice, type: "NC A", netAmount: "-1000.00", vatRate: "21" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.vatAmount.toFixed(2)).toBe("-210.00");
      expect(res.data.totalAmount.toFixed(2)).toBe("-1210.00");
    }
  });

  it("entrada inválida -> 422 con field (JSON válido, dato inválido)", () => {
    const bad = buildInvoiceInput({ ...baseInvoice, netAmount: "1.234", vatRate: "21" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.status).toBe(422);
      expect(bad.field).toBe("netAmount");
    }
    const badRate = buildInvoiceInput({ ...baseInvoice, netAmount: "1000", vatRate: "150" });
    expect(badRate.ok).toBe(false);
    if (!badRate.ok) expect(badRate.field).toBe("vatRate");
  });

  it("buildPeriodInput: forma válida -> ok", () => {
    const r = buildPeriodInput({ clientId: "c1", month: "5", year: "2026" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ clientId: "c1", month: 5, year: 2026 });
  });

  it("buildPeriodInput: clientId vacío / mes fuera de 1-12 / año fuera de rango -> 422 con field", () => {
    for (const [body, field] of [
      [{ month: 5, year: 2026 }, "clientId"],
      [{ clientId: "c1", month: 0, year: 2026 }, "month"],
      [{ clientId: "c1", month: 13, year: 2026 }, "month"],
      [{ clientId: "c1", month: "3.5", year: 2026 }, "month"],
      [{ clientId: "c1", month: "  ", year: 2026 }, "month"],
      [{ clientId: "c1", month: 5, year: 1999 }, "year"],
      [{ clientId: "c1", month: 5, year: 9999 }, "year"],
    ] as const) {
      const r = buildPeriodInput(body);
      expect(r.ok, JSON.stringify(body)).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(422);
        expect(r.field).toBe(field);
      }
    }
  });

  it("taxes: monto validado como string; exceso de escala rechazado", () => {
    expect(buildTaxInput({ date: "2026-01-10", type: "RETENCION IVA", amount: "25000.00", periodId: "p1" }).ok).toBe(true);
    const bad = buildTaxInput({ date: "2026-01-10", type: "RETENCION IVA", amount: "25000.005", periodId: "p1" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("amount");
  });

  it("clients: defaultIibbRate ausente -> 3; presente inválido -> 422", () => {
    const ok = buildClientInput({ name: "X SA", cuit: "30-1", condition: "Responsable Inscripto" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.defaultIibbRate.toString()).toBe("3");

    const ok2 = buildClientInput({ name: "X SA", cuit: "30-1", condition: "RI", defaultIibbRate: "3.5" });
    if (ok2.ok) expect(ok2.data.defaultIibbRate.toString()).toBe("3.5");

    const bad = buildClientInput({ name: "X SA", cuit: "30-1", condition: "RI", defaultIibbRate: "101" });
    expect(bad.ok).toBe(false);
  });
});
