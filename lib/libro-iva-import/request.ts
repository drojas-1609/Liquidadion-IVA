import type { LidCategory } from "./format";
import { CORRECTABLE_AMOUNTS, OPERATION_CODES, type CorrectableAmount, type ImportCorrections, type ImportSource } from "./build";
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
    /** LID_TXT (par de TXT), PORTAL_CSV (descarga de Portal IVA) o MIS_COMPROBANTES (consulta de Mis Comprobantes): las dos últimas, un CSV o ZIP en vouchersFile. */
    format: ImportSource;
    vouchers: Uint8Array;
    aliquots: Uint8Array;
    token: string | null;
    acceptPartial: boolean;
    /**
     * true: los comprobantes IMPORTADOS que se eliminaron de la app y vuelven a
     * venir en el archivo se importan de nuevo (confirmación expresa). false
     * (por defecto): quedan para revisar.
     */
    reimportDeleted: boolean;
    /** true: las ventas con documento 99 sin denominación toman la leyenda «CONSUMIDOR FINAL» (confirmación expresa). */
    consumerFinalLegend: boolean;
    /** Correcciones elegidas por la persona para filas pendientes (ver parseCorrections). */
    corrections?: ImportCorrections;
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
    if (format !== "LID_TXT" && format !== "PORTAL_CSV" && format !== "MIS_COMPROBANTES") return { ok: false, field: "format", error: "format debe ser LID_TXT, PORTAL_CSV o MIS_COMPROBANTES" };
    const vouchers = decodeFile(b.vouchersFile, format === "PORTAL_CSV" ? "la descarga de Portal IVA" : format === "MIS_COMPROBANTES" ? "la consulta de Mis Comprobantes" : "comprobantes");
    if (!vouchers.ok) return { ok: false, field: "vouchersFile", error: vouchers.error };
    let aliquots: { ok: true; bytes: Uint8Array } | { ok: false; error: string } = { ok: true, bytes: new Uint8Array(0) };
    if (format === "LID_TXT") aliquots = decodeFile(b.aliquotsFile, "alícuotas");
    else if (b.aliquotsFile !== undefined) return { ok: false, field: "aliquotsFile", error: "la descarga es un único archivo: no se envía archivo de alícuotas" };
    if (!aliquots.ok) return { ok: false, field: "aliquotsFile", error: aliquots.error };
    let token: string | null = null;
    if (opts.requireToken) {
        if (typeof b.token !== "string" || !/^[a-f0-9]{64}$/.test(b.token)) return { ok: false, field: "token", error: "token de vista previa requerido" };
        token = b.token;
        if (!isOperationId(b.operationId)) return { ok: false, field: "operationId", error: "operationId requerido (UUID en minúsculas generado al confirmar)" };
        if (b.attemptId !== undefined && !isOperationId(b.attemptId)) return { ok: false, field: "attemptId", error: "attemptId debe ser un UUID en minúsculas" };
    }
    if (b.acceptPartial !== undefined && typeof b.acceptPartial !== "boolean") return { ok: false, field: "acceptPartial", error: "acceptPartial debe ser booleano" };
    if (b.reimportDeleted !== undefined && typeof b.reimportDeleted !== "boolean") return { ok: false, field: "reimportDeleted", error: "reimportDeleted debe ser booleano" };
    if (b.consumerFinalLegend !== undefined && typeof b.consumerFinalLegend !== "boolean") return { ok: false, field: "consumerFinalLegend", error: "consumerFinalLegend debe ser booleano" };
    const corrections = parseCorrections(b.corrections);
    if (!corrections.ok) return { ok: false, field: "corrections", error: corrections.error };
    return {
        ok: true,
        data: { clientId: b.clientId, category: b.category, format, vouchers: vouchers.bytes, aliquots: aliquots.bytes, token, acceptPartial: b.acceptPartial === true, reimportDeleted: b.reimportDeleted === true,
            consumerFinalLegend: b.consumerFinalLegend === true,
            ...(corrections.value ? { corrections: corrections.value } : {}),
            operationId: opts.requireToken ? (b.operationId as string) : null,
            attemptId: opts.requireToken && typeof b.attemptId === "string" ? b.attemptId : null },
    };
}

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;
const MAX_CORRECTED_LINES = 20000;

/**
 * Valida las correcciones de filas pendientes. Sólo admite códigos de la tabla
 * oficial de códigos de operación e importes positivos con dos decimales; la
 * forma normalizada es la que entra en el token de la vista previa.
 */
export function parseCorrections(raw: unknown): { ok: true; value: ImportCorrections | undefined } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true, value: undefined };
    if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "corrections debe ser un objeto" };
    const c = raw as Record<string, unknown>;
    const allowed = new Set(["acceptRounding", "acceptReportedVat", "exemptSaleOperationCode", "zeroRateOperationCode", "lineAmounts"]);
    if (Object.keys(c).some((key) => !allowed.has(key))) return { ok: false, error: "corrección desconocida" };
    const value: ImportCorrections = {};
    if (c.acceptRounding !== undefined) {
        if (typeof c.acceptRounding !== "boolean") return { ok: false, error: "acceptRounding debe ser booleano" };
        if (c.acceptRounding) value.acceptRounding = true;
    }
    if (c.acceptReportedVat !== undefined) {
        if (typeof c.acceptReportedVat !== "boolean") return { ok: false, error: "acceptReportedVat debe ser booleano" };
        if (c.acceptReportedVat) value.acceptReportedVat = true;
    }
    for (const key of ["exemptSaleOperationCode", "zeroRateOperationCode"] as const) {
        const code = c[key];
        if (code === undefined || code === null || code === "") continue;
        if (typeof code !== "string" || !OPERATION_CODES.has(code)) return { ok: false, error: `${key}: código fuera de la tabla oficial` };
        value[key] = code;
    }
    if (c.lineAmounts !== undefined) {
        if (!c.lineAmounts || typeof c.lineAmounts !== "object" || Array.isArray(c.lineAmounts)) return { ok: false, error: "lineAmounts debe ser un objeto" };
        const entries = Object.entries(c.lineAmounts as Record<string, unknown>);
        if (entries.length > MAX_CORRECTED_LINES) return { ok: false, error: "demasiadas líneas corregidas" };
        const lines: NonNullable<ImportCorrections["lineAmounts"]> = {};
        for (const [line, amounts] of entries.sort(([a], [b]) => Number(a) - Number(b))) {
            if (!/^[1-9]\d{0,6}$/.test(line) || !amounts || typeof amounts !== "object" || Array.isArray(amounts)) return { ok: false, error: "línea corregida inválida" };
            const fields: Partial<Record<CorrectableAmount, string>> = {};
            for (const [field, amount] of Object.entries(amounts as Record<string, unknown>)) {
                if (!(CORRECTABLE_AMOUNTS as readonly string[]).includes(field)) return { ok: false, error: `importe no corregible: ${field}` };
                if (typeof amount !== "string" || !AMOUNT.test(amount)) return { ok: false, error: "importe corregido inválido" };
                const [units, cents = ""] = amount.split(".");
                fields[field as CorrectableAmount] = `${units.replace(/^0+(?=\d)/, "")}.${cents.padEnd(2, "0")}`;
            }
            if (Object.keys(fields).length) lines[line] = Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
        }
        if (Object.keys(lines).length) value.lineAmounts = lines;
    }
    return { ok: true, value: Object.keys(value).length ? value : undefined };
}
