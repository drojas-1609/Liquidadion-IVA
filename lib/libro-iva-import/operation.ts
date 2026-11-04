/**
 * Identificación de cada confirmación de la importación (lógica pura, apta
 * para el navegador y para la API).
 *
 * El navegador genera un `operationId` (UUID) ANTES de enviar la confirmación
 * y lo guarda. El resultado queda en el AuditLog del período:
 *  - `invoice.import` (escrito en la MISMA transacción que los comprobantes):
 *    si existe, la operación se aplicó, completa;
 *  - `invoice.import.failed` (escrito después de que la transacción terminó
 *    con error): la operación no escribió nada.
 * Si todavía no hay ninguna de las dos, la operación sigue en curso mientras
 * no haya pasado RESULT_WAIT_MS desde que se envió: la función de Netlify no
 * puede seguir viva más de 60 s, y si muere, la conexión se cierra y la
 * transacción se revierte. Pasado ese plazo sin registro, no se aplicó.
 */

export const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isOperationId(v: unknown): v is string {
    return typeof v === "string" && OPERATION_ID_RE.test(v);
}

/** Límite síncrono de las funciones de Netlify (60 s) más margen. */
export const RESULT_WAIT_MS = 75_000;

export type OperationStatus = "APPLIED" | "FAILED" | "NOT_FOUND";

export interface OperationResult {
    imported: number;
    turiva: number;
    duplicates: number;
    notImported: number;
}

export interface ImportOperationView {
    operationId: string;
    status: OperationStatus;
    at: string | null;
    category: string | null;
    format: string | null;
    result: OperationResult | null;
    failure: { code: string; httpStatus: number | null } | null;
}

/** Estado que ve el operador para una operación propia, según la API y el tiempo transcurrido. */
export function operatorState(view: Pick<ImportOperationView, "status">, startedAtMs: number, nowMs: number): "APPLIED" | "FAILED" | "IN_PROGRESS" | "NOT_APPLIED" {
    if (view.status === "APPLIED") return "APPLIED";
    if (view.status === "FAILED") return "FAILED";
    return nowMs - startedAtMs < RESULT_WAIT_MS ? "IN_PROGRESS" : "NOT_APPLIED";
}

const FAILURE_TEXT: Record<string, string> = {
    PERIOD_CLOSED: "el período estaba cerrado",
    PERIOD_BUSY: "el período estaba ocupado por otra operación",
    CONFLICT: "la vista previa ya no coincidía con el estado del período o con los archivos",
    UNPROCESSABLE_ENTITY: "los archivos o la confirmación no eran válidos",
    P2028: "se agotó el tiempo de la escritura",
};

export function failureText(code: string): string {
    return FAILURE_TEXT[code] ?? `error interno (${code})`;
}

export function resultText(r: OperationResult): string {
    return `Importados ${r.imported} comprobantes (${r.turiva} de TurIVA). Omitidos por ya cargados: ${r.duplicates}. No importados (error o revisión): ${r.notImported}.`;
}
