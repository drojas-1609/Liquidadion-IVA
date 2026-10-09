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

  it.each([["close"], ["reopen"]] as const)("%s: POST a /api/periods/<id>/%s con { expectedUpdatedAt } EXACTO", async (t) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const r = await submitPeriodTransition(t, "p/1", "2026-01-01T00:00:00.000Z", fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(`/api/periods/p%2F1/${t}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }),
    });
  });

  it("error de red -> mensaje genérico de la transición", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await submitPeriodTransition("close", "p_a", "2026-01-01T00:00:00.000Z", fetchImpl as unknown as typeof fetch)).toEqual({
      ok: false,
      message: PERIOD_TRANSITION_GENERIC_ERROR.close,
    });
  });
});
