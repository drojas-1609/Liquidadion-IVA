/**
 * IIBB F2: revisión anual de alícuotas de un cliente (lógica pura).
 *
 * Criterio del estudio (26/11/2026): la revisión se hace dentro de la ficha de
 * cada cliente, para el AÑO EN CURSO (la ficha representa ese año). Por cada
 * alícuota de la ficha compara la del año anterior, la actual y la que sugiere
 * el conjunto de reglas aprobado del año, con los ingresos del año anterior.
 * Nunca decide sola:
 * - una sugerencia ÚNICA (sin condiciones pendientes) se puede aplicar como
 *   sugerencia confirmada;
 * - cualquier alícuota informada se puede «mantener» para el año: queda
 *   registrada en las alícuotas del año, con quién y cuándo;
 * - elegir entre alternativas (hechos declarados) se hace en la ficha.
 */
import { suggestRate, type RateAlternative, type RateSuggestion } from "../iibb-rates/suggest";
import type { RateRuleSet } from "../iibb-rates/types";
import type { IibbRegistration } from "./registration";

export type ReviewStatus = "CONFIRMADA" | "IGUAL" | "CAMBIA" | "COINCIDE_ALTERNATIVA" | "REQUIERE_DECISION" | "SIN_REGLA";

export interface ReviewRateInput {
    /** Id de la alícuota de la ficha (ClientActivityRate). */
    rateId: string;
    jurisdictionCode: string;
    activityCode: string;
    description: string;
    nomenclator: string;
    catalogId: string | null;
    rate: string | null;
    treatment: "RATE" | "EXEMPT";
    origin: "STUDIO_MANUAL" | "CONFIRMED_SUGGESTION" | null;
    ruleRef: string | null;
    minimum: string | null;
}

export interface ReviewPrior {
    rate: string | null;
    treatment: "RATE" | "EXEMPT";
    minimum: string | null;
}

export interface ReviewRow extends ReviewRateInput {
    prior: ReviewPrior | null;
    /** Fecha (AAAA-MM-DD) en que quedó confirmada para el año con el valor actual de la ficha; null si no. */
    yearConfirmedAt: string | null;
    status: ReviewStatus;
    /** Sugerencia única (si la hay). */
    suggestion: RateAlternative | null;
    /** Alternativas de la norma (para mostrar). */
    alternatives: RateAlternative[];
    message: string | null;
}

const num = (v: string | null | undefined) => (v == null || v === "" ? null : Number(v));
const sameValue = (a: { rate: string | null; treatment: string; minimum: string | null }, b: { rate: string | null; treatment: string; minimum: string | null }) =>
    a.treatment === b.treatment && num(a.rate) === num(b.rate) && num(a.minimum) === num(b.minimum);

const valueOf = (a: RateAlternative) => ({ rate: a.rate, treatment: a.treatment, minimum: a.minimumMonthly ?? null });
export const isInformedRate = (r: { rate: string | null; treatment: string }) => r.treatment === "EXEMPT" || r.rate !== null;

function messageOf(s: RateSuggestion): string | null {
    if (s.status === "SIN_COBERTURA" || s.status === "SIN_REGLA" || s.status === "NO_APLICA") return s.message;
    if (s.status === "ALTERNATIVAS") {
        const parts = [`${s.alternatives.length} alternativa(s) posibles`];
        if (s.missing.length > 0) parts.push(`falta: ${s.missing.join("; ")}`);
        if (s.held.length > 0) parts.push("hay reglas retenidas");
        return `${parts.join(" · ")}. Resolvela con «Asistencia de alícuota» en Datos del cliente.`;
    }
    return null;
}

export function buildAnnualReview(args: {
    sets: readonly RateRuleSet[];
    /** Fecha de referencia AAAA-MM-DD dentro del año revisado. */
    date: string;
    registration: IibbRegistration | null;
    /** Ingresos brutos del año anterior (string decimal) o null si no se cargaron. */
    priorYearGrossIncome: string | null;
    rates: readonly ReviewRateInput[];
    /** Alícuotas confirmadas del año anterior, por `${jurisdicción}|${actividad}`. */
    prior: ReadonlyMap<string, ReviewPrior>;
    /** Alícuotas ya registradas para el año revisado, con su fecha de confirmación. */
    current?: ReadonlyMap<string, ReviewPrior & { confirmedAt: string }>;
}): ReviewRow[] {
    return args.rates.map((r) => {
        const k = `${r.jurisdictionCode}|${r.activityCode}`;
        const prior = args.prior.get(k) ?? null;
        const y = args.current?.get(k);
        const yearConfirmedAt = y && sameValue(y, r) ? y.confirmedAt : null;
        const s = suggestRate(args.sets, {
            jurisdiction: r.jurisdictionCode,
            nomenclator: r.nomenclator,
            catalogId: r.catalogId,
            code: r.activityCode,
            date: args.date,
            registration: args.registration,
            facts: { priorYearGrossIncome: args.priorYearGrossIncome, declared: {} },
        });
        const informed = isInformedRate(r);
        if (s.status === "ALTERNATIVAS") {
            const match = informed ? s.alternatives.find((a) => sameValue(r, valueOf(a))) : undefined;
            if (match) {
                return { ...r, prior, yearConfirmedAt, status: "COINCIDE_ALTERNATIVA", suggestion: null, alternatives: s.alternatives, message: `Coincide con una alternativa de ${match.norm} (${match.legalReference}), que depende de condiciones que se declaran en la ficha.` };
            }
            return { ...r, prior, yearConfirmedAt, status: "REQUIERE_DECISION", suggestion: null, alternatives: s.alternatives, message: messageOf(s) };
        }
        if (s.status !== "UNICA") return { ...r, prior, yearConfirmedAt, status: "SIN_REGLA", suggestion: null, alternatives: [], message: messageOf(s) };
        const alt = s.alternative;
        const equal = informed && sameValue(r, valueOf(alt));
        const status: ReviewStatus = equal ? (r.origin === "CONFIRMED_SUGGESTION" && r.ruleRef === alt.ruleRef ? "CONFIRMADA" : "IGUAL") : "CAMBIA";
        return { ...r, prior, yearConfirmedAt, status, suggestion: alt, alternatives: [alt], message: alt.caveat ?? null };
    });
}

/** Se puede aplicar la norma (sugerencia única, sin confirmar con esa regla). */
export const canApplyRule = (row: Pick<ReviewRow, "status">) => row.status === "IGUAL" || row.status === "CAMBIA";
/** Se puede mantener el valor actual de la ficha para el año (informado y todavía no registrado con ese valor). */
export const canKeep = (row: Pick<ReviewRow, "rate" | "treatment" | "yearConfirmedAt">) => isInformedRate(row) && row.yearConfirmedAt === null;

export type ReviewAction = { rateId: string; action: "APPLY_RULE"; ruleRef: string } | { rateId: string; action: "KEEP" };

const MAX_ITEMS = 200;

/** Cuerpo: { items: [{ rateId, action: "APPLY_RULE", ruleRef } | { rateId, action: "KEEP" }] }. El servidor recalcula todo y nunca toma una tasa del cliente. */
export function parseAnnualReviewBody(body: unknown): { ok: true; items: ReviewAction[] } | { ok: false; error: string; field: string } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "cuerpo inválido", field: "body" };
    const items = (body as Record<string, unknown>).items;
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "no hay alícuotas para confirmar", field: "items" };
    if (items.length > MAX_ITEMS) return { ok: false, error: `máximo ${MAX_ITEMS} alícuotas por vez`, field: "items" };
    const out: ReviewAction[] = [];
    const seen = new Set<string>();
    for (const [i, it] of items.entries()) {
        if (typeof it !== "object" || it === null || Array.isArray(it)) return { ok: false, error: "ítem inválido", field: `items[${i}]` };
        const x = it as Record<string, unknown>;
        if (typeof x.rateId !== "string" || !/^[a-z0-9]{10,40}$/i.test(x.rateId)) return { ok: false, error: "alícuota inválida", field: `items[${i}].rateId` };
        if (seen.has(x.rateId)) return { ok: false, error: "alícuota repetida", field: `items[${i}].rateId` };
        seen.add(x.rateId);
        if (x.action === "KEEP") out.push({ rateId: x.rateId, action: "KEEP" });
        else if (x.action === "APPLY_RULE") {
            if (typeof x.ruleRef !== "string" || x.ruleRef.length > 200 || !x.ruleRef.includes("#")) return { ok: false, error: "regla inválida", field: `items[${i}].ruleRef` };
            out.push({ rateId: x.rateId, action: "APPLY_RULE", ruleRef: x.ruleRef });
        } else return { ok: false, error: "acción inválida", field: `items[${i}].action` };
    }
    return { ok: true, items: out };
}
