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
 * Sólo esos registros permiten afirmar un resultado. Sin ninguno de los dos:
 *  - antes de RESULT_WAIT_MS desde el envío, la operación puede seguir en curso;
 *  - después, el resultado queda SIN CONFIRMAR: el tiempo transcurrido no
 *    prueba que no se haya aplicado (la falla se registra en modo best-effort y
 *    el límite de la función no es una garantía del sistema). El operador puede
 *    volver a verificar con el mismo operationId o reintentar los mismos
 *    archivos, que reutilizan ese operationId (reintento idempotente).
 * Un `invoice.import.failed` describe UN envío (attemptId): la operación sólo
 * falló cuando fallaron todos sus envíos. `invoice.import` siempre tiene prioridad.
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
    /** Sólo en la consulta de UNA operación: envíos (attemptId) con invoice.import.failed propio. */
    failedAttemptIds?: string[];
}

/** Un envío de la confirmación desde esta pantalla. `rejected`: llegó la respuesta de error de la app (ese envío no escribió). */
export interface Attempt {
    attemptId: string;
    startedAt: number;
    rejected?: boolean;
}

export type OperatorState = "APPLIED" | "FAILED" | "IN_PROGRESS" | "UNCONFIRMED";

/**
 * Estado que ve el operador para una operación propia. Sólo afirma con
 * evidencia persistida o recibida:
 *  - APPLIED: existe invoice.import de la operación (de cualquier envío);
 *  - FAILED: TODOS los envíos terminaron sin escribir (invoice.import.failed
 *    con su attemptId, o respuesta de error de la app) y ninguno la aplicó;
 *  - IN_PROGRESS: algún envío sin resultado salió hace menos de RESULT_WAIT_MS;
 *  - UNCONFIRMED: hay envíos sin resultado y ya pasó ese plazo. No se infiere
 *    «no aplicada» por tiempo.
 * Así, la falla de un reintento no se toma como la de un envío anterior que
 * pudo seguir vivo (p. ej. cortado con 504 mientras escribía).
 */
export function operatorState(view: Pick<ImportOperationView, "status" | "failedAttemptIds">, attempts: Attempt[], nowMs: number): OperatorState {
    if (view.status === "APPLIED") return "APPLIED";
    const failed = new Set(view.failedAttemptIds ?? []);
    const open = attempts.filter((a) => !a.rejected && !failed.has(a.attemptId));
    if (attempts.length > 0 && open.length === 0) return "FAILED";
    const latest = Math.max(...open.map((a) => a.startedAt));
    return open.length > 0 && nowMs - latest < RESULT_WAIT_MS ? "IN_PROGRESS" : "UNCONFIRMED";
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
