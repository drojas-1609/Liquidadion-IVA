import { DOCUMENT_TYPES, type VoucherVariant } from "./arca/catalogs";
import {
    EMPTY_SELECTION,
    resolveInvoiceFormOptions,
    type InvoiceFormContext,
    type InvoiceFormOptions,
    type InvoiceFormSelection,
} from "./invoice-form-options";
import { readApiError } from "./new-client-submit";

/**
 * Lógica del formulario de alta de comprobantes (contrato v2) que no depende
 * de React: cambios de campo, cuerpo del POST, traducción de errores y envío.
 *
 * Lógica pura, sin `server-only`: apta para el cliente. La autoridad
 * normativa y documental es la API; acá no se valida ninguna regla fiscal
 * (el número de documento se envía tal como se escribió).
 */

/** Debe coincidir con INVOICE_CONTRACT_VERSION de lib/api-input (verificado por test). */
export const INVOICE_FORM_CONTRACT_VERSION = 2;

// ── Textos y rutas por dirección ──────────────────────────────────────────

export const INVOICE_FORM_TEXT = {
    SALES: { title: "Nueva venta", counterparty: "Cliente", save: "Guardar venta", saving: "Guardando venta...", listSegment: "sales" },
    PURCHASES: { title: "Nueva compra", counterparty: "Proveedor", save: "Guardar compra", saving: "Guardando compra...", listSegment: "purchases" },
} as const;

export function invoiceListHref(direction: InvoiceFormContext["direction"], clientId: string, periodId: string): string {
    return `/client/${clientId}/period/${periodId}/${INVOICE_FORM_TEXT[direction].listSegment}`;
}

// ── Estado del formulario ─────────────────────────────────────────────────

export interface InvoiceFormFields {
    counterpartyName: string;
    docNumber: string;
    pointOfSale: string;
    number: string;
    netAmount: string;
}

export const EMPTY_FIELDS: InvoiceFormFields = { counterpartyName: "", docNumber: "", pointOfSale: "", number: "", netAmount: "" };

export interface InvoiceFormState {
    selection: InvoiceFormSelection;
    fields: InvoiceFormFields;
}

export const INITIAL_FORM_STATE: InvoiceFormState = { selection: EMPTY_SELECTION, fields: EMPTY_FIELDS };

export type SelectionKey = keyof InvoiceFormSelection;
export type FieldKey = keyof InvoiceFormFields;

const NUMERIC_KEYS: readonly SelectionKey[] = ["counterpartyCondition", "voucherCode", "docType"];

/** Valor de un <select>/<input> -> tipo de la selección ("" = sin elegir). */
export function parseSelectionValue(key: SelectionKey, raw: string): InvoiceFormSelection[SelectionKey] {
    if (raw === "") return null;
    if (NUMERIC_KEYS.includes(key)) return /^\d+$/.test(raw) ? Number(raw) : null;
    return raw as string & VoucherVariant;
}

/**
 * Aplica un cambio de selector y normaliza con resolveInvoiceFormOptions (que
 * reinicia lo dependiente y preselecciona la variante única). Todo cambio del
 * tipo de documento —elegido o por normalización— borra el número.
 */
export function applySelectionChange(
    ctx: InvoiceFormContext,
    state: InvoiceFormState,
    key: SelectionKey,
    raw: string,
): { state: InvoiceFormState; options: InvoiceFormOptions } {
    const options = resolveInvoiceFormOptions(ctx, { ...state.selection, [key]: parseSelectionValue(key, raw) });
    const docChanged = key === "docType" || options.selection.docType !== state.selection.docType;
    return {
        state: { selection: options.selection, fields: docChanged ? { ...state.fields, docNumber: "" } : state.fields },
        options,
    };
}

export function applyFieldChange(state: InvoiceFormState, key: FieldKey, value: string): InvoiceFormState {
    return { ...state, fields: { ...state.fields, [key]: value } };
}

/** Etiqueta del número según el tipo de documento elegido (catálogo). */
export function docNumberLabel(docType: number | null): string {
    const label = DOCUMENT_TYPES.find((d) => d.code === docType)?.label;
    return label ? `Número de ${label}` : "Número de documento";
}

// ── Cuerpo del POST (contrato v2) ─────────────────────────────────────────

export interface InvoiceV2Body {
    contractVersion: 2;
    category: "SALES" | "PURCHASES";
    periodId: string;
    date: string;
    voucherCode: number;
    voucherVariant: VoucherVariant | null;
    pointOfSale: number;
    number: number;
    counterparty: { name: string; docType: number; docNumber: string; vatConditionCode: number };
    turivaRelationCode: string | null;
    netAmount: string;
    vatRate: string;
}

/** Control del formulario al que se asocia un error ("form" = general). */
export type InvoiceFormControl = SelectionKey | FieldKey | "form";

export type BuildBodyResult =
    | { ok: true; body: InvoiceV2Body }
    | { ok: false; control: InvoiceFormControl; message: string };

/**
 * Máximo de punto de venta y número: columna Int (integer de PostgreSQL). Debe
 * coincidir con VOUCHER_INT_MAX de lib/api-input (verificado por test).
 */
export const INVOICE_FORM_INT_MAX = 2147483647;

/** Sólo dígitos (sin signo, decimales ni exponentes), en 1..INVOICE_FORM_INT_MAX. */
const positiveInt = (raw: string): number | null => {
    const v = raw.trim();
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 && n <= INVOICE_FORM_INT_MAX ? n : null;
};

/**
 * Arma el cuerpo con SÓLO las claves del contrato v2. Nunca incluye importes
 * calculados (IVA, total), clase jurídica, leyenda, pestaña, origen,
 * organización, cliente ni condición del cliente: los deriva el servidor.
 * Rechaza una selección incompleta o con avisos bloqueantes y los campos de
 * texto vacíos o no numéricos; no evalúa reglas fiscales.
 */
export function buildInvoiceV2Body(input: {
    ctx: InvoiceFormContext;
    periodId: string;
    state: InvoiceFormState;
}): BuildBodyResult {
    const { ctx, periodId, state } = input;
    const options = resolveInvoiceFormOptions(ctx, state.selection);
    const s = options.selection;
    const blocking = options.notices.find((n) => n.level === "blocking");
    if (blocking) return { ok: false, control: "form", message: blocking.message };
    if (
        options.derived === null ||
        JSON.stringify(s) !== JSON.stringify(state.selection) ||
        s.date === null ||
        s.counterpartyCondition === null ||
        s.voucherCode === null ||
        s.docType === null
    ) {
        return { ok: false, control: "form", message: "Completá la fecha, la contraparte, el comprobante y el documento." };
    }
    if (s.vatRate === null) return { ok: false, control: "vatRate", message: "Elegí la alícuota de IVA." };

    const name = state.fields.counterpartyName.trim();
    if (name === "") return { ok: false, control: "counterpartyName", message: "Ingresá la razón social de la contraparte." };
    const docNumber = state.fields.docNumber.trim();
    if (docNumber === "") return { ok: false, control: "docNumber", message: "Ingresá el número de documento." };
    const pointOfSale = positiveInt(state.fields.pointOfSale);
    if (pointOfSale === null) {
        return { ok: false, control: "pointOfSale", message: `El punto de venta debe ser un entero entre 1 y ${INVOICE_FORM_INT_MAX}.` };
    }
    const number = positiveInt(state.fields.number);
    if (number === null) {
        return { ok: false, control: "number", message: `El número de comprobante debe ser un entero entre 1 y ${INVOICE_FORM_INT_MAX}.` };
    }
    const netAmount = state.fields.netAmount.trim();
    if (netAmount === "") return { ok: false, control: "netAmount", message: "Ingresá el neto." };

    return {
        ok: true,
        body: {
            contractVersion: INVOICE_FORM_CONTRACT_VERSION,
            category: ctx.direction,
            periodId,
            date: s.date,
            voucherCode: s.voucherCode,
            voucherVariant: s.voucherVariant,
            pointOfSale,
            number,
            counterparty: { name, docType: s.docType, docNumber, vatConditionCode: s.counterpartyCondition },
            turivaRelationCode: s.turivaRelationCode,
            netAmount,
            vatRate: s.vatRate,
        },
    };
}

// ── Errores de la API ─────────────────────────────────────────────────────

export const INVOICE_GENERIC_ERROR = "Ocurrió un error inesperado al guardar el comprobante.";
export const INVOICE_BAD_REQUEST_ERROR = "La solicitud no pudo procesarse. Revisá los datos e intentá de nuevo.";
export const INVOICE_FORBIDDEN_ERROR = "No tenés permisos para cargar comprobantes.";
export const INVOICE_NOT_FOUND_ERROR = "El período no existe o no pertenece a tu organización.";
export const INVOICE_DUPLICATE_ERROR = "El comprobante ya existe.";

/** Campo de la API -> control del formulario. */
const API_FIELD_TO_CONTROL: Readonly<Record<string, InvoiceFormControl>> = {
    date: "date",
    category: "form",
    periodId: "form",
    counterpartyVatConditionCode: "counterpartyCondition",
    voucherCode: "voucherCode",
    voucherVariant: "voucherVariant",
    turivaRelationCode: "turivaRelationCode",
    counterparty: "counterpartyName",
    counterpartyName: "counterpartyName",
    counterpartyDocType: "docType",
    counterpartyDocNumber: "docNumber",
    pointOfSale: "pointOfSale",
    number: "number",
    netAmount: "netAmount",
    vatAmount: "netAmount",
    totalAmount: "netAmount",
    vatRate: "vatRate",
};

export interface InvoiceErrorFeedback {
    control: InvoiceFormControl;
    message: string;
    /** La API marcó la combinación como pendiente de confirmación normativa. */
    pending: boolean;
}

export function invoiceErrorFeedback(status: number, body: unknown): InvoiceErrorFeedback {
    const apiError = readApiError(body);
    const form = (message: string): InvoiceErrorFeedback => ({ control: "form", message, pending: false });
    if (status === 400) return form(INVOICE_BAD_REQUEST_ERROR);
    if (status === 403) return form(INVOICE_FORBIDDEN_ERROR);
    if (status === 404) return form(INVOICE_NOT_FOUND_ERROR);
    if (status === 409) return form(apiError?.message ?? INVOICE_DUPLICATE_ERROR);
    if (status === 422 && apiError?.message) {
        const b = body as { field?: unknown; pending?: unknown };
        const control = typeof b.field === "string" ? (API_FIELD_TO_CONTROL[b.field] ?? "form") : "form";
        return { control, message: apiError.message, pending: b.pending === true };
    }
    return form(INVOICE_GENERIC_ERROR);
}

/** Texto visible de un error; marca los pendientes sin repetir lo que ya dice la API. */
export function feedbackText(f: InvoiceErrorFeedback): string {
    if (!f.pending || /pendiente de confirmación normativa/i.test(f.message)) return f.message;
    return `${f.message} (pendiente de confirmación normativa: no habilitado)`;
}

export type InvoiceSubmitResult = { ok: true } | { ok: false; feedback: InvoiceErrorFeedback };

export async function submitInvoice(body: InvoiceV2Body, fetchImpl: typeof fetch = fetch): Promise<InvoiceSubmitResult> {
    let res: Response;
    try {
        res = await fetchImpl("/api/invoices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        return { ok: false, feedback: { control: "form", message: INVOICE_GENERIC_ERROR, pending: false } };
    }
    if (res.ok) return { ok: true };
    const json: unknown = await res.json().catch(() => null);
    return { ok: false, feedback: invoiceErrorFeedback(res.status, json) };
}
