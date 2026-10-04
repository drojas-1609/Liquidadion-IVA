import { describe, it, expect, afterEach } from "vitest";
import { formatIsoDate, formatUtcDate, utcDateIso } from "@/lib/format";
import { periodFirstDayIso, periodLastDayIso } from "@/lib/period";
import { isoDate } from "@/lib/invoice-model";

/**
 * Fecha contable (`Invoice.voucherDate`, `@db.Date`): Prisma la entrega como
 * medianoche UTC del día guardado. Los listados la muestran con
 * `formatIsoDate(isoDate(d))`, que NO depende de la zona horaria del proceso.
 * Antes se usaba `new Date(date).toLocaleDateString("es-AR")`, que en
 * Argentina (UTC-3) mostraba el día anterior.
 */

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("formatIsoDate", () => {
  it("AAAA-MM-DD -> DD/MM/AAAA", () => {
    expect(formatIsoDate("2026-05-31")).toBe("31/05/2026");
    expect(formatIsoDate("2026-01-01")).toBe("01/01/2026");
    expect(formatIsoDate("2024-02-29")).toBe("29/02/2024");
  });

  it("null o formato distinto de AAAA-MM-DD -> '—' (nunca 'Invalid Date')", () => {
    expect(formatIsoDate(null)).toBe("—");
    expect(formatIsoDate("")).toBe("—");
    expect(formatIsoDate("2026-5-31")).toBe("—");
    expect(formatIsoDate("31/05/2026")).toBe("—");
    expect(formatIsoDate("2026-05-31T00:00:00.000Z")).toBe("—");
  });
});

describe("fecha @db.Date: el día no cambia por zona horaria", () => {
  // Así llega de Prisma un @db.Date guardado como 2026-05-31.
  const fromDb = () => new Date("2026-05-31T00:00:00.000Z");

  it.each(["UTC", "America/Argentina/Buenos_Aires", "Pacific/Kiritimati", "Pacific/Pago_Pago"])(
    "TZ=%s -> 31/05/2026",
    (tz) => {
      process.env.TZ = tz;
      expect(formatIsoDate(isoDate(fromDb()))).toBe("31/05/2026");
    },
  );

  it("contraste: el formateo local anterior corría el día en Argentina (por eso se reemplazó)", () => {
    process.env.TZ = "America/Argentina/Buenos_Aires";
    expect(fromDb().getDate()).toBe(30); // día LOCAL: 30/05
    expect(formatIsoDate(isoDate(fromDb()))).toBe("31/05/2026"); // día contable correcto
  });
});

describe("utcDateIso / formatUtcDate — fechas de retenciones (medianoche UTC)", () => {
  it("día UTC en los límites del mes, sin depender de la zona horaria", () => {
    expect(utcDateIso(new Date("2026-05-01T00:00:00.000Z"))).toBe("2026-05-01");
    expect(utcDateIso(new Date("2026-05-31T23:59:59.999Z"))).toBe("2026-05-31");
    expect(utcDateIso(new Date("2026-06-01T00:00:00.000Z"))).toBe("2026-06-01");
    expect(formatUtcDate(new Date("2026-05-10T00:00:00.000Z"))).toBe("10/05/2026");
    expect(formatUtcDate(new Date("2024-02-29T00:00:00.000Z"))).toBe("29/02/2024");
    expect(formatUtcDate(new Date("2025-12-31T00:00:00.000Z"))).toBe("31/12/2025");
  });

  it("fecha inválida -> null / '—' (nunca 'Invalid Date' ni excepción)", () => {
    expect(utcDateIso(new Date("x"))).toBeNull();
    expect(formatUtcDate(new Date("x"))).toBe("—");
  });

  it.each(["UTC", "America/Argentina/Buenos_Aires", "Pacific/Kiritimati", "Pacific/Pago_Pago"])(
    "TZ=%s -> el mismo día (01/05/2026 y 31/05/2026)",
    (tz) => {
      process.env.TZ = tz;
      expect(formatUtcDate(new Date("2026-05-01T00:00:00.000Z"))).toBe("01/05/2026");
      expect(formatUtcDate(new Date("2026-05-31T00:00:00.000Z"))).toBe("31/05/2026");
      expect(utcDateIso(new Date("2026-05-01T00:00:00.000Z"))).toBe("2026-05-01");
    },
  );

  it("límites min/max del formulario: primer y último día del período (bisiesto y diciembre)", () => {
    expect([periodFirstDayIso({ year: 2026, month: 5 }), periodLastDayIso({ year: 2026, month: 5 })]).toEqual(["2026-05-01", "2026-05-31"]);
    expect(periodLastDayIso({ year: 2024, month: 2 })).toBe("2024-02-29");
    expect(periodLastDayIso({ year: 2026, month: 2 })).toBe("2026-02-28");
    expect([periodFirstDayIso({ year: 2025, month: 12 }), periodLastDayIso({ year: 2025, month: 12 })]).toEqual(["2025-12-01", "2025-12-31"]);
  });
});
