import { Prisma } from "@prisma/client";
import { parseMoney } from "./validation/decimal";
import { parseIsoDateOnly } from "./api-input";

/**
 * Entrada de PUT /api/periods/[id]/iibb-position: datos de la DDJJ de IIBB que
 * el estudio carga a mano (estructura del F.5680 Santa Cruz).
 *
 *  - previousBalance: «Saldo a favor de períodos anteriores».
 *  - paymentsOnAccount: «Total de pagos a cuenta».
 *  - otherCredits / otherDebits: «Otros créditos» / «Otros débitos».
 *  - reference: origen del saldo anterior (texto libre, opcional).
 *  - filed: la DDJJ efectivamente presentada (opcional, para controlar contra
 *    el cálculo): verificador, fecha y totales del formulario.
 * Todos los importes >= 0 (CHECK en la base). Reemplazo total.
 */

export const IIBB_POSITION_REFERENCE_MAX = 120;

export interface IibbPositionData {
    previousBalance: Prisma.Decimal;
    paymentsOnAccount: Prisma.Decimal;
    otherCredits: Prisma.Decimal;
    otherDebits: Prisma.Decimal;
    reference: string | null;
    filedVerifier: string | null;
    filedDate: Date | null;
    filedTaxAmount: Prisma.Decimal | null;
    filedDeductionsAmount: Prisma.Decimal | null;
    filedBalanceDgr: Prisma.Decimal | null;
    filedBalanceTaxpayer: Prisma.Decimal | null;
}

export type IibbPositionInput = { ok: true; data: IibbPositionData } | { ok: false; field: string; error: string };

const bad = (field: string, error: string): IibbPositionInput => ({ ok: false, field, error });

const FIELDS = [
    "previousBalance", "paymentsOnAccount", "otherCredits", "otherDebits", "reference",
    "filedVerifier", "filedDate", "filedTaxAmount", "filedDeductionsAmount", "filedBalanceDgr", "filedBalanceTaxpayer",
] as const;

function text(raw: unknown, max: number): { ok: true; value: string | null } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw !== "string") return { ok: false, error: "debe ser texto" };
    const t = raw.trim();
    if (Array.from(t).length > max) return { ok: false, error: `demasiado largo (máximo ${max} caracteres)` };
    for (const ch of t) {
        const c = ch.charCodeAt(0);
        if (c < 0x20 || c === 0x7f) return { ok: false, error: "tiene caracteres de control" };
    }
    return { ok: true, value: t === "" ? null : t };
}

export function buildIibbPositionInput(body: unknown): IibbPositionInput {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("body", "cuerpo inválido");
    const b = body as Record<string, unknown>;
    for (const k of Object.keys(b)) if (!(FIELDS as readonly string[]).includes(k)) return bad(k, "campo no admitido");

    const required = (k: "previousBalance" | "paymentsOnAccount" | "otherCredits" | "otherDebits") => {
        const raw = b[k] === undefined || b[k] === null || b[k] === "" ? "0" : b[k];
        return parseMoney(raw, { allowNegative: false });
    };
    const optional = (k: string) => (b[k] === undefined || b[k] === null || b[k] === "" ? { ok: true as const, value: null } : parseMoney(b[k], { allowNegative: false }));

    const out: Partial<IibbPositionData> = {};
    for (const k of ["previousBalance", "paymentsOnAccount", "otherCredits", "otherDebits"] as const) {
        const r = required(k);
        if (!r.ok) return bad(k, r.error);
        out[k] = r.value;
    }
    for (const k of ["filedTaxAmount", "filedDeductionsAmount", "filedBalanceDgr", "filedBalanceTaxpayer"] as const) {
        const r = optional(k);
        if (!r.ok) return bad(k, r.error);
        out[k] = r.value;
    }
    const ref = text(b.reference, IIBB_POSITION_REFERENCE_MAX);
    if (!ref.ok) return bad("reference", `referencia: ${ref.error}`);
    const ver = text(b.filedVerifier, 20);
    if (!ver.ok) return bad("filedVerifier", `verificador: ${ver.error}`);
    let filedDate: Date | null = null;
    if (b.filedDate !== undefined && b.filedDate !== null && b.filedDate !== "") {
        filedDate = typeof b.filedDate === "string" ? parseIsoDateOnly(b.filedDate) : null;
        if (!filedDate) return bad("filedDate", "fecha de presentación inválida (AAAA-MM-DD)");
    }
    return {
        ok: true,
        data: { ...(out as IibbPositionData), reference: ref.value, filedVerifier: ver.value, filedDate },
    };
}

/** ¿Cambió algo? (comparación exacta de importes, textos y fecha). */
export function iibbPositionChangedFields(before: IibbPositionData | null, next: IibbPositionData): string[] {
    const changed: string[] = [];
    for (const k of FIELDS) {
        const a = before ? before[k] : null;
        const b = next[k];
        const same = a instanceof Prisma.Decimal || b instanceof Prisma.Decimal
            ? (a === null && b instanceof Prisma.Decimal ? b.isZero() && ["previousBalance", "paymentsOnAccount", "otherCredits", "otherDebits"].includes(k) : a !== null && b !== null && new Prisma.Decimal(a as Prisma.Decimal).equals(b as Prisma.Decimal))
            : a instanceof Date || b instanceof Date
                ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime()
                : a === b;
        if (!same) changed.push(k);
    }
    return changed;
}
