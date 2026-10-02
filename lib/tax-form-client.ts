/**
 * Traducción de errores de la API del alta de retenciones/percepciones
 * (POST /api/taxes) a un mensaje legible.
 *
 * La API responde `{ error: { code, message }, field? }` (authErrorBody); se
 * admite también la forma antigua `{ error: "texto", field? }`. Nunca se
 * convierte un objeto a string de forma implícita. 409 PERIOD_BUSY y el resto
 * de los errores con mensaje muestran el mensaje exacto del servidor.
 */
import { readApiError } from "@/lib/new-client-submit";

export const TAX_GENERIC_ERROR = "Error al crear el registro";

export function taxErrorMessage(body: unknown): string {
    const message = readApiError(body)?.message;
    if (!message) return TAX_GENERIC_ERROR;
    const field = (body as { field?: unknown }).field;
    return typeof field === "string" && field.trim() !== "" ? `${field.trim()}: ${message}` : message;
}
