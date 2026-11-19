import { describe, it, expect } from "vitest";
import { activityLabel, buildAlerts, obligationsFor, todayInArgentina } from "@/lib/client-dashboard/extras";

const today = new Date(Date.UTC(2026, 10, 19));
const base = { clientId: "c1", today, mipymeValidUntil: null, mipymeCategory: null, hasChart: true, isEmployer: false, payrollZoneCode: null, backupErrors: 0, openPeriods: [] };

describe("resumen del cliente", () => {
  it("hoy en Argentina (UTC-3)", () => {
    expect(todayInArgentina(new Date("2026-11-20T02:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-19");
    expect(todayInArgentina(new Date("2026-11-20T04:00:00Z")).toISOString().slice(0, 10)).toBe("2026-11-20");
  });

  it("obligaciones: IVA sólo para responsable inscripto; F.931 si es empleador", () => {
    expect(obligationsFor({ condition: "Responsable Inscripto" }, false)).toEqual(["IVA"]);
    expect(obligationsFor({ condition: "Monotributo" }, true)).toEqual(["SUSS"]);
  });

  it("alerta el certificado MiPyME por vencer y vencido", () => {
    const soon = buildAlerts({ ...base, mipymeCategory: "MICRO", mipymeValidUntil: new Date(Date.UTC(2026, 10, 30)) });
    expect(soon).toEqual([expect.objectContaining({ level: "medium", text: expect.stringContaining("30/11/2026 (en 11 días)") })]);
    const gone = buildAlerts({ ...base, mipymeCategory: "MICRO", mipymeValidUntil: new Date(Date.UTC(2026, 9, 31)) });
    expect(gone[0]).toEqual(expect.objectContaining({ level: "high", text: expect.stringContaining("vencido") }));
  });

  it("alerta plan de cuentas, zona del empleador, respaldos y períodos viejos abiertos", () => {
    const a = buildAlerts({
      ...base,
      hasChart: false,
      isEmployer: true,
      backupErrors: 2,
      openPeriods: [
        { id: "p10", label: "10/2026", year: 2026, month: 10 },
        { id: "p09", label: "09/2026", year: 2026, month: 9 },
      ],
    });
    expect(a.map((x) => x.text)).toEqual([
      "Sin plan de cuentas: no se pueden generar asientos.",
      "Empleador sin zona del Anexo I (Ley 27.541).",
      "2 comprobante(s) sin respaldar en Drive.",
      "Período 09/2026 sigue abierto.",
    ]);
    // Sin datos (panel no disponible): no inventa alertas.
    expect(buildAlerts({ ...base, hasChart: null, isEmployer: null, backupErrors: null })).toEqual([]);
  });

  it("etiqueta las acciones de auditoría", () => {
    expect(activityLabel("payroll.f931_save")).toBe("F.931 grabado");
    expect(activityLabel("otra.cosa_rara")).toBe("otra cosa rara");
  });
});
