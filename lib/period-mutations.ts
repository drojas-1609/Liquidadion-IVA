/**
 * Alta, eliminación, cierre y reapertura de períodos desde la UI, con
 * traducción de errores de la API (`{ error: { code, message }, field? }`) a
 * mensajes legibles. Nunca se convierte un objeto a string de forma implícita.
 */
import { readApiError } from "@/lib/new-client-submit";
import { formatPeriodLabel } from "@/lib/period";

export const CREATE_PERIOD_GENERIC_ERROR = "Ocurrió un error inesperado al crear el período.";
export const DELETE_PERIOD_GENERIC_ERROR = "Ocurrió un error inesperado al eliminar el período.";
export const PERIOD_CLIENT_NOT_FOUND_ERROR = "El cliente no existe o no pertenece a tu organización.";
export const PERIOD_NOT_FOUND_ERROR = "El período no existe o ya fue eliminado.";
export const CREATE_PERIOD_FORBIDDEN_ERROR = "No tenés permisos para crear períodos.";
export const DELETE_PERIOD_FORBIDDEN_ERROR = "No tenés permisos para eliminar períodos.";
export const DELETE_PERIOD_HAS_MOVEMENTS_ERROR =
    "El período tiene comprobantes o retenciones/percepciones y no se puede eliminar.";

export function duplicatePeriodError(p: { year: number; month: number }): string {
    return `Ya existe el período ${formatPeriodLabel(p)} para este cliente.`;
}

const FIELD_LABELS: Record<string, string> = { month: "Mes", year: "Año", clientId: "Cliente" };

export function createPeriodErrorMessage(body: unknown, period: { year: number; month: number }): string {
    const apiError = readApiError(body);
    if (!apiError) return CREATE_PERIOD_GENERIC_ERROR;
    // La única unicidad alcanzable al crear es @@unique([month, year, clientId]).
    if (apiError.code === "CONFLICT") return duplicatePeriodError(period);
    if (apiError.code === "NOT_FOUND") return PERIOD_CLIENT_NOT_FOUND_ERROR;
    if (apiError.code === "FORBIDDEN") return CREATE_PERIOD_FORBIDDEN_ERROR;
    if (apiError.code === "INTERNAL" || !apiError.message) return CREATE_PERIOD_GENERIC_ERROR;

    const field = (body as { field?: unknown }).field;
    const label = typeof field === "string" ? FIELD_LABELS[field] : undefined;
    return label ? `${label}: ${apiError.message}` : apiError.message;
}

export function deletePeriodErrorMessage(body: unknown): string {
    const apiError = readApiError(body);
    if (!apiError) return DELETE_PERIOD_GENERIC_ERROR;
    if (apiError.code === "CONFLICT") return DELETE_PERIOD_HAS_MOVEMENTS_ERROR;
    if (apiError.code === "NOT_FOUND") return PERIOD_NOT_FOUND_ERROR;
    if (apiError.code === "FORBIDDEN") return DELETE_PERIOD_FORBIDDEN_ERROR;
    if (apiError.code === "INTERNAL" || !apiError.message) return DELETE_PERIOD_GENERIC_ERROR;
    return apiError.message;
}

export type PeriodMutationResult = { ok: true } | { ok: false; message: string };

async function send(
    url: string,
    init: RequestInit,
    toMessage: (body: unknown) => string,
    genericError: string,
    fetchImpl: typeof fetch,
): Promise<PeriodMutationResult> {
    let res: Response;
    try {
        res = await fetchImpl(url, init);
    } catch {
        return { ok: false, message: genericError };
    }
    if (res.ok) return { ok: true };
    const body: unknown = await res.json().catch(() => null);
    return { ok: false, message: toMessage(body) };
}

export function submitNewPeriod(
    data: { clientId: string; year: number; month: number },
    fetchImpl: typeof fetch = fetch,
): Promise<PeriodMutationResult> {
    return send(
        "/api/periods",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) },
        (body) => createPeriodErrorMessage(body, data),
        CREATE_PERIOD_GENERIC_ERROR,
        fetchImpl,
    );
}

// ── Cierre / reapertura ─────────────────────────────────────────────────────

export type PeriodTransition = "close" | "reopen";

export const PERIOD_TRANSITION_GENERIC_ERROR: Record<PeriodTransition, string> = {
    close: "Ocurrió un error inesperado al cerrar el período.",
    reopen: "Ocurrió un error inesperado al reabrir el período.",
};
export const PERIOD_TRANSITION_FORBIDDEN_ERROR: Record<PeriodTransition, string> = {
    close: "No tenés permisos para cerrar períodos.",
    reopen: "No tenés permisos para reabrir períodos.",
};
/** 409 CONFLICT: otra persona cerró o reabrió el período desde que se abrió la pantalla. */
export const PERIOD_TRANSITION_STALE_ERROR =
    "Otra persona cambió el estado del período mientras lo tenías abierto. No se aplicó ningún cambio: recargá la página para ver el estado actual.";

export function periodTransitionErrorMessage(transition: PeriodTransition, body: unknown): string {
    const apiError = readApiError(body);
    if (!apiError) return PERIOD_TRANSITION_GENERIC_ERROR[transition];
    if (apiError.code === "CONFLICT") return PERIOD_TRANSITION_STALE_ERROR;
    if (apiError.code === "NOT_FOUND") return PERIOD_NOT_FOUND_ERROR;
    if (apiError.code === "FORBIDDEN") return PERIOD_TRANSITION_FORBIDDEN_ERROR[transition];
    // PERIOD_BUSY y el resto con mensaje: el mensaje exacto de la API.
    if (apiError.code === "INTERNAL" || !apiError.message) return PERIOD_TRANSITION_GENERIC_ERROR[transition];
    return apiError.message;
}

/**
 * POST /api/periods/[id]/close | /reopen con el cuerpo exacto
 * `{ expectedUpdatedAt }`: la versión del estado que vio la pantalla.
 */
export function submitPeriodTransition(
    transition: PeriodTransition,
    periodId: string,
    expectedUpdatedAt: string,
    fetchImpl: typeof fetch = fetch,
): Promise<PeriodMutationResult> {
    return send(
        `/api/periods/${encodeURIComponent(periodId)}/${transition}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt }) },
        (body) => periodTransitionErrorMessage(transition, body),
        PERIOD_TRANSITION_GENERIC_ERROR[transition],
        fetchImpl,
    );
}

export function submitPeriodDelete(
    periodId: string,
    fetchImpl: typeof fetch = fetch,
): Promise<PeriodMutationResult> {
    return send(
        `/api/periods/${encodeURIComponent(periodId)}`,
        { method: "DELETE" },
        deletePeriodErrorMessage,
        DELETE_PERIOD_GENERIC_ERROR,
        fetchImpl,
    );
}
