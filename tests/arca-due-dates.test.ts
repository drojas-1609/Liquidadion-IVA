import { describe, it, expect } from "vitest";
import { daysUntil, lastCuitDigit, monthDueDates, upcomingDueDates } from "@/lib/calendar/arca-due-dates";

const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(0, 10));

describe("vencimientos ARCA (RG 4172 + corrimiento)", () => {
  it("reproduce el calendario publicado de noviembre de 2026", () => {
    expect(iso(monthDueDates("IVA", 2026, 11))).toEqual(["2026-11-18", "2026-11-19", "2026-11-20", "2026-11-24", "2026-11-25"]);
    expect(iso(monthDueDates("SUSS", 2026, 11))).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
  });

  it("nunca asigna dos terminaciones al mismo día y saltea fines de semana y feriados", () => {
    const dec = iso(monthDueDates("IVA", 2026, 12));
    expect(new Set(dec).size).toBe(dec.length);
    for (const d of dec) expect([0, 6]).not.toContain(new Date(`${d}T00:00:00Z`).getUTCDay());
    expect(iso(monthDueDates("SUSS", 2026, 12))[1]).toBe("2026-12-10");
  });

  it("toma la terminación del CUIT y arma los próximos vencimientos con su período", () => {
    expect(lastCuitDigit("20-32270493-4")).toBe(4);
    expect(lastCuitDigit("123")).toBeNull();
    const list = upcomingDueDates({ cuit: "20-32270493-4", obligations: ["IVA", "SUSS"], from: new Date(Date.UTC(2026, 10, 19)), days: 30 });
    expect(list.map((d) => [d.label, d.date, d.period])).toEqual([
      ["IVA", "2026-11-20", "10/2026"],
      ["F.931 (SUSS)", "2026-12-10", "11/2026"],
    ]);
    // Diciembre: el 19 y 20 caen sábado y domingo; los grupos se corren en orden (18, 21, 22, 23, 24).
    expect(iso(monthDueDates("IVA", 2026, 12))).toEqual(["2026-12-18", "2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24"]);
    expect(list.every((d) => d.adjusted)).toBe(true);
  });

  it("un año sin feriados cargados queda marcado como no ajustado", () => {
    const list = upcomingDueDates({ cuit: "30-71955417-9", obligations: ["IVA"], from: new Date(Date.UTC(2027, 0, 1)), days: 30 });
    expect(list[0].period).toBe("12/2026");
    expect(list[0].adjusted).toBe(false);
  });

  it("cuenta días corridos", () => {
    expect(daysUntil("2026-11-20", new Date(Date.UTC(2026, 10, 19)))).toBe(1);
    expect(daysUntil("2026-11-19", new Date(Date.UTC(2026, 10, 19)))).toBe(0);
  });
});
