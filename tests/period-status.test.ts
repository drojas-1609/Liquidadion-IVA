import { describe, it, expect } from "vitest";
import {
  canStartPeriodTransition,
  isPeriodClosed,
  isPeriodVersionString,
  nextPeriodUpdatedAt,
  periodStatusLabel,
  periodTransitionDisplay,
  periodTransitionReducer,
  PERIOD_CLOSE_IIBB_NOTICE,
  PERIOD_CLOSE_SCOPE_NOTICE,
  periodTransitionNotice,
  PERIOD_TRANSITION_APPLIED_MESSAGE,
  PERIOD_TRANSITION_INITIAL,
  PERIOD_TRANSITION_RELOAD_HINT_MESSAGE,
  type PeriodTransitionEvent,
  type PeriodTransitionState,
  type PeriodVersion,
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

/**
 * Lógica pura del control de cierre/reapertura (sin React ni DOM). Estos tests
 * NO ejecutan el componente: no prueban useTransition, el refresco real de
 * Next ni window.location.reload(); sólo el reducer y el aviso que el
 * componente renderiza tal cual.
 */
describe("cierre / reapertura — estado de la UI después de enviar", () => {
  const T0 = "2026-01-01T00:00:00.000Z"; // versión que vio la pantalla
  const T1 = "2026-01-01T00:00:00.001Z"; // intermedia, anterior a la confirmada
  const T2 = "2026-01-01T00:00:00.002Z"; // confirmada por la API
  const T3 = "2026-01-01T00:00:00.003Z"; // posterior
  const v = (status: "OPEN" | "CLOSED", updatedAt: string): PeriodVersion => ({ status, updatedAt });
  const BASE = v("OPEN", T0);
  const CONFIRMED = v("CLOSED", T2);

  type Ev = PeriodTransitionEvent extends infer E ? (E extends unknown ? Omit<E, "view"> : never) : never;
  const run = (from: PeriodTransitionState, view: PeriodVersion, ...events: Ev[]) =>
    events.reduce<PeriodTransitionState>((s, e) => periodTransitionReducer(s, { ...e, view } as PeriodTransitionEvent), from);
  const submitting = run(PERIOD_TRANSITION_INITIAL, BASE, { type: "open" }, { type: "start" });
  const applied = run(submitting, BASE, { type: "succeed", confirmed: CONFIRMED });
  const uncertain = run(submitting, BASE, { type: "uncertain", message: "incierto" });
  const ATTEMPTS: Ev[] = [{ type: "open" }, { type: "start" }, { type: "cancel" }, { type: "succeed", confirmed: v("OPEN", T3) }, { type: "fail", message: "x" }];
  const noticeOf = (s: PeriodTransitionState, view: PeriodVersion, refreshing: boolean) => periodTransitionNotice(periodTransitionDisplay(s, view), refreshing);

  it("flujo base: open -> confirming -> start -> submitting con la versión de la pantalla", () => {
    expect(run(PERIOD_TRANSITION_INITIAL, BASE, { type: "open" })).toEqual({ phase: "confirming" });
    expect(submitting).toEqual({ phase: "submitting", base: T0 });
    expect(run(PERIOD_TRANSITION_INITIAL, BASE, { type: "start" })).toEqual(PERIOD_TRANSITION_INITIAL);
    expect(run(PERIOD_TRANSITION_INITIAL, BASE, { type: "succeed", confirmed: CONFIRMED })).toEqual(PERIOD_TRANSITION_INITIAL);
    expect(noticeOf(PERIOD_TRANSITION_INITIAL, BASE, false)).toBeNull();
    expect(noticeOf(submitting, BASE, false)).toBeNull();
  });

  it("éxito con refresco demorado: applied, bloqueado y con recarga mientras el refresco está en curso", () => {
    expect(applied).toEqual({ phase: "applied", confirmed: CONFIRMED });
    const d = periodTransitionDisplay(applied, BASE);
    expect(d).toEqual({ kind: "applied", status: "CLOSED" });
    expect(canStartPeriodTransition(d)).toBe(false);
    expect(noticeOf(applied, BASE, true)).toEqual({ tone: "status", message: PERIOD_TRANSITION_APPLIED_MESSAGE.CLOSED, reload: true });
  });

  it("salida de recuperación sin depender del refresco: sin refresco en curso (nunca observado o ya terminado) también ofrece recargar", () => {
    // Mismo estado del reducer: no hay ningún evento de refresco que observar.
    expect(noticeOf(applied, BASE, false)).toEqual({ tone: "status", message: PERIOD_TRANSITION_RELOAD_HINT_MESSAGE.CLOSED, reload: true });
    expect(noticeOf(uncertain, BASE, false)).toEqual({ tone: "alert", message: "incierto", reload: true });
    expect(noticeOf(uncertain, BASE, true)).toEqual({ tone: "alert", message: "incierto", reload: true });
    // Y sigue bloqueado: la recarga es la única salida mientras las props no cambien.
    expect(run(applied, BASE, ...ATTEMPTS)).toEqual(applied);
  });

  it.each([
    ["misma versión base", v("OPEN", T0)],
    ["intermedia abierta", v("OPEN", T1)],
    ["intermedia cerrada", v("CLOSED", T1)],
    ["misma versión con otro estado", v("OPEN", T2)],
    ["versión inválida", v("CLOSED", "2026-01-01T00:00:00Z")],
  ])("props anteriores o no verificables (%s) -> sigue applied, con recarga", (_l, view) => {
    expect(periodTransitionDisplay(applied, view).kind).toBe("applied");
    expect(run(applied, view, { type: "open" })).toEqual(applied);
    expect(noticeOf(applied, view, false)?.reload).toBe(true);
  });

  it.each([
    ["coincidentes (estado y versión confirmados)", v("CLOSED", T2)],
    ["posteriores cerradas", v("CLOSED", T3)],
    ["posteriores reabiertas por otra persona", v("OPEN", T3)],
  ])("props %s -> idle y se puede volver a operar con la versión nueva", (_l, view) => {
    expect(periodTransitionDisplay(applied, view)).toEqual({ kind: "idle" });
    expect(noticeOf(applied, view, false)).toBeNull();
    expect(run(applied, view, { type: "open" })).toEqual({ phase: "confirming" });
    expect(run(applied, view, { type: "open" }, { type: "start" })).toEqual({ phase: "submitting", base: view.updatedAt });
  });

  it("200 idempotente: la vista ya coincide con lo confirmado -> idle sin esperar otra versión", () => {
    const sameView = v("CLOSED", T0);
    const s = run(PERIOD_TRANSITION_INITIAL, sameView, { type: "open" }, { type: "start" }, { type: "succeed", confirmed: v("CLOSED", T0) });
    expect(s).toEqual(PERIOD_TRANSITION_INITIAL);
  });

  it("resultado incierto (incluye 200 incompleto): bloquea hasta ver una versión posterior a la enviada", () => {
    expect(uncertain).toEqual({ phase: "uncertain", base: T0, message: "incierto" });
    expect(periodTransitionDisplay(uncertain, BASE)).toEqual({ kind: "uncertain", message: "incierto" });
    expect(canStartPeriodTransition(periodTransitionDisplay(uncertain, BASE))).toBe(false);
    expect(run(uncertain, BASE, ...ATTEMPTS)).toEqual(uncertain);
    expect(run(uncertain, v("CLOSED", T0), { type: "open" })).toEqual(uncertain);
    expect(run(uncertain, v("OPEN", T1), { type: "open" })).toEqual({ phase: "confirming" });
    expect(run(uncertain, v("CLOSED", T1), { type: "open" })).toEqual({ phase: "confirming" });
  });

  it("error definido: permite volver a intentar, sin aviso de recarga; no se confunde con incierto", () => {
    const failed = run(submitting, BASE, { type: "fail", message: "ocupado" });
    expect(failed).toEqual({ phase: "error", message: "ocupado" });
    const d = periodTransitionDisplay(failed, BASE);
    expect(d).toEqual({ kind: "error", message: "ocupado" });
    expect(canStartPeriodTransition(d)).toBe(true);
    expect(periodTransitionNotice(d, false)).toBeNull();
    expect(run(failed, BASE, { type: "open" }, { type: "start" })).toEqual({ phase: "submitting", base: T0 });
    expect(run(failed, BASE, { type: "cancel" })).toEqual(PERIOD_TRANSITION_INITIAL);
  });

  it("no se puede repetir la mutación mientras esté bloqueada (applied, uncertain, submitting)", () => {
    for (const blocked of [applied, uncertain, submitting]) {
      expect(run(blocked, BASE, { type: "open" }, { type: "start" })).toEqual(blocked);
      expect(canStartPeriodTransition(periodTransitionDisplay(blocked, BASE))).toBe(false);
    }
  });

  it("mensajes de éxito confirmado: separados de incierto, con tilde, sin afirmar un fallo", () => {
    for (const status of ["OPEN", "CLOSED"] as const) {
      expect(PERIOD_TRANSITION_APPLIED_MESSAGE[status]).toMatch(/Actualizando la pantalla/);
      expect(PERIOD_TRANSITION_RELOAD_HINT_MESSAGE[status]).toMatch(/recargá la página/);
      for (const m of [PERIOD_TRANSITION_APPLIED_MESSAGE[status], PERIOD_TRANSITION_RELOAD_HINT_MESSAGE[status]]) {
        expect(m).not.toMatch(/[Pp]eriodo|No se pudo confirmar|no se actualizó/);
      }
    }
  });

  it.each([
    [T2, true],
    ["2026-01-01T00:00:00Z", false],
    ["2026-02-30T00:00:00.000Z", false],
    ["2026-01-01T00:00:00.000+00:00", false],
    [1767225600000, false],
    [null, false],
  ])("isPeriodVersionString(%s) = %s", (value, expected) => {
    expect(isPeriodVersionString(value)).toBe(expected);
  });
});
