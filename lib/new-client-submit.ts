/**
 * Envío del formulario de alta de clientes y traducción de errores de la API
 * a un mensaje legible y seguro.
 *
 * La API responde errores con la forma estable de `authErrorBody`:
 *   { error: { code, message }, field? }
 * Versiones previas respondían `{ error: "texto", field? }`. Se admiten ambas.
 * Nunca se convierte un objeto a string de forma implícita.
 */

export const NEW_CLIENT_GENERIC_ERROR = "Error al crear el cliente";

/**
 * La única unicidad alcanzable al crear un cliente es @@unique([organizationId, cuit])
 * (el id lo genera la base), así que un CONFLICT significa CUIT repetido.
 */
export const NEW_CLIENT_DUPLICATE_CUIT_ERROR =
    "Ya existe un cliente con ese CUIT en la organización.";

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Extrae `{ code, message }` de un cuerpo de error de la API, o null si no es reconocible. */
function readApiError(body: unknown): { code: string | null; message: string | null } | null {
    if (typeof body !== "object" || body === null) return null;
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return { code: null, message: nonEmptyString(error) };
    if (typeof error === "object" && error !== null) {
        const { code, message } = error as { code?: unknown; message?: unknown };
        return { code: nonEmptyString(code), message: nonEmptyString(message) };
    }
    return null;
}

export function newClientErrorMessage(body: unknown): string {
    const apiError = readApiError(body);
    if (!apiError) return NEW_CLIENT_GENERIC_ERROR;
    if (apiError.code === "CONFLICT") return NEW_CLIENT_DUPLICATE_CUIT_ERROR;
    if (!apiError.message) return NEW_CLIENT_GENERIC_ERROR;

    const field = nonEmptyString((body as { field?: unknown }).field);
    return field ? `${field}: ${apiError.message}` : apiError.message;
}

export type NewClientSubmitResult = { ok: true } | { ok: false; message: string };

export async function submitNewClient(
    data: Record<string, unknown>,
    fetchImpl: typeof fetch = fetch,
): Promise<NewClientSubmitResult> {
    let res: Response;
    try {
        res = await fetchImpl("/api/clients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });
    } catch {
        return { ok: false, message: NEW_CLIENT_GENERIC_ERROR };
    }

    if (res.ok) return { ok: true };

    const body: unknown = await res.json().catch(() => null);
    return { ok: false, message: newClientErrorMessage(body) };
}
