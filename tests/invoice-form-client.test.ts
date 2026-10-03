import { describe, it, expect, vi } from "vitest";
import {
  INITIAL_FORM_STATE,
  INVOICE_FORM_CONTRACT_VERSION,
  INVOICE_FORM_INT_MAX,
  INVOICE_BAD_REQUEST_ERROR,
  INVOICE_FORBIDDEN_ERROR,
  INVOICE_GENERIC_ERROR,
  INVOICE_NOT_FOUND_ERROR,
  applyFieldChange,
  applySelectionChange,
  buildInvoiceV2Body,
  docNumberLabel,
  feedbackText,
  invoiceErrorFeedback,
  invoiceListHref,
  parseSelectionValue,
  submitInvoice,
  EDIT_PENDING_CONDITION_MESSAGE,
  EDIT_PENDING_VARIANT_MESSAGE,
  INVOICE_DELETE_FORBIDDEN_ERROR,
  INVOICE_DELETE_GENERIC_ERROR,
  INVOICE_DELETE_NOT_FOUND_ERROR,
  INVOICE_EDIT_NOT_FOUND_ERROR,
  INVOICE_STALE_DELETE_ERROR,
  INVOICE_STALE_EDIT_ERROR,
  INVOICE_STALE_SERVER_MESSAGE,
  INVOICE_UPDATE_FORBIDDEN_ERROR,
  ROW_ACTION_INITIAL,
  buildInvoiceUpdateBody,
  deleteInvoice,
  editPendingNotices,
  initialEditState,
  invoiceDeleteFeedback,
  invoiceDeleteUrl,
  invoiceEditHref,
  invoiceUpdateErrorFeedback,
  nextUpdateToken,
  rowActionReducer,
  submitInvoiceUpdate,
  runExclusive,
  type InFlightGuard,
  type InvoiceFormState,
  type RowActionState,
  type SelectionKey,
} from "@/lib/invoice-form-client";
import { readFileSync } from "node:fs";
import { resolveInvoiceFormOptions } from "@/lib/invoice-form-options";
import type { InvoiceFormContext } from "@/lib/invoice-form-options";
// Sólo en el test: la constante del servidor (api-input es server-only y el cliente no la importa).
import { INVOICE_CONTRACT_VERSION, VOUCHER_INT_MAX, buildInvoiceInputV2 } from "@/lib/api-input";
import { resolveManualInvoice } from "@/lib/manual-invoice";

const ctx = (over: Partial<InvoiceFormContext> = {}): InvoiceFormContext => ({
  direction: "SALES",
  clientConditionCode: 1,
  turivaIncluded: false,
  period: { month: 5, year: 2026 },
  ...over,
});

/** Aplica cambios de selector en orden, como lo haría el usuario. */
const select = (c: InvoiceFormContext, steps: Array<[SelectionKey, string]>, from: InvoiceFormState = INITIAL_FORM_STATE) =>
  steps.reduce((s, [k, v]) => applySelectionChange(c, s, k, v).state, from);
const fill = (s: InvoiceFormState, fields: Partial<InvoiceFormState["fields"]>) =>
  Object.entries(fields).reduce((acc, [k, v]) => applyFieldChange(acc, k as keyof InvoiceFormState["fields"], v as string), s);

const FIELDS = { counterpartyName: " Cliente SA ", docNumber: " 30-99999999-5 ", pointOfSale: "1", number: "1234", netAmount: " 1000.00 " };
const saleA = (c = ctx()) =>
  fill(
    select(c, [
      ["date", "2026-05-10"],
      ["counterpartyCondition", "1"],
      ["voucherCode", "1"],
      ["docType", "80"],
      ["voucherVariant", "NONE"],
      ["vatRate", "21"],
    ]),
    FIELDS,
  );

describe("contrato v2", () => {
  it("la constante del cliente coincide con INVOICE_CONTRACT_VERSION de la API", () => {
    expect(INVOICE_FORM_CONTRACT_VERSION).toBe(INVOICE_CONTRACT_VERSION);
  });

  it("cuerpo con EXACTAMENTE las claves del contrato v2 y valores normalizados", () => {
    const r = buildInvoiceV2Body({ ctx: ctx(), periodId: "p_a", state: saleA() });
    expect(r).toEqual({
      ok: true,
      body: {
        contractVersion: 2,
        category: "SALES",
        periodId: "p_a",
        date: "2026-05-10",
        voucherCode: 1,
        voucherVariant: "NONE",
        pointOfSale: 1,
        number: 1234,
        counterparty: { name: "Cliente SA", docType: 80, docNumber: "30-99999999-5", vatConditionCode: 1 },
        turivaRelationCode: null,
        netAmount: "1000.00",
        vatRate: "21",
      },
    });
  });

  it("sin campos derivados ni de autoridad del servidor", () => {
    const r = buildInvoiceV2Body({ ctx: ctx(), periodId: "p_a", state: saleA() });
    const json = JSON.stringify(r.ok ? r.body : null);
    for (const k of ["vatAmount", "totalAmount", "legalClass", "mandatoryLegend", "lidSection", "source", "organizationId", "clientId", "clientCondition", "partialValidation", "requiresTurivaSection", "type", "entityCuit"]) {
      expect(json).not.toContain(`"${k}"`);
    }
  });

  it("los cuerpos armados los acepta la API (parser v2 + matriz + documentos) — ventas, compras, T y CUIT País", () => {
    const cases: Array<[InvoiceFormContext, InvoiceFormState]> = [
      [ctx(), saleA()],
      [
        ctx({ direction: "PURCHASES", clientConditionCode: 4 }),
        fill(select(ctx({ direction: "PURCHASES", clientConditionCode: 4 }), [["date", "2026-04-20"], ["counterpartyCondition", "1"], ["voucherCode", "6"], ["docType", "80"], ["vatRate", "0"]]), FIELDS),
      ],
      [
        ctx({ turivaIncluded: true }),
        fill(
          select(ctx({ turivaIncluded: true }), [["date", "2026-05-10"], ["counterpartyCondition", "5"], ["voucherCode", "195"], ["docType", "94"], ["turivaRelationCode", "0001"], ["vatRate", "21"]]),
          { ...FIELDS, docNumber: "ab123456" },
        ),
      ],
      [ctx(), fill(select(ctx(), [["date", "2026-05-10"], ["counterpartyCondition", "9"], ["voucherCode", "19"], ["docType", "80"], ["vatRate", "0"]]), { ...FIELDS, docNumber: "55000000002" })],
    ];
    for (const [c, s] of cases) {
      const r = buildInvoiceV2Body({ ctx: c, periodId: "p_a", state: s });
      expect(r.ok, JSON.stringify(s.selection)).toBe(true);
      if (!r.ok) continue;
      const parsed = buildInvoiceInputV2(JSON.parse(JSON.stringify(r.body)));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(resolveManualInvoice(parsed.data, c.clientConditionCode)).toMatchObject({ ok: true });
    }
  });
});

describe("buildInvoiceV2Body — rechazos", () => {
  const build = (s: InvoiceFormState, c = ctx()) => buildInvoiceV2Body({ ctx: c, periodId: "p_a", state: s });

  it("selección incompleta (sin documento, sin variante, sin alícuota)", () => {
    expect(build(fill(select(ctx(), [["date", "2026-05-10"], ["counterpartyCondition", "1"], ["voucherCode", "1"]]), FIELDS))).toMatchObject({ ok: false, control: "form" });
    expect(build(applySelectionChange(ctx(), saleA(), "voucherVariant", "").state)).toMatchObject({ ok: false, control: "form" });
    expect(build(applySelectionChange(ctx(), saleA(), "vatRate", "").state)).toMatchObject({ ok: false, control: "vatRate" });
    expect(build(INITIAL_FORM_STATE)).toMatchObject({ ok: false, control: "form" });
  });

  it("selección que no está normalizada (valor fuera de las opciones) -> rechazada", () => {
    const s = saleA();
    expect(build({ ...s, selection: { ...s.selection, voucherCode: 11 } })).toMatchObject({ ok: false, control: "form" });
  });

  it("condición del cliente no admitida -> bloqueo con el mensaje de la matriz", () => {
    const r = build(saleA(), ctx({ clientConditionCode: null }));
    expect(r).toMatchObject({ ok: false, control: "form" });
    if (!r.ok) expect(r.message).toMatch(/condición fiscal del cliente/);
  });

  it.each([
    ["counterpartyName", "   "],
    ["docNumber", "  "],
    ["netAmount", "   "],
  ])("%s vacío tras trim -> rechazado en ese control", (key, value) => {
    expect(build(applyFieldChange(saleA(), key as "docNumber", value))).toMatchObject({ ok: false, control: key });
  });

  it.each([["0"], ["-1"], ["1.5"], ["1e3"], ["abc"], [""], ["99999999999999999999"], [" 12a"]])(
    "pointOfSale / number %s no es entero positivo finito -> rechazado",
    (value) => {
      expect(build(applyFieldChange(saleA(), "pointOfSale", value))).toMatchObject({ ok: false, control: "pointOfSale" });
      expect(build(applyFieldChange(saleA(), "number", value))).toMatchObject({ ok: false, control: "number" });
    },
  );

  it("punto de venta y número: el formulario y la API aceptan y rechazan EXACTAMENTE los mismos valores", () => {
    expect(INVOICE_FORM_INT_MAX).toBe(VOUCHER_INT_MAX);
    const base = build(saleA());
    if (!base.ok) throw new Error("fixture");
    const numbers = [1, 2, 9999, 2147483647, 2147483648, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 0, -1, 1.5, 1e21];
    for (const n of numbers) {
      for (const field of ["pointOfSale", "number"] as const) {
        // Lo que escribe el usuario (texto) -> lo que el formulario enviaría.
        const form = build(applyFieldChange(saleA(), field, String(n)));
        // Lo que recibe la API como JSON con ese mismo valor.
        const api = buildInvoiceInputV2({ ...base.body, [field]: n });
        expect(form.ok, `${field}=${n}: formulario vs API`).toBe(api.ok);
        if (form.ok) expect(form.body[field], `${field}=${n}`).toBe(n);
      }
    }
    // Texto con formato no entero: el formulario lo rechaza y la API rechaza todo texto.
    for (const raw of ["1e3", "abc", "", " ", "+1", "0x10", "1,5"]) {
      expect(build(applyFieldChange(saleA(), "number", raw)).ok, raw).toBe(false);
      expect(buildInvoiceInputV2({ ...base.body, number: raw }).ok, raw).toBe(false);
    }
    // Ceros a la izquierda: el formulario normaliza "0007" -> 7, que la API acepta.
    const padded = build(applyFieldChange(saleA(), "number", "0007"));
    expect(padded.ok && padded.body.number).toBe(7);
  });

  it("no valida reglas del documento: un CUIT con dígito verificador inválido se envía (decide la API)", () => {
    const r = build(applyFieldChange(saleA(), "docNumber", "30-99999999-1"));
    expect(r.ok && r.body.counterparty.docNumber).toBe("30-99999999-1");
  });
});

describe("selección y campos", () => {
  it("cambiar docType borra SIEMPRE el número (otro tipo, mismo tipo o vaciarlo)", () => {
    const c = ctx();
    const base = fill(select(c, [["date", "2026-05-10"], ["counterpartyCondition", "5"], ["voucherCode", "6"], ["docType", "96"]]), { docNumber: "12345678" });
    expect(base.fields.docNumber).toBe("12345678");
    for (const raw of ["80", "96", ""]) {
      expect(applySelectionChange(c, base, "docType", raw).state.fields.docNumber, raw).toBe("");
    }
  });

  it("si la normalización descarta el tipo de documento (cambio de contraparte), también se borra el número", () => {
    const c = ctx();
    const s = saleA();
    const next = applySelectionChange(c, s, "counterpartyCondition", "5").state;
    expect(next.selection.docType).toBeNull();
    expect(next.fields.docNumber).toBe("");
    // Un cambio que no afecta el documento conserva el número.
    expect(applySelectionChange(c, s, "vatRate", "10.5").state.fields.docNumber).toBe(s.fields.docNumber);
  });

  it("normaliza con resolveInvoiceFormOptions: cambio de contraparte reinicia lo dependiente; variante única preseleccionada", () => {
    const c = ctx();
    // A a Consumidor Final no está admitido: se descartan comprobante y todo lo que depende de él.
    const next = applySelectionChange(c, saleA(), "counterpartyCondition", "5").state;
    expect(next.selection).toMatchObject({ counterpartyCondition: 5, voucherCode: null, voucherVariant: null, docType: null, vatRate: null });
    // A a Monotributo sí está admitido (V13, CUIT): la selección válida se conserva.
    expect(applySelectionChange(c, saleA(), "counterpartyCondition", "6").state.selection).toMatchObject({ counterpartyCondition: 6, voucherCode: 1, docType: 80 });
    const p = ctx({ direction: "PURCHASES" });
    const s = select(p, [["date", "2020-06-10"], ["counterpartyCondition", "1"], ["voucherCode", "1"]]);
    expect(s.selection.voucherVariant).toBe("NONE");
  });

  it("parseSelectionValue: vacío -> null; numéricos sólo con dígitos; resto como texto", () => {
    expect(parseSelectionValue("voucherCode", "")).toBeNull();
    expect(parseSelectionValue("voucherCode", "195")).toBe(195);
    expect(parseSelectionValue("docType", "8x")).toBeNull();
    expect(parseSelectionValue("vatRate", "10.5")).toBe("10.5");
    expect(parseSelectionValue("turivaRelationCode", "0001")).toBe("0001");
  });

  it("etiqueta del número según el catálogo de documentos", () => {
    expect(docNumberLabel(80)).toBe("Número de CUIT");
    expect(docNumberLabel(null)).toBe("Número de documento");
  });

  it("rutas de retorno separadas para ventas y compras", () => {
    expect(invoiceListHref("SALES", "c_a", "p_a")).toBe("/client/c_a/period/p_a/sales");
    expect(invoiceListHref("PURCHASES", "c_a", "p_a")).toBe("/client/c_a/period/p_a/purchases");
  });
});

describe("errores de la API", () => {
  it("400 / 403 / 404 / 5xx -> mensajes generales", () => {
    expect(invoiceErrorFeedback(400, { error: { code: "BAD_REQUEST", message: "x" } })).toEqual({ control: "form", message: INVOICE_BAD_REQUEST_ERROR, pending: false });
    expect(invoiceErrorFeedback(403, null).message).toBe(INVOICE_FORBIDDEN_ERROR);
    expect(invoiceErrorFeedback(404, null).message).toBe(INVOICE_NOT_FOUND_ERROR);
    expect(invoiceErrorFeedback(500, { error: { code: "INTERNAL", message: "Error interno." } }).message).toBe(INVOICE_GENERIC_ERROR);
  });

  it("409: mensaje de la API (período donde ya existe)", () => {
    expect(invoiceErrorFeedback(409, { error: { code: "CONFLICT", message: "El comprobante ya existe en el período 04/2026." } })).toEqual({
      control: "form",
      message: "El comprobante ya existe en el período 04/2026.",
      pending: false,
    });
  });

  it.each([
    ["counterpartyDocNumber", "docNumber"],
    ["counterpartyDocType", "docType"],
    ["counterpartyVatConditionCode", "counterpartyCondition"],
    ["voucherCode", "voucherCode"],
    ["turivaRelationCode", "turivaRelationCode"],
    ["vatAmount", "netAmount"],
    ["totalAmount", "netAmount"],
    ["date", "date"],
    ["clientCondition", "form"],
    ["contractVersion", "form"],
    ["desconocido", "form"],
  ])("422 field=%s -> control %s con el mensaje de la API", (field, control) => {
    expect(invoiceErrorFeedback(422, { error: { code: "UNPROCESSABLE_ENTITY", message: "mensaje" }, field })).toEqual({ control, message: "mensaje", pending: false });
  });

  it("422 pendiente: se marca sin repetir el texto que ya trae la API", () => {
    const f = invoiceErrorFeedback(422, { error: { code: "UNPROCESSABLE_ENTITY", message: "combinación pendiente de confirmación normativa: no habilitada" }, field: "voucherCode", pending: true });
    expect(f).toMatchObject({ control: "voucherCode", pending: true });
    expect(feedbackText(f)).toBe("combinación pendiente de confirmación normativa: no habilitada");
    expect(feedbackText({ control: "docType", message: "no habilitado", pending: true })).toBe("no habilitado (pendiente de confirmación normativa: no habilitado)");
  });

  it("cuerpos no reconocibles nunca producen [object Object]", () => {
    for (const body of [null, "x", { error: { code: 1, message: {} } }, { error: {} }]) {
      for (const status of [400, 409, 422, 500]) expect(invoiceErrorFeedback(status, body).message).not.toMatch(/object Object/);
    }
  });
});

describe("submitInvoice", () => {
  const body = () => {
    const r = buildInvoiceV2Body({ ctx: ctx(), periodId: "p_a", state: saleA() });
    if (!r.ok) throw new Error("fixture");
    return r.body;
  };

  it("POST JSON a /api/invoices con el cuerpo tal cual; 201 -> ok", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "i1" }), { status: 201 }));
    expect(await submitInvoice(body(), fetchImpl as unknown as typeof fetch)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/invoices");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(body());
  });

  it("422 -> feedback del campo; error de red -> genérico", async () => {
    const res422 = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "UNPROCESSABLE_ENTITY", message: "dígito verificador incorrecto" }, field: "counterpartyDocNumber" }), { status: 422 }),
    );
    expect(await submitInvoice(body(), res422 as unknown as typeof fetch)).toEqual({
      ok: false,
      feedback: { control: "docNumber", message: "dígito verificador incorrecto", pending: false },
    });
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await submitInvoice(body(), down as unknown as typeof fetch)).toEqual({
      ok: false,
      feedback: { control: "form", message: INVOICE_GENERIC_ERROR, pending: false },
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Edición y baja
// ═════════════════════════════════════════════════════════════════════════

const T0 = "2026-05-11T10:00:00.000Z";
const T1 = "2026-05-11T10:00:01.000Z";

/** Valores guardados (forma del formulario) de una FC A de venta a un RI. */
const stored = (over: Partial<InvoiceFormState["selection"]> = {}, fields: Partial<InvoiceFormState["fields"]> = {}): InvoiceFormState => ({
  selection: {
    date: "2026-05-10",
    counterpartyCondition: 1,
    voucherCode: 1,
    voucherVariant: "NONE",
    docType: 80,
    turivaRelationCode: null,
    vatRate: "21",
    ...over,
  },
  fields: { counterpartyName: "Cliente SA", docNumber: "30999999995", pointOfSale: "1", number: "1001", netAmount: "1000.00", ...fields },
});

const jsonRes = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
const apiErr = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  jsonRes(status, { error: { code: "X", message }, ...extra });
const fetchOnce = (res: Response | (() => never)) =>
  vi.fn(async () => (typeof res === "function" ? res() : res)) as unknown as typeof fetch & { mock: { calls: unknown[][] } };

describe("initialEditState — estado inicial normalizado por la matriz", () => {
  it("fila completa y vigente -> igual a lo guardado (idempotente)", () => {
    const s = initialEditState(ctx(), stored());
    expect(s).toEqual(stored());
    expect(initialEditState(ctx(), s)).toEqual(s);
    expect(resolveInvoiceFormOptions(ctx(), s.selection).derived).not.toBeNull();
  });

  // Fixtures confirmados en invoice-form-options.test.ts ("variantes: única válida
  // (compra A de 06/2020)" y "variantes: A en 2026 -> NONE y CBU sin preselección").
  const PURCHASE_A_2020 = { date: "2020-06-10", counterpartyCondition: 1, voucherCode: 1, docType: 80, vatRate: "21" } as const;
  const SALE_A_2026 = { date: "2026-05-10", counterpartyCondition: 1, voucherCode: 1, docType: 80, vatRate: "21" } as const;

  it("variante nula y UNA sola válida (compra A de 06/2020) -> preselecciona exactamente NONE", () => {
    const c = ctx({ direction: "PURCHASES" });
    expect(resolveInvoiceFormOptions(c, stored({ ...PURCHASE_A_2020, voucherVariant: null }).selection).variants.map((v) => v.value)).toEqual(["NONE"]);
    const s = initialEditState(c, stored({ ...PURCHASE_A_2020, voucherVariant: null }));
    expect(s.selection).toEqual({ ...stored().selection, ...PURCHASE_A_2020, voucherVariant: "NONE" });
    expect(editPendingNotices({ requiresCounterpartyCondition: false, requiresVoucherVariant: true }, resolveInvoiceFormOptions(c, s.selection))).toEqual([]);
  });

  it("variante nula y DOS válidas (venta A de 2026) -> queda null, aviso y envío bloqueado", () => {
    const s = initialEditState(ctx(), stored({ ...SALE_A_2026, voucherVariant: null }));
    const opts = resolveInvoiceFormOptions(ctx(), s.selection);
    expect(opts.variants.map((v) => v.value)).toEqual(["NONE", "PAGO_EN_CBU_INFORMADA"]);
    expect(s.selection.voucherVariant).toBeNull();
    expect(opts.derived).toBeNull();
    expect(editPendingNotices({ requiresCounterpartyCondition: false, requiresVoucherVariant: true }, opts)).toEqual([EDIT_PENDING_VARIANT_MESSAGE]);
    expect(buildInvoiceV2Body({ ctx: ctx(), periodId: "p_a", state: s }).ok).toBe(false);
  });

  it.each(["NONE", "PAGO_EN_CBU_INFORMADA"] as const)(
    "fila antigua con variante nula: al elegir %s, el PATCH incluye voucherVariant",
    (variant) => {
      const s = initialEditState(ctx(), stored({ ...SALE_A_2026, voucherVariant: null }));
      const { state, options } = applySelectionChange(ctx(), s, "voucherVariant", variant);
      expect(editPendingNotices({ requiresCounterpartyCondition: false, requiresVoucherVariant: true }, options)).toEqual([]);
      const built = buildInvoiceV2Body({ ctx: ctx(), periodId: "p_a", state });
      if (!built.ok) throw new Error(built.message);
      const patch = buildInvoiceUpdateBody(built.body, T0);
      expect(patch.voucherVariant).toBe(variant);
      expect(patch).toMatchObject({ voucherCode: 1, counterparty: { docType: 80, docNumber: "30999999995", vatConditionCode: 1 }, expectedUpdatedAt: T0 });
    },
  );

  it("fila antigua con variante nula y única válida: el PATCH lleva la variante preseleccionada sin tocar el selector", () => {
    const c = ctx({ direction: "PURCHASES" });
    const built = buildInvoiceV2Body({ ctx: c, periodId: "p_a", state: initialEditState(c, stored({ ...PURCHASE_A_2020, voucherVariant: null })) });
    if (!built.ok) throw new Error(built.message);
    expect(buildInvoiceUpdateBody(built.body, T0).voucherVariant).toBe("NONE");
  });

  it("condición nula (fila antigua) -> se conserva lo guardado; al elegirla se recupera todo", () => {
    const raw = stored({ counterpartyCondition: null });
    const s = initialEditState(ctx(), raw);
    expect(s).toEqual(raw);
    // Mientras tanto la vista normalizada deja el selector vacío y no hay derivados (envío bloqueado).
    const pendingView = resolveInvoiceFormOptions(ctx(), s.selection);
    expect(pendingView.selection.counterpartyCondition).toBeNull();
    expect(pendingView.derived).toBeNull();
    expect(buildInvoiceV2Body({ ctx: ctx(), periodId: "p_a", state: s }).ok).toBe(false);
    // Elegir la condición restaura comprobante, documento, variante y alícuota guardados.
    const next = applySelectionChange(ctx(), s, "counterpartyCondition", "1").state;
    expect(next).toEqual(stored());
  });

  it("el número de documento se conserva mientras no cambie el tipo; se borra si la normalización lo cambia", () => {
    expect(initialEditState(ctx(), stored()).fields.docNumber).toBe("30999999995");
    // Tipo de documento no admitido para la combinación -> normalizado a null -> número borrado.
    const s = initialEditState(ctx(), stored({ docType: 99999 }));
    expect(s.selection.docType).toBeNull();
    expect(s.fields.docNumber).toBe("");
    expect(s.fields.counterpartyName).toBe("Cliente SA");
  });

  it("combinación ya no ofrecida (T sin inclusión TurIVA) -> comprobante descartado, sin inferir otro", () => {
    const s = initialEditState(ctx({ turivaIncluded: false }), stored({ voucherCode: 195, voucherVariant: null, turivaRelationCode: "0001", docType: 94 }));
    expect(s.selection.voucherCode).toBeNull();
  });
});

describe("editPendingNotices — excepciones antiguas", () => {
  const flags = (c: boolean, v: boolean) => ({ requiresCounterpartyCondition: c, requiresVoucherVariant: v });

  it("condición pendiente -> aviso explícito mientras siga vacía", () => {
    const s = initialEditState(ctx(), stored({ counterpartyCondition: null }));
    expect(editPendingNotices(flags(true, false), resolveInvoiceFormOptions(ctx(), s.selection))).toEqual([EDIT_PENDING_CONDITION_MESSAGE]);
    const done = applySelectionChange(ctx(), s, "counterpartyCondition", "1");
    expect(editPendingNotices(flags(true, false), done.options)).toEqual([]);
  });

  it("variante pendiente -> aviso mientras haya variantes y ninguna elegida (venta A de 2026: dos variantes)", () => {
    const opts = resolveInvoiceFormOptions(ctx(), stored({ voucherVariant: null }).selection);
    expect(opts.variants).toHaveLength(2);
    expect(editPendingNotices(flags(false, true), opts)).toEqual([EDIT_PENDING_VARIANT_MESSAGE]);
    expect(editPendingNotices(flags(false, true), resolveInvoiceFormOptions(ctx(), stored().selection))).toEqual([]);
  });

  it("sin banderas -> nunca hay avisos", () => {
    const opts = resolveInvoiceFormOptions(ctx(), stored({ counterpartyCondition: null }).selection);
    expect(editPendingNotices(flags(false, false), opts)).toEqual([]);
  });
});

describe("PATCH — cuerpo, URL y token", () => {
  const v2 = () => {
    const b = buildInvoiceV2Body({ ctx: ctx(), periodId: "p_a", state: initialEditState(ctx(), stored()) });
    if (!b.ok) throw new Error(b.message);
    return b.body;
  };

  it("cuerpo EXACTO: v2 completo + expectedUpdatedAt; sin derivados, organización, cliente, autores ni source", () => {
    const body = buildInvoiceUpdateBody(v2(), T0);
    expect(body).toEqual({
      contractVersion: 2,
      category: "SALES",
      periodId: "p_a",
      date: "2026-05-10",
      voucherCode: 1,
      voucherVariant: "NONE",
      pointOfSale: 1,
      number: 1001,
      counterparty: { name: "Cliente SA", docType: 80, docNumber: "30999999995", vatConditionCode: 1 },
      turivaRelationCode: null,
      netAmount: "1000.00",
      vatRate: "21",
      expectedUpdatedAt: T0,
    });
  });

  it("ese cuerpo es aceptado por el parser del PATCH (buildInvoiceUpdateInput) del servidor", async () => {
    const { buildInvoiceUpdateInput } = await import("@/lib/api-input");
    const r = buildInvoiceUpdateInput(JSON.parse(JSON.stringify(buildInvoiceUpdateBody(v2(), T0))));
    expect(r.ok).toBe(true);
  });

  it("URL y método exactos; id codificado; 200 -> updatedAt devuelto", async () => {
    const f = fetchOnce(jsonRes(200, { id: "inv 1", updatedAt: T1 }));
    const result = await submitInvoiceUpdate("inv 1", buildInvoiceUpdateBody(v2(), T0), f);
    expect(result).toEqual({ ok: true, updatedAt: T1 });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/invoices/inv%201");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual(buildInvoiceUpdateBody(v2(), T0));
  });

  it("token: se reemplaza por el updatedAt devuelto; si falta o es inválido, se conserva", async () => {
    expect(nextUpdateToken(T0, { ok: true, updatedAt: T1 })).toBe(T1);
    expect(nextUpdateToken(T0, { ok: true, updatedAt: null })).toBe(T0);
    expect(nextUpdateToken(T0, { ok: false, feedback: { control: "form", message: "x", pending: false } })).toBe(T0);
    expect(await submitInvoiceUpdate("i", buildInvoiceUpdateBody(v2(), T0), fetchOnce(jsonRes(200, { updatedAt: "ayer" })))).toEqual({ ok: true, updatedAt: null });
  });

  it("dos ediciones seguidas usan cada una el token de la anterior", async () => {
    let token = T0;
    const sent: string[] = [];
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      sent.push(b.expectedUpdatedAt);
      return jsonRes(200, { updatedAt: b.expectedUpdatedAt === T0 ? T1 : "2026-05-11T10:00:02.000Z" });
    }) as unknown as typeof fetch;
    for (let n = 0; n < 2; n++) {
      token = nextUpdateToken(token, await submitInvoiceUpdate("i", buildInvoiceUpdateBody(v2(), token), f));
    }
    expect(sent).toEqual([T0, T1]);
    expect(token).toBe("2026-05-11T10:00:02.000Z");
  });

  it.each([
    [403, apiErr(403, "Forbidden"), { control: "form", message: INVOICE_UPDATE_FORBIDDEN_ERROR, pending: false }],
    [404, apiErr(404, "Not found"), { control: "form", message: INVOICE_EDIT_NOT_FOUND_ERROR, pending: false }],
    [409, apiErr(409, INVOICE_STALE_SERVER_MESSAGE), { control: "form", message: INVOICE_STALE_EDIT_ERROR, pending: false, stale: true }],
    [409, apiErr(409, "El comprobante ya existe en el período 04/2026."), { control: "form", message: "El comprobante ya existe en el período 04/2026.", pending: false }],
    [422, apiErr(422, "fecha fuera del período", { field: "date" }), { control: "date", message: "fecha fuera del período", pending: false }],
    [422, apiErr(422, "no editable", { field: "invoice" }), { control: "form", message: "no editable", pending: false }],
    [500, apiErr(500, "Error interno."), { control: "form", message: INVOICE_GENERIC_ERROR, pending: false }],
  ] as const)("%i -> feedback", async (_s, res, expected) => {
    expect(await submitInvoiceUpdate("i", buildInvoiceUpdateBody(v2(), T0), fetchOnce(res))).toEqual({ ok: false, feedback: expected });
  });

  it("red caída -> error genérico", async () => {
    const down = fetchOnce(() => {
      throw new Error("offline");
    });
    expect(await submitInvoiceUpdate("i", buildInvoiceUpdateBody(v2(), T0), down)).toEqual({
      ok: false,
      feedback: { control: "form", message: INVOICE_GENERIC_ERROR, pending: false },
    });
  });

  it("el 409 por concurrencia se reconoce SÓLO por el mensaje exacto de la ruta", () => {
    const route = readFileSync(new URL("../app/api/invoices/[id]/route.ts", import.meta.url), "utf8");
    expect(route).toContain(`"${INVOICE_STALE_SERVER_MESSAGE}"`);
    expect(invoiceUpdateErrorFeedback(409, { error: { message: INVOICE_STALE_SERVER_MESSAGE.slice(0, -1) } }).stale).toBeUndefined();
  });

  it("los mensajes propios no incluyen importes ni datos de la fila", () => {
    for (const m of [INVOICE_STALE_EDIT_ERROR, INVOICE_UPDATE_FORBIDDEN_ERROR, INVOICE_EDIT_NOT_FOUND_ERROR]) {
      expect(m).not.toMatch(/\d/);
    }
  });

  it("invoiceEditHref separa ventas y compras y codifica el id", () => {
    expect(invoiceEditHref("SALES", "c_a", "p_a", "inv 1")).toBe("/client/c_a/period/p_a/sales/inv%201/edit");
    expect(invoiceEditHref("PURCHASES", "c_a", "p_a", "inv_1")).toBe("/client/c_a/period/p_a/purchases/inv_1/edit");
  });
});

describe("DELETE — URL, respuesta y errores", () => {
  it("URL EXACTA con expectedUpdatedAt codificado; método DELETE sin cuerpo; 204 -> ok", async () => {
    expect(invoiceDeleteUrl("inv_1", T0)).toBe("/api/invoices/inv_1?expectedUpdatedAt=2026-05-11T10%3A00%3A00.000Z");
    const f = fetchOnce(new Response(null, { status: 204 }));
    expect(await deleteInvoice("inv/1", T0, f)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/invoices/inv%2F1?expectedUpdatedAt=2026-05-11T10%3A00%3A00.000Z");
    expect(init).toEqual({ method: "DELETE" });
    // El servidor recibe el valor original.
    expect(new URL(`http://x${url}`).searchParams.get("expectedUpdatedAt")).toBe(T0);
  });

  it.each([
    [403, apiErr(403, "Forbidden"), { message: INVOICE_DELETE_FORBIDDEN_ERROR, stale: false }],
    [404, apiErr(404, "Not found"), { message: INVOICE_DELETE_NOT_FOUND_ERROR, stale: false }],
    [409, apiErr(409, INVOICE_STALE_SERVER_MESSAGE), { message: INVOICE_STALE_DELETE_ERROR, stale: true }],
    [409, apiErr(409, "Ya existe un registro con esos datos."), { message: "Ya existe un registro con esos datos.", stale: false }],
    [422, apiErr(422, "El comprobante fue importado: no se puede corregir ni eliminar manualmente.", { field: "invoice" }), { message: "El comprobante fue importado: no se puede corregir ni eliminar manualmente.", stale: false }],
    [500, apiErr(500, "Error interno."), { message: INVOICE_DELETE_GENERIC_ERROR, stale: false }],
    [502, jsonRes(502, undefined), { message: INVOICE_DELETE_GENERIC_ERROR, stale: false }],
  ] as const)("%i -> feedback", async (_s, res, expected) => {
    expect(await deleteInvoice("i", T0, fetchOnce(res))).toEqual({ ok: false, feedback: expected });
  });

  it("red caída -> error genérico", async () => {
    const down = fetchOnce(() => {
      throw new Error("offline");
    });
    expect(await deleteInvoice("i", T0, down)).toEqual({ ok: false, feedback: { message: INVOICE_DELETE_GENERIC_ERROR, stale: false } });
  });

  it("feedback sin cuerpo -> mensajes propios", () => {
    expect(invoiceDeleteFeedback(422, null)).toEqual({ message: INVOICE_DELETE_GENERIC_ERROR, stale: false });
    for (const m of [INVOICE_DELETE_FORBIDDEN_ERROR, INVOICE_DELETE_NOT_FOUND_ERROR, INVOICE_STALE_DELETE_ERROR, INVOICE_DELETE_GENERIC_ERROR]) {
      expect(m).not.toMatch(/\d/);
    }
  });
});

describe("rowActionReducer — confirmación, cancelación, doble clic", () => {
  const run = (events: Parameters<typeof rowActionReducer>[1][], from: RowActionState = ROW_ACTION_INITIAL) =>
    events.reduce(rowActionReducer, from);
  const fb = { message: "x", stale: false };

  it("abrir -> confirmar -> eliminado", () => {
    expect(run([{ type: "open" }])).toEqual({ phase: "confirming" });
    expect(run([{ type: "open" }, { type: "start" }])).toEqual({ phase: "deleting" });
    expect(run([{ type: "open" }, { type: "start" }, { type: "done" }])).toEqual({ phase: "deleted" });
  });

  it("cancelar vuelve a idle sin llamar a la API (no hay start)", () => {
    expect(run([{ type: "open" }, { type: "cancel" }])).toEqual({ phase: "idle" });
  });

  it("confirmar sin abrir no hace nada (la baja exige confirmación)", () => {
    expect(run([{ type: "start" }])).toEqual({ phase: "idle" });
  });

  it("doble clic: un segundo start mientras elimina se ignora; cancelar también", () => {
    const deleting = run([{ type: "open" }, { type: "start" }]);
    expect(rowActionReducer(deleting, { type: "start" })).toBe(deleting);
    expect(rowActionReducer(deleting, { type: "cancel" })).toBe(deleting);
    expect(rowActionReducer(deleting, { type: "open" })).toBe(deleting);
  });

  it("error -> se muestra; se puede reintentar (abrir) o cerrar (cancelar)", () => {
    const err = run([{ type: "open" }, { type: "start" }, { type: "fail", feedback: fb }]);
    expect(err).toEqual({ phase: "error", feedback: fb });
    expect(rowActionReducer(err, { type: "open" })).toEqual({ phase: "confirming" });
    expect(rowActionReducer(err, { type: "cancel" })).toEqual({ phase: "idle" });
  });

  it("done / fail fuera de deleting se ignoran", () => {
    expect(run([{ type: "done" }])).toEqual({ phase: "idle" });
    expect(run([{ type: "open" }, { type: "fail", feedback: fb }])).toEqual({ phase: "confirming" });
  });

});

describe("runExclusive — guardia compartido de la baja (mismo helper que invoice-row-actions)", () => {
  const guard = (): InFlightGuard => ({ current: false });

  it("éxito: activa el guardia DURANTE la llamada, devuelve el valor y lo libera", async () => {
    const g = guard();
    let during: boolean | null = null;
    const f = fetchOnce(new Response(null, { status: 204 }));
    const r = await runExclusive(g, async () => {
      during = g.current;
      return deleteInvoice("i", T0, f);
    });
    expect(during).toBe(true);
    expect(r).toEqual({ ran: true, value: { ok: true } });
    expect(g.current).toBe(false);
  });

  it("respuesta de error: devuelve el resultado fallido y libera el guardia", async () => {
    const g = guard();
    const r = await runExclusive(g, () => deleteInvoice("i", T0, fetchOnce(apiErr(403, "Forbidden"))));
    expect(r).toEqual({ ran: true, value: { ok: false, feedback: { message: INVOICE_DELETE_FORBIDDEN_ERROR, stale: false } } });
    expect(g.current).toBe(false);
  });

  it("excepción: se propaga y el guardia queda libre", async () => {
    const g = guard();
    await expect(runExclusive(g, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(g.current).toBe(false);
  });

  it("guardia ya activo: no ejecuta nada", async () => {
    const g = { current: true };
    const op = vi.fn(async () => 1);
    expect(await runExclusive(g, op)).toEqual({ ran: false });
    expect(op).not.toHaveBeenCalled();
    expect(g.current).toBe(true);
  });

  it("doble invocación concurrente (doble clic): una sola llamada DELETE; después se puede volver a usar", async () => {
    const g = guard();
    let resolve!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => (resolve = r))) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
    const first = runExclusive(g, () => deleteInvoice("i", T0, f));
    const second = runExclusive(g, () => deleteInvoice("i", T0, f));
    resolve(new Response(null, { status: 204 }));
    expect(await Promise.all([first, second])).toEqual([{ ran: true, value: { ok: true } }, { ran: false }]);
    expect(f.mock.calls).toHaveLength(1);
    expect(g.current).toBe(false);
    const again = await runExclusive(g, () => deleteInvoice("i", T0, fetchOnce(new Response(null, { status: 204 }))));
    expect(again).toEqual({ ran: true, value: { ok: true } });
  });

  it("el componente usa exactamente este helper con su ref (sin guardia propio)", () => {
    const src = readFileSync(new URL("../app/(app)/client/[id]/period/[periodId]/_components/invoice-row-actions.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/import \{[^}]*\brunExclusive\b[^}]*\} from "@\/lib\/invoice-form-client";/);
    expect(src).toMatch(/await runExclusive\(inFlight, async \(\) => \{\s*dispatch\(\{ type: "start" \}\);\s*const result = await deleteInvoice\(invoiceId, updatedAt\);/);
    expect(src).not.toMatch(/inFlight\.current\s*=/);
    expect(src).not.toMatch(/if \(inFlight\.current/);
  });
});

describe("409 PERIOD_BUSY — el mensaje del servidor llega tal cual (alta, edición y baja)", () => {
  const BUSY_MESSAGE = "El período está siendo modificado por otra operación. Esperá unos segundos y volvé a intentarlo.";
  const busy = () => jsonRes(409, { error: { code: "PERIOD_BUSY", message: BUSY_MESSAGE } });
  const v2 = () => {
    const b = buildInvoiceV2Body({ ctx: ctx(), periodId: "p_a", state: initialEditState(ctx(), stored()) });
    if (!b.ok) throw new Error(b.message);
    return b.body;
  };

  it("alta: submitInvoice -> feedback de formulario con el mensaje EXACTO, no pendiente", async () => {
    expect(await submitInvoice(v2(), fetchOnce(busy()))).toEqual({
      ok: false,
      feedback: { control: "form", message: BUSY_MESSAGE, pending: false },
    });
  });

  it("edición: submitInvoiceUpdate -> mensaje EXACTO, SIN marcar stale (no hay que recargar los datos)", async () => {
    const result = await submitInvoiceUpdate("i", buildInvoiceUpdateBody(v2(), T0), fetchOnce(busy()));
    expect(result).toEqual({ ok: false, feedback: { control: "form", message: BUSY_MESSAGE, pending: false } });
    expect(result.ok === false && result.feedback.stale).toBeFalsy();
  });

  it("baja: deleteInvoice -> mensaje EXACTO, stale false", async () => {
    expect(await deleteInvoice("i", T0, fetchOnce(busy()))).toEqual({ ok: false, feedback: { message: BUSY_MESSAGE, stale: false } });
  });
});
