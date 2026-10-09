import { describe, it, expect } from "vitest";
import {
  isPeriodClosed,
  nextPeriodUpdatedAt,
  periodStatusLabel,
  PERIOD_CLOSE_IIBB_NOTICE,
  PERIOD_CLOSE_SCOPE_NOTICE,
} from "@/lib/period-status";
import { buildPeriodTransitionInput, PERIOD_EXPECTED_UPDATED_AT_ERROR } from "@/lib/api-input";

describe("lib/period-status", () => {
  it("isPeriodClosed: sólo CLOSED", () => {
    expect(isPeriodClosed("CLOSED")).toBe(true);
    for (const s of ["OPEN", "closed", "", "ARCHIVED"]) expect(isPeriodClosed(s)).toBe(false);
  });

  it("etiquetas", () => {
    expect(periodStatusLabel("OPEN")).toBe("Abierto");
    expect(periodStatusLabel("CLOSED")).toBe("Cerrado");
  });

  it("los avisos describen el alcance y NO presentan el cierre como liquidación inmutable", () => {
    expect(PERIOD_CLOSE_SCOPE_NOTICE).toMatch(/consultar y exportar/);
    expect(PERIOD_CLOSE_IIBB_NOTICE).toMatch(/no congela la liquidación/);
    expect(PERIOD_CLOSE_IIBB_NOTICE).toMatch(/alícuota IIBB vigente del cliente/);
    expect(`${PERIOD_CLOSE_SCOPE_NOTICE} ${PERIOD_CLOSE_IIBB_NOTICE}`).not.toMatch(/inmutable|definitiv/i);
  });

  it.each([
    ["ahora posterior", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z"],
    ["mismo milisegundo", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.001Z"],
    ["reloj atrasado", "2026-01-01T00:00:00.500Z", "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.501Z"],
  ])("nextPeriodUpdatedAt: %s -> siempre estrictamente posterior a la versión previa", (_l, prev, now, expected) => {
    const next = nextPeriodUpdatedAt(new Date(prev), new Date(now));
    expect(next.toISOString()).toBe(expected);
    expect(next.getTime()).toBeGreaterThan(new Date(prev).getTime());
  });
});

describe("buildPeriodTransitionInput", () => {
  it("acepta el ISO exacto con milisegundos e ignora otras claves (el destino lo define la ruta)", () => {
    const r = buildPeriodTransitionInput({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z", status: "OPEN", organizationId: "x" });
    expect(r).toEqual({ ok: true, data: { expectedUpdatedAt: new Date("2026-01-01T00:00:00.000Z") } });
  });

  it.each([
    ["ausente", {}],
    ["null", { expectedUpdatedAt: null }],
    ["sin milisegundos", { expectedUpdatedAt: "2026-01-01T00:00:00Z" }],
    ["con zona", { expectedUpdatedAt: "2026-01-01T00:00:00.000-03:00" }],
    ["fecha inexistente", { expectedUpdatedAt: "2026-02-30T00:00:00.000Z" }],
    ["número", { expectedUpdatedAt: 1767225600000 }],
  ])("expectedUpdatedAt %s -> 422 expectedUpdatedAt", (_l, body) => {
    expect(buildPeriodTransitionInput(body)).toEqual({
      ok: false,
      status: 422,
      field: "expectedUpdatedAt",
      error: PERIOD_EXPECTED_UPDATED_AT_ERROR,
    });
  });

  it.each([["null", null], ["array", []], ["string", "x"]])("cuerpo %s -> 422 body", (_l, body) => {
    expect(buildPeriodTransitionInput(body)).toMatchObject({ ok: false, status: 422, field: "body" });
  });
});
