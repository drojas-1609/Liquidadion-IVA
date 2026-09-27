import { describe, it, expect } from "vitest";
import { buildInvoiceInput, buildTaxInput, buildClientInput, buildClientUpdateInput, buildPeriodInput } from "@/lib/api-input";

const baseInvoice = {
  date: "2026-01-15",
  type: "FC A",
  pointOfSale: "1",
  number: "1001",
  entityName: "Cliente Ejemplo SRL",
  entityCuit: "30-99999999-5",
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
      expect(res.data.vatRate?.toString()).toBe("21");
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
    const ok = buildClientInput({ name: "X SA", cuit: "30-11111111-8", condition: "Responsable Inscripto" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.defaultIibbRate.toString()).toBe("3");

    const ok2 = buildClientInput({ name: "X SA", cuit: "30-11111111-8", condition: "Responsable Inscripto", defaultIibbRate: "3.5" });
    if (ok2.ok) expect(ok2.data.defaultIibbRate.toString()).toBe("3.5");

    const bad = buildClientInput({ name: "X SA", cuit: "30-11111111-8", condition: "Responsable Inscripto", defaultIibbRate: "101" });
    expect(bad.ok).toBe(false);
  });
});

describe("buildClientInput / buildClientUpdateInput — condición fiscal", () => {
  const base = { name: "X SA", cuit: "30-11111111-8" };

  it.each([["Responsable Inscripto"], ["Monotributo"], ["Exento"], ["  Monotributo  "]])("%s -> admitida (se guarda sin espacios)", (condition) => {
    const res = buildClientInput({ ...base, condition });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.condition).toBe(condition.trim());
    const upd = buildClientUpdateInput({ condition });
    expect(upd.ok).toBe(true);
    if (upd.ok) expect(upd.data.condition).toBe(condition.trim());
  });

  it.each([["RI"], ["responsable inscripto"], ["Monotributista"], ["Consumidor Final"], ["IVA No Alcanzado"]])("%s -> 422 condition", (condition) => {
    for (const res of [buildClientInput({ ...base, condition }), buildClientUpdateInput({ condition })]) {
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.field).toBe("condition");
        expect(res.error).toBe("condición fiscal inválida (Responsable Inscripto, Monotributo, Exento)");
      }
    }
  });
});

describe("buildInvoiceInput — fecha estricta AAAA-MM-DD", () => {
  const withDate = (date: unknown) => buildInvoiceInput({ ...baseInvoice, netAmount: "1000", vatRate: "21", date });

  it.each([["2026-05-31"], ["1999-12-31"], ["2024-02-29"], ["2000-02-29"], ["0999-01-01"]])(
    "%s válida -> medianoche UTC del MISMO día (modelo y columna heredada)",
    (iso) => {
      const res = withDate(iso);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.model.voucherDate.toISOString()).toBe(`${iso}T00:00:00.000Z`);
        expect(res.data.date.toISOString()).toBe(`${iso}T00:00:00.000Z`);
      }
    },
  );

  it.each([
    ["2026-02-30", "día inexistente"],
    ["2026-02-31", "día inexistente"],
    ["2025-02-29", "29/02 de un año no bisiesto"],
    ["2100-02-29", "2100 no es bisiesto"],
    ["2026-04-31", "abril tiene 30 días"],
    ["2026-13-01", "mes inexistente"],
    ["2026-00-10", "mes cero"],
    ["2026-05-00", "día cero"],
    ["2026-05-31T23:30:00-03:00", "con hora y zona"],
    ["2026-05-31T00:00:00Z", "con hora UTC"],
    ["2026-05-31T00:00:00.000Z", "ISO completo"],
    ["2026-5-3", "sin ceros a la izquierda"],
    ["May 31 2026", "formato textual"],
    ["31/12/1999", "formato DD/MM/AAAA"],
    ["2026/05/31", "separador /"],
    [" 2026-05-31", "espacio inicial"],
    ["2026-05-31 ", "espacio final"],
    ["+002026-05-31", "año extendido"],
  ])("%s (%s) -> 422 date", (date) => {
    const res = withDate(date);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(422);
      expect(res.field).toBe("date");
      expect(res.error).toBe("fecha inválida: debe ser AAAA-MM-DD y existir en el calendario");
    }
  });

  it("fecha ausente, vacía o no-texto -> 422 date (fecha requerida)", () => {
    for (const date of [undefined, "", "   ", 20260531, null]) {
      const res = withDate(date);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.field).toBe("date");
        expect(res.error).toBe("fecha requerida");
      }
    }
  });
});
