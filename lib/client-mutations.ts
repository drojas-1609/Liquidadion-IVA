/**
 * Edición y eliminación de clientes desde la UI, con traducción de errores de
 * la API (`{ error: { code, message }, field? }`) a mensajes legibles. Nunca se
 * convierte un objeto a string de forma implícita.
 */
import { readApiError } from "@/lib/new-client-submit";

export const UPDATE_CLIENT_GENERIC_ERROR = "Error al actualizar el cliente";
export const DELETE_CLIENT_GENERIC_ERROR = "Error al eliminar el cliente";
export const UPDATE_CLIENT_DUPLICATE_CUIT_ERROR =
    "Ya existe otro cliente con ese CUIT en la organización.";
export const DELETE_CLIENT_HAS_PERIODS_ERROR =
    "El cliente tiene períodos asociados y no se puede eliminar.";
export const CLIENT_NOT_FOUND_ERROR = "El cliente no existe o ya fue eliminado.";
export const CLIENT_FORBIDDEN_ERROR = "No tenés permisos para modificar clientes.";

const FIELD_LABELS: Record<string, string> = {
    name: "Nombre",
    cuit: "CUIT",
    condition: "Condición fiscal",
    address: "Dirección",
    defaultIibbRate: "Alícuota IIBB",
};

function commonMessage(code: string | null): string | null {
    if (code === "NOT_FOUND") return CLIENT_NOT_FOUND_ERROR;
    if (code === "FORBIDDEN") return CLIENT_FORBIDDEN_ERROR;
    return null;
}

export function updateClientErrorMessage(body: unknown): string {
    const apiError = readApiError(body);
    if (!apiError) return UPDATE_CLIENT_GENERIC_ERROR;
    // En la edición, la única unicidad alcanzable es @@unique([organizationId, cuit]).
    if (apiError.code === "CONFLICT") return UPDATE_CLIENT_DUPLICATE_CUIT_ERROR;
    const common = commonMessage(apiError.code);
    if (common) return common;
    if (!apiError.message) return UPDATE_CLIENT_GENERIC_ERROR;

    const field = (body as { field?: unknown }).field;
    const label = typeof field === "string" && field !== "body" ? (FIELD_LABELS[field] ?? field) : null;
    return label ? `${label}: ${apiError.message}` : apiError.message;
}

export function deleteClientErrorMessage(body: unknown): string {
    const apiError = readApiError(body);
    if (!apiError) return DELETE_CLIENT_GENERIC_ERROR;
    if (apiError.code === "CONFLICT") return DELETE_CLIENT_HAS_PERIODS_ERROR;
    return commonMessage(apiError.code) ?? apiError.message ?? DELETE_CLIENT_GENERIC_ERROR;
}

export type ClientMutationResult = { ok: true } | { ok: false; message: string };

async function send(
    url: string,
    init: RequestInit,
    toMessage: (body: unknown) => string,
    genericError: string,
    fetchImpl: typeof fetch,
): Promise<ClientMutationResult> {
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

export function submitClientUpdate(
    clientId: string,
    data: Record<string, unknown>,
    fetchImpl: typeof fetch = fetch,
): Promise<ClientMutationResult> {
    return send(
        `/api/clients/${encodeURIComponent(clientId)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) },
        updateClientErrorMessage,
        UPDATE_CLIENT_GENERIC_ERROR,
        fetchImpl,
    );
}

export function submitClientDelete(
    clientId: string,
    fetchImpl: typeof fetch = fetch,
): Promise<ClientMutationResult> {
    return send(
        `/api/clients/${encodeURIComponent(clientId)}`,
        { method: "DELETE" },
        deleteClientErrorMessage,
        DELETE_CLIENT_GENERIC_ERROR,
        fetchImpl,
    );
}
