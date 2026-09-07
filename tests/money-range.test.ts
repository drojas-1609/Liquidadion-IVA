import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { moneyInRange } from "@/lib/decimal";
import { parseMoney } from "@/lib/validation/decimal";
import { buildInvoiceInput, buildTaxInput } from "@/lib/api-input";

const MAX = "9999999999999999.99";
const MIN = "-9999999999999999.99";

const baseInvoice = {
  date: "2026-01-15",
  type: "FC A",
  pointOfSale: "1",
  number: "1001",
  entityName: "X",
  entityCuit: "30-1",
  category: "SALES",
  periodId: "p1",
};

describe("rango monetario NUMERIC(18,2) (punto 1)", () => {
  it("1: máximo monetario válido se acepta", () => {
    expect(moneyInRange(MAX)).toBe(true);
    expect(parseMoney(MAX).ok).toBe(true);
    expect(buildTaxInput({ date: "2026-01-01", type: "RETENCION IVA", amount: MAX, periodId: "p1" }).ok).toBe(true);
  });

  it("2: mínimo monetario válido se acepta", () => {
    expect(moneyInRange(MIN)).toBe(true);
    expect(parseMoney(MIN).ok).toBe(true);
    expect(buildTaxInput({ date: "2026-01-01", type: "RETENCION IVA", amount: MIN, periodId: "p1" }).ok).toBe(true);
  });

  it("3: un centavo por encima del máximo se rechaza (400 con field)", () => {
    const over = "10000000000000000.00";
    expect(moneyInRange(over)).toBe(false);
    const p = parseMoney(over);
    expect(p.ok).toBe(false);
    const r = buildTaxInput({ date: "2026-01-01", type: "RETENCION IVA", amount: over, periodId: "p1" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.field).toBe("amount");
    }
    // exactamente un centavo arriba de MAX:
    expect(moneyInRange(new Prisma.Decimal(MAX).plus("0.01"))).toBe(false);
  });

  it("4: un centavo por debajo del mínimo se rechaza (400 con field)", () => {
    const under = "-10000000000000000.00";
    expect(moneyInRange(under)).toBe(false);
    expect(parseMoney(under).ok).toBe(false);
    const r = buildInvoiceInput({ ...baseInvoice, type: "NC A", netAmount: under, vatRate: "0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("netAmount");
    expect(moneyInRange(new Prisma.Decimal(MIN).minus("0.01"))).toBe(false);
  });

  it("5: neto válido cuyo IVA/total provocan overflow -> 400 en vatAmount/totalAmount, no 500", () => {
    // neto dentro de rango (16 enteros), pero neto*21% desborda vatAmount.
    const net = "9999999999999999.99";
    const r = buildInvoiceInput({ ...baseInvoice, netAmount: net, vatRate: "21" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(["vatAmount", "totalAmount"]).toContain(r.field);
      expect(r.error).toMatch(/fuera de rango/i);
    }

    // neto válido, IVA ok, pero net + vat desborda el TOTAL:
    // net = 9.99e15, vat 0% -> total = net (ok). Buscamos total > MAX con vat pequeño:
    const net2 = "9999999999999999.00";
    const r2 = buildInvoiceInput({ ...baseInvoice, netAmount: net2, vatRate: "1" });
    // vat = 9999999999999999 * 1 / 100 = 99999999999999.99 -> total = 10099999999999998.99 > MAX
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.field).toBe("totalAmount");
  });

  it("6: valor negativo cuyo total excede el mínimo -> 400", () => {
    const net = "-9999999999999999.00";
    const r = buildInvoiceInput({ ...baseInvoice, type: "NC A", netAmount: net, vatRate: "1" });
    // vat = -99999999999999.99 ; total = -10099999999999998.99 < MIN
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe("totalAmount");
      expect(r.error).toMatch(/fuera de rango/i);
    }
  });

  it("7: la validación de rango NO convierte a number en ningún paso", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../lib/decimal.ts", import.meta.url), "utf8"),
    );
    // moneyInRange y las constantes de rango se definen sin Number()/parseFloat/parseInt
    const rangeBlock = src.slice(src.indexOf("export const MONEY_MAX"), src.indexOf("export function roundMoney"));
    expect(rangeBlock).not.toMatch(/\bNumber\s*\(/);
    expect(rangeBlock).not.toMatch(/parseFloat|parseInt/);
    expect(rangeBlock).not.toMatch(/\.toNumber\s*\(/);
    // y la comparación usa API de Prisma.Decimal
    expect(rangeBlock).toMatch(/greaterThanOrEqualTo|lessThanOrEqualTo/);

    // comprobación funcional: un valor fuera del rango seguro de JS number
    // igual se evalúa exacto (no se degrada por pasar por double).
    expect(moneyInRange("9999999999999999.99")).toBe(true);
    expect(moneyInRange("9999999999999999.999")).toBe(false); // > MAX por 0.009
  });
});
