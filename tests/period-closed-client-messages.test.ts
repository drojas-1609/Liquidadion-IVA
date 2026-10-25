import { describe, it, expect, vi } from "vitest";
import { PERIOD_CLOSED_MESSAGE } from "@/lib/auth/errors";
import {
  deletePeriodErrorMessage,
  periodTransitionErrorMessage,
  submitPeriodTransition,
  PERIOD_NOT_FOUND_ERROR,
  PERIOD_TRANSITION_FORBIDDEN_ERROR,
  PERIOD_TRANSITION_GENERIC_ERROR,
  PERIOD_TRANSITION_STALE_ERROR,
  PERIOD_TRANSITION_UNCERTAIN_ERROR,
} from "@/lib/period-mutations";
import { taxErrorFeedback } from "@/lib/tax-form-client";
import { invoiceDeleteFeedback, invoiceErrorFeedback, invoiceUpdateErrorFeedback } from "@/lib/invoice-form-client";
import { turivaSettingErrorMessage } from "@/lib/turiva-setting";

/**
 * Un 409 PERIOD_CLOSED (pantalla cargada antes del cierre) se muestra con el
 * mensaje EXACTO de la API en todos los formularios y acciones, nunca como un
 * conflicto de concurrencia ("stale") ni como duplicado.
 */
const CLOSED = { error: { code: "PERIOD_CLOSED", message: PERIOD_CLOSED_MESSAGE } };

describe("409 PERIOD_CLOSED en los clientes de la UI", () => {
  it.each([["create"], ["update"], ["delete"]] as const)("retenciones (%s): mensaje exacto, general y no stale", (op) => {
    expect(taxErrorFeedback(op, 409, CLOSED)).toEqual({ message: PERIOD_CLOSED_MESSAGE, field: null, stale: false });
  });

  it("comprobantes: alta, edición (no stale) y baja muestran el mensaje exacto", () => {
    expect(invoiceErrorFeedback(409, CLOSED).message).toBe(PERIOD_CLOSED_MESSAGE);
    const update = invoiceUpdateErrorFeedback(409, CLOSED);
    expect(update.message).toBe(PERIOD_CLOSED_MESSAGE);
    expect((update as { stale?: boolean }).stale ?? false).toBe(false);
    expect(invoiceDeleteFeedback(409, CLOSED)).toMatchObject({ message: PERIOD_CLOSED_MESSAGE, stale: false });
  });

  it("TurIVA y baja del período: mensaje exacto (no 'tiene movimientos')", () => {
    expect(turivaSettingErrorMessage(409, CLOSED)).toBe(PERIOD_CLOSED_MESSAGE);
    expect(deletePeriodErrorMessage(CLOSED)).toBe(PERIOD_CLOSED_MESSAGE);
  });
});

describe("cerrar / reabrir — traducción de errores y cuerpo enviado", () => {
  it.each([["close"], ["reopen"]] as const)("%s: CONFLICT -> stale; FORBIDDEN / NOT_FOUND / INTERNAL / sin cuerpo; PERIOD_BUSY exacto", (t) => {
    const err = (code: string, message = "m") => ({ error: { code, message } });
    expect(periodTransitionErrorMessage(t, err("CONFLICT"))).toBe(PERIOD_TRANSITION_STALE_ERROR);
    expect(periodTransitionErrorMessage(t, err("FORBIDDEN"))).toBe(PERIOD_TRANSITION_FORBIDDEN_ERROR[t]);
    expect(periodTransitionErrorMessage(t, err("NOT_FOUND"))).toBe(PERIOD_NOT_FOUND_ERROR);
    expect(periodTransitionErrorMessage(t, err("INTERNAL", "detalle"))).toBe(PERIOD_TRANSITION_GENERIC_ERROR[t]);
    expect(periodTransitionErrorMessage(t, null)).toBe(PERIOD_TRANSITION_GENERIC_ERROR[t]);
    expect(periodTransitionErrorMessage(t, err("PERIOD_BUSY", "ocupado"))).toBe("ocupado");
  });

  const V2 = "2026-01-01T00:00:00.002Z";
  const okBody = (t: "close" | "reopen", over: Record<string, unknown> = {}) =>
    JSON.stringify({ periodId: "p/1", status: t === "close" ? "CLOSED" : "OPEN", updatedAt: V2, ...over });
  const fetchOf = (res: () => Response) => vi.fn(async () => res()) as unknown as typeof fetch;

  it.each([["close"], ["reopen"]] as const)("%s: POST a /api/periods/<id>/%s con { expectedUpdatedAt } EXACTO; 200 autoritativo -> confirmed", async (t) => {
    const fetchImpl = vi.fn(async () => new Response(okBody(t), { status: 200 }));
    const r = await submitPeriodTransition(t, "p/1", "2026-01-01T00:00:00.000Z", fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, confirmed: { status: t === "close" ? "CLOSED" : "OPEN", updatedAt: V2 } });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/periods/p%2F1/${t}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }),
    });
  });

  it.each([
    ["cuerpo vacío", "{}"],
    ["sin cuerpo", ""],
    ["HTML (p. ej. redirección al SSO)", "<html></html>"],
    ["otro periodId", okBody("close", { periodId: "p_otro" })],
    ["estado de la otra transición", okBody("close", { status: "OPEN" })],
    ["estado desconocido", okBody("close", { status: "ARCHIVED" })],
    ["updatedAt sin milisegundos", okBody("close", { updatedAt: "2026-01-01T00:00:00Z" })],
    ["updatedAt inexistente", okBody("close", { updatedAt: "2026-02-30T00:00:00.000Z" })],
    ["updatedAt numérico", okBody("close", { updatedAt: 1767225600002 })],
  ])("200 incompleto (%s) -> incierto, nunca éxito confirmado", async (_l, body) => {
    const r = await submitPeriodTransition("close", "p/1", "2026-01-01T00:00:00.000Z", fetchOf(() => new Response(body, { status: 200 })));
    expect(r).toEqual({ ok: false, uncertain: true, message: PERIOD_TRANSITION_UNCERTAIN_ERROR.close });
  });

  it.each([
    [409, "CONFLICT", PERIOD_TRANSITION_STALE_ERROR],
    [409, "PERIOD_BUSY", "ocupado"],
    [403, "FORBIDDEN", PERIOD_TRANSITION_FORBIDDEN_ERROR.reopen],
    [404, "NOT_FOUND", PERIOD_NOT_FOUND_ERROR],
    [401, "UNAUTHENTICATED", "ocupado"],
  ])("error definido %i %s -> no incierto, mensaje traducido", async (status, code, message) => {
    const body = JSON.stringify({ error: { code, message: code === "PERIOD_BUSY" || code === "UNAUTHENTICATED" ? "ocupado" : "m" } });
    const r = await submitPeriodTransition("reopen", "p/1", "2026-01-01T00:00:00.000Z", fetchOf(() => new Response(body, { status })));
    expect(r).toEqual({ ok: false, uncertain: false, message });
  });

  it.each([
    ["503 sin cuerpo", () => new Response("", { status: 503 })],
    ["500 INTERNAL con cuerpo", () => new Response(JSON.stringify({ error: { code: "INTERNAL", message: "x" } }), { status: 500 })],
    ["502 HTML", () => new Response("<html>bad gateway</html>", { status: 502 })],
    ["409 ilegible", () => new Response("no-json", { status: 409 })],
  ])("resultado incierto: %s", async (_l, res) => {
    const r = await submitPeriodTransition("close", "p_a", "2026-01-01T00:00:00.000Z", fetchOf(res));
    expect(r).toEqual({ ok: false, uncertain: true, message: PERIOD_TRANSITION_UNCERTAIN_ERROR.close });
  });

  it("error de red -> incierto (el servidor pudo haber aplicado el cambio)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await submitPeriodTransition("close", "p_a", "2026-01-01T00:00:00.000Z", fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      uncertain: true,
      message: PERIOD_TRANSITION_UNCERTAIN_ERROR.close,
    });
  });

  it("los mensajes de resultado incierto no afirman éxito y piden recargar", () => {
    for (const m of Object.values(PERIOD_TRANSITION_UNCERTAIN_ERROR)) {
      expect(m).toMatch(/No se pudo confirmar/);
      expect(m).toMatch(/Recargá la página/);
      expect(m).not.toMatch(/[Pp]eriodo/);
    }
    expect(PERIOD_TRANSITION_UNCERTAIN_ERROR.close).not.toBe(PERIOD_TRANSITION_GENERIC_ERROR.close);
  });
});
