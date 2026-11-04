import type { LidCategory } from "./format";
import type { ImportSource } from "./build";
import { isOperationId } from "./operation";

/**
 * Cuerpo de las rutas de importación del Libro IVA Digital. Los archivos viajan
 * en base64 dentro de JSON (sin multipart). Límite por archivo: 2 MB sin
 * codificar, para que ambos archivos y el JSON queden por debajo del máximo
 * de 6 MB de una solicitud a Netlify Functions. (El Libro IVA Digital admite
 * hasta 10 MB por archivo: los más grandes se dividen por período o libro.)
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ImportRequest {
    clientId: string;
    category: LidCategory;
    /** LID_TXT (par de TXT) o PORTAL_CSV (descarga de Portal IVA: un CSV o ZIP en vouchersFile). */
    format: ImportSource;
    vouchers: Uint8Array;
    aliquots: Uint8Array;
    token: string | null;
    acceptPartial: boolean;
    /** Sólo confirmación: identificador de la operación generado por el navegador (UUID). */
    operationId: string | null;
    /** Sólo confirmación, opcional: identificador de ESTE envío (UUID). Un reintento de la misma operación lleva otro. */
    attemptId: string | null;
}

export type ImportRequestResult = { ok: true; data: ImportRequest } | { ok: false; field: string; error: string };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeFile(v: unknown, label: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
    if (typeof v !== "string" || v.length === 0) return { ok: false, error: `archivo de ${label} requerido` };
    if (v.length % 4 !== 0 || !BASE64_RE.test(v)) return { ok: false, error: `archivo de ${label} mal codificado` };
    if ((v.length / 4) * 3 > MAX_FILE_BYTES + 3) return { ok: false, error: `archivo de ${label} demasiado grande (máximo 2 MB)` };
    const bytes = Uint8Array.from(Buffer.from(v, "base64"));
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: `archivo de ${label} demasiado grande (máximo 2 MB)` };
    return { ok: true, bytes };
}

export function parseImportRequest(body: unknown, opts: { requireToken: boolean }): ImportRequestResult {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, field: "body", error: "cuerpo inválido" };
    const b = body as Record<string, unknown>;
    if (typeof b.clientId !== "string" || b.clientId.trim() === "") return { ok: false, field: "clientId", error: "clientId requerido" };
    if (b.category !== "SALES" && b.category !== "PURCHASES") return { ok: false, field: "category", error: "category debe ser SALES o PURCHASES" };
    const format = b.format === undefined ? "LID_TXT" : b.format;
    if (format !== "LID_TXT" && format !== "PORTAL_CSV") return { ok: false, field: "format", error: "format debe ser LID_TXT o PORTAL_CSV" };
    const vouchers = decodeFile(b.vouchersFile, format === "PORTAL_CSV" ? "la descarga de Portal IVA" : "comprobantes");
    if (!vouchers.ok) return { ok: false, field: "vouchersFile", error: vouchers.error };
    let aliquots: { ok: true; bytes: Uint8Array } | { ok: false; error: string } = { ok: true, bytes: new Uint8Array(0) };
    if (format === "LID_TXT") aliquots = decodeFile(b.aliquotsFile, "alícuotas");
    else if (b.aliquotsFile !== undefined) return { ok: false, field: "aliquotsFile", error: "la descarga de Portal IVA es un único archivo: no se envía archivo de alícuotas" };
    if (!aliquots.ok) return { ok: false, field: "aliquotsFile", error: aliquots.error };
    let token: string | null = null;
    if (opts.requireToken) {
        if (typeof b.token !== "string" || !/^[a-f0-9]{64}$/.test(b.token)) return { ok: false, field: "token", error: "token de vista previa requerido" };
        token = b.token;
        if (!isOperationId(b.operationId)) return { ok: false, field: "operationId", error: "operationId requerido (UUID en minúsculas generado al confirmar)" };
        if (b.attemptId !== undefined && !isOperationId(b.attemptId)) return { ok: false, field: "attemptId", error: "attemptId debe ser un UUID en minúsculas" };
    }
    if (b.acceptPartial !== undefined && typeof b.acceptPartial !== "boolean") return { ok: false, field: "acceptPartial", error: "acceptPartial debe ser booleano" };
    return {
        ok: true,
        data: { clientId: b.clientId, category: b.category, format, vouchers: vouchers.bytes, aliquots: aliquots.bytes, token, acceptPartial: b.acceptPartial === true,
            operationId: opts.requireToken ? (b.operationId as string) : null,
            attemptId: opts.requireToken && typeof b.attemptId === "string" ? b.attemptId : null },
    };
}
