import { describe, it, expect } from "vitest";
import {
  PERIOD_MIN_YEAR,
  MONTH_NAMES,
  periodYearRange,
  periodYearOptions,
  isValidPeriodMonth,
  isValidPeriodYear,
  formatPeriodKey,
  formatPeriodLabel,
} from "@/lib/period";

// 31/12/2026 23:30 en Argentina (UTC-3) == 01/01/2027 02:30 UTC.
const NEW_YEAR_EVE_AR = new Date("2027-01-01T02:30:00.000Z");

describe("lib/period — rango de años (UTC)", () => {
  it("2000 .. año UTC + 1", () => {
    expect(periodYearRange(new Date("2026-06-15T12:00:00Z"))).toEqual({ min: 2000, max: 2027 });
    expect(PERIOD_MIN_YEAR).toBe(2000);
  });

  it("usa el año UTC, no el local (víspera de Año Nuevo en Argentina)", () => {
    expect(periodYearRange(NEW_YEAR_EVE_AR).max).toBe(2028);
  });

  it("opciones del formulario: descendentes, completas y con los mismos extremos que la API", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const opts = periodYearOptions(now);
    expect(opts[0]).toBe(2027);
    expect(opts[opts.length - 1]).toBe(2000);
    expect(opts).toHaveLength(28);
    expect([...opts].sort((a, b) => b - a)).toEqual(opts);
    for (const y of opts) expect(isValidPeriodYear(y, now)).toBe(true);
  });

  it.each([
    [1999, false],
    [2000, true],
    [2027, true],
    [2028, false],
    [2026.5, false],
    [Number.NaN, false],
  ])("isValidPeriodYear(%s) -> %s", (year, ok) => {
    expect(isValidPeriodYear(year, new Date("2026-06-15T12:00:00Z"))).toBe(ok);
  });

  it.each([
    [0, false],
    [1, true],
    [12, true],
    [13, false],
    [1.5, false],
  ])("isValidPeriodMonth(%s) -> %s", (month, ok) => {
    expect(isValidPeriodMonth(month)).toBe(ok);
  });
});

describe("lib/period — formatos canónicos", () => {
  it("clave YYYY-MM con mes a dos dígitos", () => {
    expect(formatPeriodKey({ year: 2026, month: 3 })).toBe("2026-03");
    expect(formatPeriodKey({ year: 2026, month: 12 })).toBe("2026-12");
  });

  it("la clave ordena lexicográficamente igual que cronológicamente", () => {
    const keys = [
      { year: 2026, month: 10 },
      { year: 2025, month: 12 },
      { year: 2026, month: 2 },
    ].map(formatPeriodKey);
    expect([...keys].sort()).toEqual(["2025-12", "2026-02", "2026-10"]);
  });

  it("etiqueta visible MM/AAAA", () => {
    expect(formatPeriodLabel({ year: 2026, month: 5 })).toBe("05/2026");
  });

  it("12 meses en castellano", () => {
    expect(MONTH_NAMES).toHaveLength(12);
    expect(MONTH_NAMES[0]).toBe("Enero");
    expect(MONTH_NAMES[11]).toBe("Diciembre");
  });
});
