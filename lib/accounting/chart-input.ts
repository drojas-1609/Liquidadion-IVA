import { ACCOUNT_ROLES, CHART_MODELS, isAccountCode, isImputableCode, type AccountRole, type ChartModel } from "./chart-models";

/**
 * Validación (pura) de las altas y cambios del plan de cuentas del cliente.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; field: string; error: string };
const bad = <T>(field: string, error: string): Result<T> => ({ ok: false, field, error });

export const ACCOUNT_NAME_MAX = 120;

function name(raw: unknown): Result<string> {
    if (typeof raw !== "string" || raw.trim() === "") return bad("name", "nombre de la cuenta requerido");
    const t = raw.replace(/\s+/g, " ").trim();
    if (Array.from(t).length > ACCOUNT_NAME_MAX) return bad("name", `nombre demasiado largo (máximo ${ACCOUNT_NAME_MAX})`);
    if (/[\u0000-\u001f\u007f]/.test(t)) return bad("name", "el nombre tiene caracteres de control");
    return { ok: true, value: t };
}

function role(raw: unknown): Result<AccountRole | null> {
    if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
    return typeof raw === "string" && (ACCOUNT_ROLES as readonly string[]).includes(raw) ? { ok: true, value: raw as AccountRole } : bad("role", "uso automático inválido");
}

/** Código padre que debe existir: «1.01» para «1.01.02.03», «1» para «1.01». */
export function parentCode(code: string): string | null {
    if (isImputableCode(code)) return code.slice(0, 4);
    if (/^\d\.\d{2}$/.test(code)) return code.slice(0, 1);
    return null;
}

export interface AccountCreate { code: string; name: string; imputable: boolean; role: AccountRole | null }

export function buildAccountCreate(body: unknown): Result<AccountCreate> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!["code", "name", "role"].includes(k)) return bad(k, "campo no admitido");
    const code = typeof b.code === "string" ? b.code.trim() : "";
    if (!isAccountCode(code)) return bad("code", "código inválido: usá «C», «C.RR» o «C.RR.CC.SS» (capítulos 1 a 5)");
    const n = name(b.name);
    if (!n.ok) return n;
    const r = role(b.role);
    if (!r.ok) return r;
    const imputable = isImputableCode(code);
    if (r.value && !imputable) return bad("role", "sólo una cuenta imputable puede tener un uso automático");
    return { ok: true, value: { code, name: n.value, imputable, role: r.value } };
}

export interface AccountUpdate { name?: string; active?: boolean; role?: AccountRole | null }

export function buildAccountUpdate(body: unknown): Result<AccountUpdate> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!["name", "active", "role"].includes(k)) return bad(k, "campo no admitido");
    const out: AccountUpdate = {};
    if (b.name !== undefined) {
        const n = name(b.name);
        if (!n.ok) return n;
        out.name = n.value;
    }
    if (b.active !== undefined) {
        if (typeof b.active !== "boolean") return bad("active", "active debe ser booleano");
        out.active = b.active;
    }
    if (b.role !== undefined) {
        const r = role(b.role);
        if (!r.ok) return r;
        out.role = r.value;
    }
    if (Object.keys(out).length === 0) return bad("body", "no hay cambios");
    return { ok: true, value: out };
}

export function buildApplyModel(body: unknown): Result<ChartModel> {
    const m = typeof body === "object" && body !== null ? (body as Record<string, unknown>).model : undefined;
    return (CHART_MODELS as readonly unknown[]).includes(m) ? { ok: true, value: m as ChartModel } : bad("model", "plan modelo inválido");
}
