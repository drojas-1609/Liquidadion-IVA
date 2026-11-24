/** Validación de los cuerpos de configuración y asignación de actividades de IIBB (lógica pura). */

type Result<T> = { ok: true; value: T } | { ok: false; field: string; error: string };
const bad = (field: string, error: string): Result<never> => ({ ok: false, field, error });
const CODE_RE = /^[0-9A-Za-z.-]{1,12}$/;

export interface ActivityConfigInput {
    principalCode: string | null;
    pos: { pointOfSale: number; activityCode: string }[];
}

/** { principalCode, pos: [{ pointOfSale, activityCode }] }; los códigos deben ser actividades del cliente. */
export function buildActivityConfigInput(body: unknown, clientCodes: readonly string[]): Result<ActivityConfigInput> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!["principalCode", "pos"].includes(k)) return bad(k, "campo no admitido");
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
    return { ok: true, value: { principalCode, pos } };
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
