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
  type InvoiceFormState,
  type SelectionKey,
} from "@/lib/invoice-form-client";
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
