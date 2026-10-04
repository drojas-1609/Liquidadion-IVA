import { describe, it, expect, vi } from "vitest";
import {
  TAX_DESCRIPTION_MAX_LENGTH,
  TAX_ROW_ACTION_INITIAL,
  deleteTaxRecord,
  nextTaxUpdateToken,
  runExclusive,
  submitTaxCreate,
  submitTaxForm,
  submitTaxUpdate,
  taxCreateBody,
  taxDeleteUrl,
  taxEditHref,
  taxErrorFeedback,
  taxFormBlockingError,
  taxListHref,
  taxRowActionReducer,
  taxRowLabel,
  taxUpdateBody,
  type TaxErrorFeedback,
  type TaxOperation,
  type TaxRowActionState,
} from "@/lib/tax-form-client";
import { TAX_DESCRIPTION_MAX } from "@/lib/api-input";

// Textos literales: el contrato visible no se toma del código productivo.
const BUSY = "El período está siendo modificado por otra operación. Esperá unos segundos y volvé a intentarlo.";
const SERVER_STALE = "La retención/percepción fue modificada por otra persona. Volvé a abrirla para ver los datos actuales.";
const GENERIC = {
  create: "Error al crear el registro",
  update: "Error al guardar los cambios del registro.",
  delete: "Error al eliminar el registro.",
} as const;
const STALE = {
  update: "Otra persona modificó esta retención/percepción mientras la editabas. Tus cambios no se guardaron: recargá los datos actuales y volvé a intentarlo.",
  delete: "Otra persona modificó esta retención/percepción. No se eliminó: recargá la página para ver los datos actuales.",
} as const;
const FORBIDDEN = {
  create: "No tenés permisos para cargar retenciones/percepciones.",
  update: "No tenés permisos para modificar retenciones/percepciones.",
  delete: "No tenés permisos para eliminar retenciones/percepciones.",
} as const;
const NOT_FOUND = {
  create: "El período no existe o no pertenece a tu organización.",
  update: "La retención/percepción no existe, fue eliminada o no pertenece a tu organización.",
  delete: "La retención/percepción no existe o ya fue eliminada.",
} as const;
const BAD_REQUEST = "La solicitud no pudo procesarse. Revisá los datos e intentá de nuevo.";
const TYPE_REQUIRED = "Elegí un tipo válido de la lista para poder guardar.";
const T0 = "2026-05-15T10:20:30.123Z";
const T1 = "2026-05-16T11:22:33.456Z";

const err = (code: string, message: string, field?: string) => ({ error: { code, message }, ...(field ? { field } : {}) });
const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fetchReturning = (res: Response | Error) =>
  vi.fn(async () => {
    if (res instanceof Error) throw res;
    return res;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
const callOf = (f: ReturnType<typeof vi.fn>) => f.mock.calls[0] as [string, RequestInit];
const general = (message: string, stale = false): TaxErrorFeedback => ({ message, field: null, stale });

const VALUES = { date: "2026-05-10", type: "RETENCION IVA", amount: "2500.00", description: "Banco Galicia" };
const OPS: TaxOperation[] = ["create", "update", "delete"];

describe("taxErrorFeedback — traducción de errores", () => {
  it("los genéricos de crear, editar y eliminar son distintos y claros", () => {
    for (const op of OPS) expect(taxErrorFeedback(op, 500, null)).toEqual(general(GENERIC[op]));
    expect(new Set(Object.values(GENERIC)).size).toBe(3);
  });

  it.each([["update"], ["delete"]] as const)("%s: 409 CONFLICT -> stale con mensaje propio (no el texto del servidor)", (op) => {
    expect(taxErrorFeedback(op, 409, err("CONFLICT", SERVER_STALE))).toEqual(general(STALE[op], true));
    // El criterio es el CÓDIGO, no el texto.
    expect(taxErrorFeedback(op, 409, err("CONFLICT", "otro texto"))).toEqual(general(STALE[op], true));
  });

  it.each(OPS)("%s: 409 PERIOD_BUSY -> mensaje EXACTO del servidor, nunca stale", (op) => {
    expect(taxErrorFeedback(op, 409, err("PERIOD_BUSY", BUSY))).toEqual(general(BUSY));
  });

  it("create: un 409 CONFLICT no es stale (el alta no tiene token)", () => {
    expect(taxErrorFeedback("create", 409, err("CONFLICT", "Ya existe."))).toEqual(general("Ya existe."));
  });

  it("409 con otro código que dice 'modificada por otra persona' NO es stale", () => {
    expect(taxErrorFeedback("update", 409, err("PERIOD_BUSY", SERVER_STALE)).stale).toBe(false);
  });

  it.each(OPS)("%s: 400, 403 y 404 -> mensajes propios", (op) => {
    expect(taxErrorFeedback(op, 400, err("BAD_REQUEST", "Cuerpo de la solicitud inválido."))).toEqual(general(BAD_REQUEST));
    expect(taxErrorFeedback(op, 403, err("FORBIDDEN", "x"))).toEqual(general(FORBIDDEN[op]));
    expect(taxErrorFeedback(op, 404, err("NOT_FOUND", "No encontrado."))).toEqual(general(NOT_FOUND[op]));
  });

  it.each([
    ["date", "date"],
    ["type", "type"],
    ["amount", "amount"],
    ["description", "description"],
    ["periodId", null],
    ["expectedUpdatedAt", null],
    ["body", null],
  ] as const)("422 field=%s -> mensaje del servidor en el campo %s", (field, expected) => {
    expect(taxErrorFeedback("update", 422, err("UNPROCESSABLE_ENTITY", "dato inválido", field))).toEqual({ message: "dato inválido", field: expected, stale: false });
  });

  it("422 sin field -> error general con el mensaje del servidor; forma antigua { error: 'texto' } también", () => {
    expect(taxErrorFeedback("create", 422, err("UNPROCESSABLE_ENTITY", "x"))).toEqual(general("x"));
    expect(taxErrorFeedback("create", 422, { error: "Monto inválido", field: "amount" })).toEqual({ message: "Monto inválido", field: "amount", stale: false });
  });

  it.each([
    ["null (JSON inválido)", 422, null],
    ["string", 422, "x"],
    ["sin error", 422, {}],
    ["error vacío", 422, { error: "" }],
    ["objeto sin mensaje", 409, { error: { code: "PERIOD_BUSY" } }],
    ["mensaje no string", 422, { error: { code: "X", message: {} } }],
    ["error numérico", 422, { error: 42 }],
    ["500 con mensaje interno", 500, err("INTERNAL", "Error interno.")],
  ])("respuesta sin mensaje usable (%s) -> genérico de la operación, nunca [object Object]", (_l, status, body) => {
    for (const op of OPS) {
      const f = taxErrorFeedback(op, status, body);
      expect(f).toEqual(general(GENERIC[op]));
      expect(f.message).not.toMatch(/object Object/);
    }
  });
});

describe("cuerpos de alta y edición", () => {
  it("alta: exactamente date, type, amount, description y periodId (como la pantalla anterior)", () => {
    expect(taxCreateBody({ ...VALUES, organizationId: "org_x" } as typeof VALUES, "p_a")).toEqual({ ...VALUES, periodId: "p_a" });
  });

  it("edición: exactamente date, type, amount, description y expectedUpdatedAt; sin organización, cliente, período ni autoría", () => {
    const body = taxUpdateBody({ ...VALUES, clientId: "c", updatedById: "u" } as typeof VALUES, T0);
    expect(body).toEqual({ ...VALUES, expectedUpdatedAt: T0 });
    expect(Object.keys(body).sort()).toEqual(["amount", "date", "description", "expectedUpdatedAt", "type"]);
  });

  it("importe y descripción viajan como texto, sin conversión ni recorte", () => {
    expect(taxUpdateBody({ ...VALUES, amount: "9007199254740993.01", description: "  x  " }, T0)).toMatchObject({ amount: "9007199254740993.01", description: "  x  " });
  });

  it("control previo: sólo exige un tipo del catálogo", () => {
    expect(taxFormBlockingError(VALUES)).toBeNull();
    for (const type of ["", "RETENCION GANANCIAS", "retencion iva"]) {
      expect(taxFormBlockingError({ ...VALUES, type })).toEqual({ message: TYPE_REQUIRED, field: "type", stale: false });
    }
    expect(taxFormBlockingError({ ...VALUES, amount: "-1", date: "x" })).toBeNull();
  });

  it("largo máximo de la descripción: 200, igual que la API", () => {
    expect(TAX_DESCRIPTION_MAX_LENGTH).toBe(200);
    expect(TAX_DESCRIPTION_MAX).toBe(200);
  });
});

describe("envío: alta (POST /api/taxes)", () => {
  it("endpoint, método, cabecera y cuerpo exactos; éxito con token", async () => {
    const f = fetchReturning(jsonResponse(201, { id: "t1", updatedAt: T0 }));
    expect(await submitTaxCreate(taxCreateBody(VALUES, "p_a"), f)).toEqual({ ok: true, updatedAt: T0 });
    const [url, init] = callOf(f);
    expect(url).toBe("/api/taxes");
    expect(init).toEqual({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...VALUES, periodId: "p_a" }) });
  });

  it("error 422 con field y error de red", async () => {
    expect(await submitTaxCreate(taxCreateBody(VALUES, "p_a"), fetchReturning(jsonResponse(422, err("UNPROCESSABLE_ENTITY", "la fecha debe pertenecer al período 05/2026", "date"))))).toEqual({
      ok: false,
      feedback: { message: "la fecha debe pertenecer al período 05/2026", field: "date", stale: false },
    });
    expect(await submitTaxCreate(taxCreateBody(VALUES, "p_a"), fetchReturning(new Error("offline")))).toEqual({ ok: false, feedback: general(GENERIC.create) });
  });
});

describe("envío: edición (PATCH /api/taxes/[taxId])", () => {
  it("URL con el id codificado, PATCH y cuerpo exacto; éxito actualiza el token", async () => {
    const f = fetchReturning(jsonResponse(200, { id: "t/1", updatedAt: T1 }));
    const result = await submitTaxUpdate("t/1", taxUpdateBody(VALUES, T0), f);
    expect(result).toEqual({ ok: true, updatedAt: T1 });
    expect(nextTaxUpdateToken(T0, result)).toBe(T1);
    const [url, init] = callOf(f);
    expect(url).toBe("/api/taxes/t%2F1");
    expect(init).toEqual({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...VALUES, expectedUpdatedAt: T0 }) });
  });

  it("token ausente o con otro formato en la respuesta -> se conserva el vigente", async () => {
    for (const updatedAt of [undefined, "2026-05-16", "2026-05-16T11:22:33Z", 1]) {
      const r = await submitTaxUpdate("t1", taxUpdateBody(VALUES, T0), fetchReturning(jsonResponse(200, { updatedAt })));
      expect(r).toEqual({ ok: true, updatedAt: null });
      expect(nextTaxUpdateToken(T0, r)).toBe(T0);
    }
    expect(nextTaxUpdateToken(T0, { ok: false, feedback: general("x") })).toBe(T0);
  });

  it("409 stale, 409 PERIOD_BUSY y respuesta sin JSON", async () => {
    expect(await submitTaxUpdate("t1", taxUpdateBody(VALUES, T0), fetchReturning(jsonResponse(409, err("CONFLICT", SERVER_STALE))))).toEqual({ ok: false, feedback: general(STALE.update, true) });
    expect(await submitTaxUpdate("t1", taxUpdateBody(VALUES, T0), fetchReturning(jsonResponse(409, err("PERIOD_BUSY", BUSY))))).toEqual({ ok: false, feedback: general(BUSY) });
    expect(await submitTaxUpdate("t1", taxUpdateBody(VALUES, T0), fetchReturning(new Response("<html>", { status: 502 })))).toEqual({ ok: false, feedback: general(GENERIC.update) });
  });
});

describe("envío del formulario compartido (submitTaxForm)", () => {
  it("alta -> POST con el período", async () => {
    const f = fetchReturning(jsonResponse(201, { updatedAt: T0 }));
    await submitTaxForm({ mode: "create", periodId: "p_a" }, VALUES, f);
    expect(callOf(f)[0]).toBe("/api/taxes");
    expect(JSON.parse(callOf(f)[1].body as string)).toEqual({ ...VALUES, periodId: "p_a" });
  });

  it("edición -> PATCH con el token vigente", async () => {
    const f = fetchReturning(jsonResponse(200, { updatedAt: T1 }));
    await submitTaxForm({ mode: "edit", taxId: "t1", expectedUpdatedAt: T0 }, VALUES, f);
    expect(callOf(f)[0]).toBe("/api/taxes/t1");
    expect(JSON.parse(callOf(f)[1].body as string)).toEqual({ ...VALUES, expectedUpdatedAt: T0 });
  });

  it("tipo histórico sin elegir uno válido -> error en el campo tipo, sin llamar a la red", async () => {
    const f = fetchReturning(jsonResponse(200, {}));
    expect(await submitTaxForm({ mode: "edit", taxId: "t1", expectedUpdatedAt: T0 }, { ...VALUES, type: "" }, f)).toEqual({
      ok: false,
      feedback: { message: TYPE_REQUIRED, field: "type", stale: false },
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("envío: baja (DELETE /api/taxes/[taxId]?expectedUpdatedAt=…)", () => {
  it("URL con id y token codificados; DELETE sin cuerpo ni cabeceras; 204 -> éxito", async () => {
    expect(taxDeleteUrl("t/1", T0)).toBe("/api/taxes/t%2F1?expectedUpdatedAt=2026-05-15T10%3A20%3A30.123Z");
    const f = fetchReturning(new Response(null, { status: 204 }));
    expect(await deleteTaxRecord("t/1", T0, f)).toEqual({ ok: true });
    const [url, init] = callOf(f);
    expect(url).toBe("/api/taxes/t%2F1?expectedUpdatedAt=2026-05-15T10%3A20%3A30.123Z");
    expect(init).toEqual({ method: "DELETE" });
  });

  it.each([
    ["409 stale", jsonResponse(409, err("CONFLICT", SERVER_STALE)), general(STALE.delete, true)],
    ["409 PERIOD_BUSY", jsonResponse(409, err("PERIOD_BUSY", BUSY)), general(BUSY)],
    ["403", jsonResponse(403, err("FORBIDDEN", "x")), general(FORBIDDEN.delete)],
    ["404", jsonResponse(404, err("NOT_FOUND", "No encontrado.")), general(NOT_FOUND.delete)],
    ["422 expectedUpdatedAt", jsonResponse(422, err("UNPROCESSABLE_ENTITY", "expectedUpdatedAt inválido", "expectedUpdatedAt")), general("expectedUpdatedAt inválido")],
    ["500 sin JSON", new Response("x", { status: 500 }), general(GENERIC.delete)],
    ["error de red", new Error("offline"), general(GENERIC.delete)],
  ])("%s -> feedback seguro", async (_l, res, expected) => {
    expect(await deleteTaxRecord("t1", T0, fetchReturning(res))).toEqual({ ok: false, feedback: expected });
  });
});

describe("doble envío — runExclusive", () => {
  it("un segundo intento mientras el primero sigue en vuelo no ejecuta nada", async () => {
    const guard = { current: false };
    let release!: () => void;
    const op = vi.fn(() => new Promise<string>((r) => (release = () => r("ok"))));
    const first = runExclusive(guard, op);
    expect(await runExclusive(guard, op)).toEqual({ ran: false });
    expect(op).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ ran: true, value: "ok" });
    expect(guard.current).toBe(false);
  });

  it("libera el guardia aunque la operación falle", async () => {
    const guard = { current: false };
    await expect(runExclusive(guard, async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(guard.current).toBe(false);
  });
});

describe("acciones de fila — reducer de la baja", () => {
  const run = (...events: Parameters<typeof taxRowActionReducer>[1][]) =>
    events.reduce<TaxRowActionState>((s, e) => taxRowActionReducer(s, e), TAX_ROW_ACTION_INITIAL);
  const fail = general("x");

  it("confirmación: idle -> confirming -> deleting -> deleted; cancelar vuelve a idle sin borrar", () => {
    expect(run({ type: "open" })).toEqual({ phase: "confirming" });
    expect(run({ type: "open" }, { type: "cancel" })).toEqual({ phase: "idle" });
    expect(run({ type: "open" }, { type: "start" })).toEqual({ phase: "deleting" });
    expect(run({ type: "open" }, { type: "start" }, { type: "done" })).toEqual({ phase: "deleted" });
  });

  it("sin confirmar no se puede iniciar la baja; durante la baja se ignoran cancelar y un segundo inicio", () => {
    expect(run({ type: "start" })).toEqual({ phase: "idle" });
    expect(run({ type: "open" }, { type: "start" }, { type: "cancel" })).toEqual({ phase: "deleting" });
    expect(run({ type: "open" }, { type: "start" }, { type: "start" })).toEqual({ phase: "deleting" });
  });

  it("error: queda el mensaje y se puede reintentar; un 'done' fuera de lugar no cambia nada", () => {
    expect(run({ type: "open" }, { type: "start" }, { type: "fail", feedback: fail })).toEqual({ phase: "error", feedback: fail });
    expect(run({ type: "open" }, { type: "start" }, { type: "fail", feedback: fail }, { type: "open" })).toEqual({ phase: "confirming" });
    expect(run({ type: "done" })).toEqual({ phase: "idle" });
  });
});

describe("etiquetas y navegación", () => {
  it("la etiqueta de la fila tiene tipo y fecha, sin importe ni descripción", () => {
    expect(taxRowLabel("Retención IVA", "10/05/2026")).toBe("Retención IVA del 10/05/2026");
  });

  it("listado y edición", () => {
    expect(taxListHref("c_a", "p_a")).toBe("/client/c_a/period/p_a/taxes");
    expect(taxEditHref("c_a", "p_a", "t/1")).toBe("/client/c_a/period/p_a/taxes/t%2F1/edit");
  });
});
