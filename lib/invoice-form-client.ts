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
    /** 409 por concurrencia (edición): hay que recargar los datos actuales. */
    stale?: true;
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

// ── Edición (PATCH /api/invoices/[id]) ────────────────────────────────────

export const INVOICE_EDIT_TEXT = {
    SALES: { title: "Editar venta", save: "Guardar cambios", saving: "Guardando cambios..." },
    PURCHASES: { title: "Editar compra", save: "Guardar cambios", saving: "Guardando cambios..." },
} as const;

export function invoiceEditHref(
    direction: InvoiceFormContext["direction"],
    clientId: string,
    periodId: string,
    invoiceId: string,
): string {
    return `${invoiceListHref(direction, clientId, periodId)}/${encodeURIComponent(invoiceId)}/edit`;
}

/**
 * Datos mínimos de la edición que el servidor entrega al formulario: el id, el
 * token de concurrencia (updatedAt ISO exacto) y los valores guardados en la
 * forma del formulario (SIN normalizar: la normalización ocurre en el cliente
 * con la misma matriz que el alta). Las dos banderas marcan las excepciones
 * de filas anteriores al contrato v2 (condición de la contraparte o variante
 * nulas): el selector queda vacío y el envío bloqueado hasta completarlo.
 */
export interface InvoiceEditFormProps {
    invoiceId: string;
    updatedAt: string;
    initial: InvoiceFormState;
    requiresCounterpartyCondition: boolean;
    requiresVoucherVariant: boolean;
}

/**
 * Estado inicial de la edición, normalizado con resolveInvoiceFormOptions
 * (única preselección: la variante cuando la matriz admite exactamente una).
 * El número de documento se conserva mientras el tipo de documento no cambie.
 * Condición de la contraparte nula (fila antigua): se conserva la selección
 * guardada tal cual para que, al elegir la condición, la normalización
 * recupere el comprobante, el documento y la alícuota guardados.
 */
export function initialEditState(ctx: InvoiceFormContext, initial: InvoiceFormState): InvoiceFormState {
    if (initial.selection.counterpartyCondition === null) return initial;
    const selection = resolveInvoiceFormOptions(ctx, initial.selection).selection;
    const docKept = selection.docType === initial.selection.docType;
    return { selection, fields: docKept ? initial.fields : { ...initial.fields, docNumber: "" } };
}

export const EDIT_PENDING_CONDITION_MESSAGE =
    "Este comprobante se cargó sin la condición frente al IVA de la contraparte: elegila para poder guardar los cambios.";
export const EDIT_PENDING_VARIANT_MESSAGE =
    "Este comprobante se cargó sin la variante del comprobante: elegila para poder guardar los cambios.";

/** Avisos bloqueantes de las excepciones antiguas mientras sigan sin completar. */
export function editPendingNotices(
    edit: Pick<InvoiceEditFormProps, "requiresCounterpartyCondition" | "requiresVoucherVariant">,
    options: InvoiceFormOptions,
): string[] {
    const out: string[] = [];
    if (edit.requiresCounterpartyCondition && options.selection.counterpartyCondition === null) {
        out.push(EDIT_PENDING_CONDITION_MESSAGE);
    }
    if (edit.requiresVoucherVariant && options.variants.length > 0 && options.selection.voucherVariant === null) {
        out.push(EDIT_PENDING_VARIANT_MESSAGE);
    }
    return out;
}

export type InvoiceUpdateBody = InvoiceV2Body & { expectedUpdatedAt: string };

/** Cuerpo del PATCH: el cuerpo v2 COMPLETO más el token de concurrencia; nada más. */
export function buildInvoiceUpdateBody(body: InvoiceV2Body, expectedUpdatedAt: string): InvoiceUpdateBody {
    return { ...body, expectedUpdatedAt };
}

/**
 * Mensaje EXACTO del 409 por concurrencia de PATCH / DELETE
 * /api/invoices/[id] (verificado por test contra la ruta). Cualquier otro 409
 * (duplicidad, o PERIOD_BUSY: el período está siendo modificado por otra
 * operación) muestra el mensaje del servidor, sin marcarlo como stale.
 */
export const INVOICE_STALE_SERVER_MESSAGE =
    "El comprobante fue modificado por otra persona. Volvé a abrirlo para ver los datos actuales.";
export const INVOICE_STALE_EDIT_ERROR =
    "Otra persona modificó este comprobante mientras lo editabas. Tus cambios no se guardaron: recargá los datos actuales y volvé a intentarlo.";
export const INVOICE_UPDATE_FORBIDDEN_ERROR = "No tenés permisos para modificar comprobantes.";
export const INVOICE_EDIT_NOT_FOUND_ERROR = "El comprobante no existe, fue eliminado o no pertenece a tu organización.";

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isStaleConflict = (status: number, body: unknown) =>
    status === 409 && readApiError(body)?.message === INVOICE_STALE_SERVER_MESSAGE;

export function invoiceUpdateErrorFeedback(status: number, body: unknown): InvoiceErrorFeedback {
    if (isStaleConflict(status, body)) return { control: "form", message: INVOICE_STALE_EDIT_ERROR, pending: false, stale: true };
    if (status === 403) return { control: "form", message: INVOICE_UPDATE_FORBIDDEN_ERROR, pending: false };
    if (status === 404) return { control: "form", message: INVOICE_EDIT_NOT_FOUND_ERROR, pending: false };
    return invoiceErrorFeedback(status, body);
}

export type InvoiceUpdateResult = { ok: true; updatedAt: string | null } | { ok: false; feedback: InvoiceErrorFeedback };

export async function submitInvoiceUpdate(
    invoiceId: string,
    body: InvoiceUpdateBody,
    fetchImpl: typeof fetch = fetch,
): Promise<InvoiceUpdateResult> {
    let res: Response;
    try {
        res = await fetchImpl(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    } catch {
        return { ok: false, feedback: { control: "form", message: INVOICE_GENERIC_ERROR, pending: false } };
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, feedback: invoiceUpdateErrorFeedback(res.status, json) };
    const updatedAt = (json as { updatedAt?: unknown } | null)?.updatedAt;
    return { ok: true, updatedAt: typeof updatedAt === "string" && ISO_INSTANT.test(updatedAt) ? updatedAt : null };
}

/** Nuevo token tras un PATCH: el updatedAt devuelto si es válido; si no, el vigente. */
export function nextUpdateToken(current: string, result: InvoiceUpdateResult): string {
    return result.ok && result.updatedAt !== null ? result.updatedAt : current;
}

// ── Baja (DELETE /api/invoices/[id]?expectedUpdatedAt=…) ──────────────────

export function invoiceDeleteUrl(invoiceId: string, expectedUpdatedAt: string): string {
    return `/api/invoices/${encodeURIComponent(invoiceId)}?expectedUpdatedAt=${encodeURIComponent(expectedUpdatedAt)}`;
}

export const INVOICE_DELETE_GENERIC_ERROR = "Ocurrió un error inesperado al eliminar el comprobante.";
export const INVOICE_DELETE_FORBIDDEN_ERROR = "No tenés permisos para eliminar comprobantes.";
export const INVOICE_DELETE_NOT_FOUND_ERROR = "El comprobante no existe o ya fue eliminado.";
export const INVOICE_STALE_DELETE_ERROR =
    "Otra persona modificó este comprobante. No se eliminó: recargá la página para ver los datos actuales.";

export interface InvoiceDeleteFeedback {
    message: string;
    stale: boolean;
}

/** Errores de la baja: mensajes propios o el del servidor (nunca importes ni datos de la fila). */
export function invoiceDeleteFeedback(status: number, body: unknown): InvoiceDeleteFeedback {
    if (isStaleConflict(status, body)) return { message: INVOICE_STALE_DELETE_ERROR, stale: true };
    const apiError = readApiError(body);
    if (status === 403) return { message: INVOICE_DELETE_FORBIDDEN_ERROR, stale: false };
    if (status === 404) return { message: INVOICE_DELETE_NOT_FOUND_ERROR, stale: false };
    if ((status === 409 || status === 422) && apiError?.message) return { message: apiError.message, stale: false };
    return { message: INVOICE_DELETE_GENERIC_ERROR, stale: false };
}

export type InvoiceDeleteResult = { ok: true } | { ok: false; feedback: InvoiceDeleteFeedback };

export async function deleteInvoice(
    invoiceId: string,
    expectedUpdatedAt: string,
    fetchImpl: typeof fetch = fetch,
): Promise<InvoiceDeleteResult> {
    let res: Response;
    try {
        res = await fetchImpl(invoiceDeleteUrl(invoiceId, expectedUpdatedAt), { method: "DELETE" });
    } catch {
        return { ok: false, feedback: { message: INVOICE_DELETE_GENERIC_ERROR, stale: false } };
    }
    if (res.ok) return { ok: true };
    const json: unknown = await res.json().catch(() => null);
    return { ok: false, feedback: invoiceDeleteFeedback(res.status, json) };
}

/** Guardia en vuelo compartido (un `useRef(false)` de React cumple esta forma). */
export interface InFlightGuard {
    current: boolean;
}

export type ExclusiveResult<T> = { ran: true; value: T } | { ran: false };

/**
 * Ejecuta `operation` sólo si el guardia está libre: lo activa ANTES de
 * llamarla y lo libera en `finally`. Con el guardia activo no ejecuta nada
 * ({ ran: false }). Propaga el valor ({ ran: true, value }) o el error. Es el
 * mismo helper que usan las acciones de fila (baja) y sus tests.
 */
export async function runExclusive<T>(guard: InFlightGuard, operation: () => Promise<T>): Promise<ExclusiveResult<T>> {
    if (guard.current) return { ran: false };
    guard.current = true;
    try {
        return { ran: true, value: await operation() };
    } finally {
        guard.current = false;
    }
}

/**
 * Estado de las acciones de una fila. La confirmación vive en la página (sin
 * diálogos del navegador). Sin actualización optimista: tras el 204 la fila
 * desaparece cuando el servidor devuelve la lista nueva.
 *  idle -> open -> confirming -> start -> deleting -> done | fail
 * Mientras `deleting`, se ignoran cancelar y un segundo `start` (doble clic).
 */
export type RowActionState =
    | { phase: "idle" }
    | { phase: "confirming" }
    | { phase: "deleting" }
    | { phase: "deleted" }
    | { phase: "error"; feedback: InvoiceDeleteFeedback };

export type RowActionEvent =
    | { type: "open" }
    | { type: "cancel" }
    | { type: "start" }
    | { type: "done" }
    | { type: "fail"; feedback: InvoiceDeleteFeedback };

export const ROW_ACTION_INITIAL: RowActionState = { phase: "idle" };

export function rowActionReducer(state: RowActionState, event: RowActionEvent): RowActionState {
    switch (event.type) {
        case "open":
            return state.phase === "idle" || state.phase === "error" ? { phase: "confirming" } : state;
        case "cancel":
            return state.phase === "confirming" || state.phase === "error" ? { phase: "idle" } : state;
        case "start":
            return state.phase === "confirming" ? { phase: "deleting" } : state;
        case "done":
            return state.phase === "deleting" ? { phase: "deleted" } : state;
        case "fail":
            return state.phase === "deleting" ? { phase: "error", feedback: event.feedback } : state;
    }
}
