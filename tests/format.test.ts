import { describe, it, expect, afterEach } from "vitest";
import { formatIsoDate } from "@/lib/format";
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
