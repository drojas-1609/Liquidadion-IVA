import { describe, it, expect } from "vitest";
import { parseMoney, parseRate } from "@/lib/validation/decimal";

describe("lib/validation/decimal", () => {
  it("caso 5: alícuota con 6 decimales se acepta y se conserva exacta", () => {
    const r = parseRate("3.523456");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.toString()).toBe("3.523456");
  });

  it("caso 5b: alícuota como porcentaje, no coeficiente (100 se acepta, 100.000001 no)", () => {
    expect(parseRate("100").ok).toBe(true);
    expect(parseRate("0").ok).toBe(true);
    expect(parseRate("100.000001").ok).toBe(false);
    expect(parseRate("-1").ok).toBe(false);
  });

  it("caso 10: entradas vacías/inválidas rechazadas por el validador", () => {
    const bad = ["", "   ", "abc", "1,5", "1 000", "1e3", "1E3", "Infinity", "-Infinity", "NaN", "+5", "0x10", ".", "1."];
    for (const v of bad) {
      expect(parseMoney(v).ok, `parseMoney(${JSON.stringify(v)})`).toBe(false);
    }
    expect(parseMoney(null).ok).toBe(false);
    expect(parseMoney(undefined).ok).toBe(false);
    expect(parseMoney(123 as unknown).ok).toBe(false); // number: debe venir string
  });

  it("caso 11: exceso de escala se RECHAZA, no se trunca ni se redondea", () => {
    const m = parseMoney("1.234");
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error).toMatch(/decimal/i);

    const r = parseRate("1.1234567"); // 7 decimales
    expect(r.ok).toBe(false);

    // el valor válido más cercano NO se produce solo:
    expect(parseMoney("1.23").ok).toBe(true);
  });

  it("caso 11b: exceso de precisión entera se rechaza (NUMERIC(18,2) => 16 enteros)", () => {
    expect(parseMoney("9999999999999999.99").ok).toBe(true); // 16 enteros: OK
    expect(parseMoney("10000000000000000.00").ok).toBe(false); // 17 enteros: NO
  });

  it("importe: signo negativo permitido por defecto; opción allowNegative:false", () => {
    expect(parseMoney("-1500.50").ok).toBe(true);
    expect(parseMoney("-1500.50", { allowNegative: false }).ok).toBe(false);
  });
});
