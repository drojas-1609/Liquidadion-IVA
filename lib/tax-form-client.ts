/**
 * Alta, edición y baja de retenciones/percepciones desde la UI: cuerpos de las
 * solicitudes, envío, traducción de errores de la API y guardas contra el
 * doble envío.
 *
 * Lógica pura, sin `server-only` ni React: apta para el navegador. La API es la
 * autoridad (permisos, catálogo, importes, fecha dentro del período); acá sólo
 * se arma el pedido y se traduce la respuesta.
 *
 * La API responde `{ error: { code, message }, field? }` (authErrorBody); se
 * admite también la forma antigua `{ error: "texto", field? }`. Nunca se
 * convierte un objeto a string de forma implícita.
 *  - 409 CONFLICT (edición/baja): concurrencia (stale) -> mensaje propio y
 *    acción "Recargar". Es el ÚNICO criterio de stale.
 *  - 409 PERIOD_BUSY y el resto de los errores con mensaje: el mensaje EXACTO
 *    del servidor, sin marcarlo como stale.
 */
import { readApiError } from "@/lib/new-client-submit";
import { isTaxRecordType } from "@/lib/tax-types";

// ── Mensajes ───────────────────────────────────────────────────────────────

/** Genérico del alta: el mismo texto que mostraba la pantalla de alta. */
export const TAX_GENERIC_ERROR = "Error al crear el registro";
export const TAX_UPDATE_GENERIC_ERROR = "Error al guardar los cambios del registro.";
export const TAX_DELETE_GENERIC_ERROR = "Error al eliminar el registro.";
export const TAX_BAD_REQUEST_ERROR = "La solicitud no pudo procesarse. Revisá los datos e intentá de nuevo.";

export const TAX_CREATE_FORBIDDEN_ERROR = "No tenés permisos para cargar retenciones/percepciones.";
export const TAX_UPDATE_FORBIDDEN_ERROR = "No tenés permisos para modificar retenciones/percepciones.";
export const TAX_DELETE_FORBIDDEN_ERROR = "No tenés permisos para eliminar retenciones/percepciones.";

export const TAX_CREATE_NOT_FOUND_ERROR = "El período no existe o no pertenece a tu organización.";
export const TAX_UPDATE_NOT_FOUND_ERROR = "La retención/percepción no existe, fue eliminada o no pertenece a tu organización.";
export const TAX_DELETE_NOT_FOUND_ERROR = "La retención/percepción no existe o ya fue eliminada.";

export const TAX_STALE_UPDATE_ERROR =
    "Otra persona modificó esta retención/percepción mientras la editabas. Tus cambios no se guardaron: recargá los datos actuales y volvé a intentarlo.";
export const TAX_STALE_DELETE_ERROR =
    "Otra persona modificó esta retención/percepción. No se eliminó: recargá la página para ver los datos actuales.";

/**
 * Largo máximo de la descripción en el formulario: el mismo que valida la API
 * (TAX_DESCRIPTION_MAX de lib/api-input, verificado por test). La API cuenta
 * caracteres reales tras el trim y sigue siendo la autoridad.
 */
export const TAX_DESCRIPTION_MAX_LENGTH = 200;

/** Tipo histórico fuera del catálogo: hay que elegir uno válido antes de guardar. */
export const TAX_TYPE_REQUIRED_ERROR = "Elegí un tipo válido de la lista para poder guardar.";

export type TaxOperation = "create" | "update" | "delete";

const MESSAGES: Record<TaxOperation, { generic: string; forbidden: string; notFound: string; stale: string | null }> = {
    create: { generic: TAX_GENERIC_ERROR, forbidden: TAX_CREATE_FORBIDDEN_ERROR, notFound: TAX_CREATE_NOT_FOUND_ERROR, stale: null },
    update: { generic: TAX_UPDATE_GENERIC_ERROR, forbidden: TAX_UPDATE_FORBIDDEN_ERROR, notFound: TAX_UPDATE_NOT_FOUND_ERROR, stale: TAX_STALE_UPDATE_ERROR },
    delete: { generic: TAX_DELETE_GENERIC_ERROR, forbidden: TAX_DELETE_FORBIDDEN_ERROR, notFound: TAX_DELETE_NOT_FOUND_ERROR, stale: TAX_STALE_DELETE_ERROR },
};

// ── Errores ────────────────────────────────────────────────────────────────

/** Campos del formulario que pueden recibir un error propio. */
export const TAX_FORM_FIELDS = ["date", "type", "amount", "description"] as const;
export type TaxFormField = (typeof TAX_FORM_FIELDS)[number];

export interface TaxErrorFeedback {
    message: string;
    /** Campo del formulario al que corresponde; null = error general. */
    field: TaxFormField | null;
    /** 409 CONFLICT de edición/baja: los datos cambiaron, hay que recargar. */
    stale: boolean;
}

const general = (message: string, stale = false): TaxErrorFeedback => ({ message, field: null, stale });

/** Traduce una respuesta de error de la API a un mensaje legible y su campo. */
export function taxErrorFeedback(operation: TaxOperation, status: number, body: unknown): TaxErrorFeedback {
    const m = MESSAGES[operation];
    const apiError = readApiError(body);
    if (status === 409 && apiError?.code === "CONFLICT" && m.stale !== null) return general(m.stale, true);
    if (status === 400) return general(TAX_BAD_REQUEST_ERROR);
    if (status === 403) return general(m.forbidden);
    if (status === 404) return general(m.notFound);
    if ((status === 409 || status === 422) && apiError?.message) {
        const field = (body as { field?: unknown }).field;
        const formField = (TAX_FORM_FIELDS as readonly unknown[]).includes(field) ? (field as TaxFormField) : null;
        return { message: apiError.message, field: formField, stale: false };
    }
    return general(m.generic);
}

// ── Cuerpos ────────────────────────────────────────────────────────────────

/** Valores del formulario, tal como se escribieron (la API normaliza y valida). */
export interface TaxFormValues {
    /** `AAAA-MM-DD`. */
    date: string;
    type: string;
    /** Importe decimal como texto, sin convertir a número. */
    amount: string;
    description: string;
}

export interface TaxCreateBody extends TaxFormValues {
    periodId: string;
}

export interface TaxUpdateBody extends TaxFormValues {
    expectedUpdatedAt: string;
}

/** POST /api/taxes: los campos del formulario y el período; nada más. */
export function taxCreateBody(values: TaxFormValues, periodId: string): TaxCreateBody {
    return { date: values.date, type: values.type, amount: values.amount, description: values.description, periodId };
}

/** PATCH /api/taxes/[id]: los campos completos y el token de concurrencia; sin organización, cliente ni autoría. */
export function taxUpdateBody(values: TaxFormValues, expectedUpdatedAt: string): TaxUpdateBody {
    return { date: values.date, type: values.type, amount: values.amount, description: values.description, expectedUpdatedAt };
}

/**
 * Control previo al envío: sólo el tipo (un registro histórico puede traer un
 * tipo fuera del catálogo y el selector queda vacío). Todo lo demás lo valida
 * la API.
 */
export function taxFormBlockingError(values: TaxFormValues): TaxErrorFeedback | null {
    return isTaxRecordType(values.type) ? null : { message: TAX_TYPE_REQUIRED_ERROR, field: "type", stale: false };
}

// ── Envío ──────────────────────────────────────────────────────────────────

const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type TaxSaveResult = { ok: true; updatedAt: string | null } | { ok: false; feedback: TaxErrorFeedback };

async function save(operation: "create" | "update", url: string, method: "POST" | "PATCH", body: unknown, fetchImpl: typeof fetch): Promise<TaxSaveResult> {
    let res: Response;
    try {
        res = await fetchImpl(url, { method, headers: JSON_HEADERS, body: JSON.stringify(body) });
    } catch {
        return { ok: false, feedback: general(MESSAGES[operation].generic) };
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, feedback: taxErrorFeedback(operation, res.status, json) };
    const updatedAt = (json as { updatedAt?: unknown } | null)?.updatedAt;
    return { ok: true, updatedAt: typeof updatedAt === "string" && ISO_INSTANT.test(updatedAt) ? updatedAt : null };
}

export function submitTaxCreate(body: TaxCreateBody, fetchImpl: typeof fetch = fetch): Promise<TaxSaveResult> {
    return save("create", "/api/taxes", "POST", body, fetchImpl);
}

export function submitTaxUpdate(taxId: string, body: TaxUpdateBody, fetchImpl: typeof fetch = fetch): Promise<TaxSaveResult> {
    return save("update", `/api/taxes/${encodeURIComponent(taxId)}`, "PATCH", body, fetchImpl);
}

/** Destino del formulario compartido: alta en un período o edición de un registro con su token. */
export type TaxFormTarget =
    | { mode: "create"; periodId: string }
    | { mode: "edit"; taxId: string; expectedUpdatedAt: string };

/**
 * Envío del formulario compartido: control previo del tipo (sin red si falla)
 * y luego POST (alta) o PATCH (edición) con el cuerpo exacto de cada modo.
 */
export function submitTaxForm(target: TaxFormTarget, values: TaxFormValues, fetchImpl: typeof fetch = fetch): Promise<TaxSaveResult> {
    const blocking = taxFormBlockingError(values);
    if (blocking) return Promise.resolve({ ok: false, feedback: blocking });
    return target.mode === "create"
        ? submitTaxCreate(taxCreateBody(values, target.periodId), fetchImpl)
        : submitTaxUpdate(target.taxId, taxUpdateBody(values, target.expectedUpdatedAt), fetchImpl);
}

/** Nuevo token tras un PATCH: el `updatedAt` devuelto si es válido; si no, el vigente. */
export function nextTaxUpdateToken(current: string, result: TaxSaveResult): string {
    return result.ok && result.updatedAt !== null ? result.updatedAt : current;
}

export function taxDeleteUrl(taxId: string, expectedUpdatedAt: string): string {
    return `/api/taxes/${encodeURIComponent(taxId)}?expectedUpdatedAt=${encodeURIComponent(expectedUpdatedAt)}`;
}

export type TaxDeleteResult = { ok: true } | { ok: false; feedback: TaxErrorFeedback };

/** DELETE sin cuerpo; cualquier 2xx (204) es éxito. */
export async function deleteTaxRecord(taxId: string, expectedUpdatedAt: string, fetchImpl: typeof fetch = fetch): Promise<TaxDeleteResult> {
    let res: Response;
    try {
        res = await fetchImpl(taxDeleteUrl(taxId, expectedUpdatedAt), { method: "DELETE" });
    } catch {
        return { ok: false, feedback: general(TAX_DELETE_GENERIC_ERROR) };
    }
    if (res.ok) return { ok: true };
    const json: unknown = await res.json().catch(() => null);
    return { ok: false, feedback: taxErrorFeedback("delete", res.status, json) };
}

// ── Navegación ─────────────────────────────────────────────────────────────

export function taxListHref(clientId: string, periodId: string): string {
    return `/client/${clientId}/period/${periodId}/taxes`;
}

export function taxEditHref(clientId: string, periodId: string, taxId: string): string {
    return `${taxListHref(clientId, periodId)}/${encodeURIComponent(taxId)}/edit`;
}

// ── Doble envío ────────────────────────────────────────────────────────────

/** Guardia en vuelo (un `useRef(false)` de React cumple esta forma). */
export interface InFlightGuard {
    current: boolean;
}

export type ExclusiveResult<T> = { ran: true; value: T } | { ran: false };

/**
 * Ejecuta `operation` sólo si el guardia está libre: lo activa ANTES de
 * llamarla y lo libera en `finally`. Con el guardia activo no ejecuta nada
 * ({ ran: false }), así un segundo clic antes del re-render no envía otra vez.
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

// ── Baja desde la fila ─────────────────────────────────────────────────────

/** Etiqueta de la fila para la confirmación: tipo y fecha; nunca importe ni descripción. */
export function taxRowLabel(typeText: string, dateText: string): string {
    return `${typeText} del ${dateText}`;
}

/**
 * Estado de las acciones de una fila. La confirmación vive en la página (sin
 * diálogos del navegador). Sin baja optimista: la fila sigue visible hasta
 * que el servidor devuelve la lista nueva.
 *  idle -> open -> confirming -> start -> deleting -> done | fail
 * Mientras `deleting`, se ignoran cancelar y un segundo `start` (doble clic).
 */
export type TaxRowActionState =
    | { phase: "idle" }
    | { phase: "confirming" }
    | { phase: "deleting" }
    | { phase: "deleted" }
    | { phase: "error"; feedback: TaxErrorFeedback };

export type TaxRowActionEvent =
    | { type: "open" }
    | { type: "cancel" }
    | { type: "start" }
    | { type: "done" }
    | { type: "fail"; feedback: TaxErrorFeedback };

export const TAX_ROW_ACTION_INITIAL: TaxRowActionState = { phase: "idle" };

export function taxRowActionReducer(state: TaxRowActionState, event: TaxRowActionEvent): TaxRowActionState {
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
