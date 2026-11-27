/** Validación de los cuerpos de configuración y asignación de actividades de IIBB (lógica pura). */
import { normalizeCuit } from "../cuit";
import { parseRateMap, PROVIDER_MODES, type ProviderMode, type RateMap } from "./provider-costs";

type Result<T> = { ok: true; value: T } | { ok: false; field: string; error: string };
const bad = (field: string, error: string): Result<never> => ({ ok: false, field, error });
const CODE_RE = /^[0-9A-Za-z.-]{1,12}$/;

export interface ActivityConfigInput {
    principalCode: string | null;
    pos: { pointOfSale: number; activityCode: string }[];
    /** Prestadores (base por diferencia). undefined = no se modifican. */
    providers?: { cuit: string; name: string; activityCode: string; mode: ProviderMode; rateMap: RateMap | null }[];
}

/** CUIT válido (lib/cuit) como 11 dígitos sin separadores; null si es inválido. */
export function cuitDigits(raw: string): string | null {
    const r = normalizeCuit(raw);
    return r.ok ? r.value.replace(/-/g, "") : null;
}

/** { principalCode, pos: [{ pointOfSale, activityCode }] }; los códigos deben ser actividades del cliente. */
export function buildActivityConfigInput(body: unknown, clientCodes: readonly string[]): Result<ActivityConfigInput> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!["principalCode", "pos", "providers"].includes(k)) return bad(k, "campo no admitido");
    const codes = new Set(clientCodes);
    let principalCode: string | null = null;
    if (b.principalCode !== null && b.principalCode !== undefined && b.principalCode !== "") {
        if (typeof b.principalCode !== "string" || !codes.has(b.principalCode)) return bad("principalCode", "la actividad principal debe ser una actividad de la ficha");
        principalCode = b.principalCode;
    }
    if (!Array.isArray(b.pos) || b.pos.length > 200) return bad("pos", "lista de puntos de venta inválida");
    const seen = new Set<number>();
    const pos: ActivityConfigInput["pos"] = [];
    for (const [i, raw] of b.pos.entries()) {
        const r = raw as Record<string, unknown> | null;
        if (!r || typeof r !== "object") return bad(`pos.${i}`, "fila inválida");
        const p = r.pointOfSale;
        if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 99999) return bad(`pos.${i}.pointOfSale`, "punto de venta inválido");
        if (seen.has(p)) return bad(`pos.${i}.pointOfSale`, `el punto de venta ${p} está repetido`);
        seen.add(p);
        if (typeof r.activityCode !== "string" || !codes.has(r.activityCode)) return bad(`pos.${i}.activityCode`, "la actividad debe ser una actividad de la ficha");
        pos.push({ pointOfSale: p, activityCode: r.activityCode });
    }
    if (b.providers === undefined) return { ok: true, value: { principalCode, pos } };
    if (!Array.isArray(b.providers) || b.providers.length > 300) return bad("providers", "lista de prestadores inválida");
    const seenCuit = new Set<string>();
    const providers: NonNullable<ActivityConfigInput["providers"]> = [];
    for (const [i, raw] of b.providers.entries()) {
        const r = raw as Record<string, unknown> | null;
        if (!r || typeof r !== "object") return bad(`providers.${i}`, "fila inválida");
        const cuit = typeof r.cuit === "string" ? cuitDigits(r.cuit) : null;
        if (!cuit) return bad(`providers.${i}.cuit`, "CUIT inválido (11 dígitos con dígito verificador correcto)");
        if (seenCuit.has(cuit)) return bad(`providers.${i}.cuit`, `el CUIT ${cuit} está repetido`);
        seenCuit.add(cuit);
        const name = typeof r.name === "string" ? r.name.trim() : "";
        if (name === "" || name.length > 200) return bad(`providers.${i}.name`, "nombre del prestador obligatorio (hasta 200 caracteres)");
        const mode = r.mode === undefined ? "SINGLE" : r.mode;
        if (typeof mode !== "string" || !(PROVIDER_MODES as readonly string[]).includes(mode)) return bad(`providers.${i}.mode`, "modo de reparto inválido");
        // Actividad por defecto: obligatoria en SINGLE; en los otros modos puede ser "" (lo no mapeado no resta).
        if (typeof r.activityCode !== "string" || (r.activityCode === "" ? mode === "SINGLE" : !codes.has(r.activityCode))) {
            return bad(`providers.${i}.activityCode`, "la actividad debe ser una actividad de la ficha");
        }
        let rateMap: RateMap | null = null;
        if (mode === "BY_VAT_RATE") {
            const m = parseRateMap(r.rateMap ?? {}, codes);
            if (!m.ok) return bad(`providers.${i}.rateMap`, m.error);
            rateMap = m.value;
        } else if (r.rateMap !== undefined && r.rateMap !== null) return bad(`providers.${i}.rateMap`, "el mapa por alícuota sólo va con el modo «por alícuota de IVA»");
        providers.push({ cuit, name, activityCode: r.activityCode, mode: mode as ProviderMode, rateMap });
    }
    return { ok: true, value: { principalCode, pos, providers } };
}

export interface ActivityAssignmentInput {
    assignments: { invoiceId: string; code: string | null }[];
}

/** { assignments: [{ invoiceId, code|null }] }; null quita la corrección manual. */
export function buildActivityAssignmentInput(body: unknown, clientCodes: readonly string[]): Result<ActivityAssignmentInput> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== "assignments") return bad(k, "campo no admitido");
    if (!Array.isArray(b.assignments) || b.assignments.length === 0 || b.assignments.length > 5000) return bad("assignments", "lista de comprobantes inválida");
    const codes = new Set(clientCodes);
    const out: ActivityAssignmentInput["assignments"] = [];
    const seen = new Set<string>();
    for (const [i, raw] of b.assignments.entries()) {
        const r = raw as Record<string, unknown> | null;
        if (!r || typeof r !== "object" || typeof r.invoiceId !== "string" || !/^[a-z0-9]{10,40}$/.test(r.invoiceId)) return bad(`assignments.${i}.invoiceId`, "comprobante inválido");
        if (seen.has(r.invoiceId)) return bad(`assignments.${i}.invoiceId`, "comprobante repetido");
        seen.add(r.invoiceId);
        if (r.code !== null && (typeof r.code !== "string" || !CODE_RE.test(r.code) || !codes.has(r.code))) return bad(`assignments.${i}.code`, "la actividad debe ser una actividad de la ficha");
        out.push({ invoiceId: r.invoiceId, code: r.code as string | null });
    }
    return { ok: true, value: { assignments: out } };
}

export interface GrossIncomeInput {
    incomeYear: number;
    /** null = borrar el dato del año. */
    amount: string | null;
    note: string | null;
}

/** { incomeYear, amount: "1234567,89" | null, note } — monto en pesos, no negativo, con hasta 2 decimales. */
export function buildGrossIncomeInput(body: unknown, thisYear: number): Result<GrossIncomeInput> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!["incomeYear", "amount", "note"].includes(k)) return bad(k, "campo no admitido");
    const y = b.incomeYear;
    if (typeof y !== "number" || !Number.isInteger(y) || y < 2000 || y > thisYear) return bad("incomeYear", `año inválido (2000 a ${thisYear})`);
    let amount: string | null = null;
    if (b.amount !== null && b.amount !== undefined && b.amount !== "") {
        if (typeof b.amount !== "string") return bad("amount", "monto inválido");
        const raw = b.amount.trim().replace(/\s/g, "");
        // Acepta 1.234.567,89 o 1234567.89 / 1234567,89.
        const normalized = /,/.test(raw) ? raw.replace(/\./g, "").replace(",", ".") : raw;
        if (!/^\d{1,16}(\.\d{1,2})?$/.test(normalized)) return bad("amount", "monto inválido: pesos, sin signo, hasta 2 decimales");
        amount = normalized;
    }
    let note: string | null = null;
    if (b.note !== null && b.note !== undefined && b.note !== "") {
        if (typeof b.note !== "string" || b.note.length > 300) return bad("note", "nota inválida (hasta 300 caracteres)");
        note = b.note.trim() || null;
    }
    return { ok: true, value: { incomeYear: y, amount, note } };
}

export interface CostAdjustmentInput {
    adjustments: { activityCode: string; amount: string; note: string }[];
}

/**
 * { adjustments: [{ activityCode, amount: "-1.234,56", note }] } — reemplaza los
 * ajustes del período. Importe con signo (positivo suma costo, negativo resta),
 * hasta 2 decimales; nota obligatoria. Lista vacía = sin ajustes.
 */
export function buildCostAdjustmentInput(body: unknown, clientCodes: readonly string[]): Result<CostAdjustmentInput> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (k !== "adjustments") return bad(k, "campo no admitido");
    if (!Array.isArray(b.adjustments) || b.adjustments.length > 50) return bad("adjustments", "lista de ajustes inválida");
    const codes = new Set(clientCodes);
    const seen = new Set<string>();
    const out: CostAdjustmentInput["adjustments"] = [];
    for (const [i, raw] of b.adjustments.entries()) {
        const r = raw as Record<string, unknown> | null;
        if (!r || typeof r !== "object") return bad(`adjustments.${i}`, "fila inválida");
        if (typeof r.activityCode !== "string" || !codes.has(r.activityCode)) return bad(`adjustments.${i}.activityCode`, "la actividad debe ser una actividad de la ficha");
        if (seen.has(r.activityCode)) return bad(`adjustments.${i}.activityCode`, "actividad repetida");
        seen.add(r.activityCode);
        if (typeof r.amount !== "string") return bad(`adjustments.${i}.amount`, "importe inválido");
        const rawAmount = r.amount.trim().replace(/\s/g, "");
        const normalized = /,/.test(rawAmount) ? rawAmount.replace(/\./g, "").replace(",", ".") : rawAmount;
        if (!/^-?\d{1,16}(\.\d{1,2})?$/.test(normalized) || Number(normalized) === 0) return bad(`adjustments.${i}.amount`, "importe inválido: pesos con signo, hasta 2 decimales y distinto de 0");
        const note = typeof r.note === "string" ? r.note.trim() : "";
        if (note === "" || note.length > 300) return bad(`adjustments.${i}.note`, "nota obligatoria (hasta 300 caracteres)");
        out.push({ activityCode: r.activityCode, amount: normalized, note });
    }
    return { ok: true, value: { adjustments: out } };
}
