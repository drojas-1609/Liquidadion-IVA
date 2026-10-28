/**
 * Asistencia de alícuotas: dada una actividad (nomenclador + código), una
 * jurisdicción, una fecha, la inscripción y los datos conocidos del cliente,
 * devuelve las alternativas VERIFICADAS que podrían aplicar y los datos que
 * faltan para decidir. Nunca completa una tasa por sí sola: toda sugerencia
 * requiere confirmación del estudio, y con datos faltantes o varias
 * alternativas no hay una única respuesta.
 *
 * No calcula Convenio Multilateral (coeficientes, distribución de base) ni
 * interviene en la liquidación.
 */
import { isValidOn } from "../activity-catalog/validate";
import { CATALOG_REVIEW_LEVELS, RULES_REVIEW_LEVELS, isApproved } from "../activity-catalog/review";
import type { CatalogFile } from "../activity-catalog/types";
import type { IibbRegistration } from "../iibb/registration";
import { ruleRef, type RateFacts, type RateRule, type RateRuleSet, type RuleCondition } from "./types";

export interface RateQuery {
    jurisdiction: string;
    nomenclator: string;
    /** Catálogo de la actividad, si se eligió de un catálogo. */
    catalogId: string | null;
    code: string;
    /** Fecha de referencia AAAA-MM-DD. */
    date: string;
    registration: IibbRegistration | null;
    facts: RateFacts;
}

export interface RateAlternative {
    ruleRef: string;
    treatment: RateRule["treatment"];
    rate: string | null;
    validFrom: string;
    validTo: string | null;
    norm: string;
    legalReference: string;
    sourceUrl: string;
    /** `factKey`/`expected` sólo en hechos declarables por el estudio (DECLARED_FACT). */
    conditions: Array<{ description: string; status: "CUMPLE" | "DESCONOCIDO"; factKey?: string; expected?: boolean }>;
}

export type RateSuggestion =
    | { status: "SIN_COBERTURA"; message: string }
    | { status: "SIN_REGLA"; message: string; norm: string }
    | { status: "NO_APLICA"; message: string; norm: string }
    | { status: "UNICA"; alternative: RateAlternative }
    /** `held`: interpretaciones pendientes de reglas RETENIDAS que también podrían aplicar (no se ofrecen). */
    | { status: "ALTERNATIVAS"; alternatives: RateAlternative[]; missing: string[]; held: string[] };

/** Compara montos decimales (hasta 2 decimales) como strings, sin flotantes: -1, 0 o 1. */
export function compareMoney(a: string, b: string): number {
    const parts = (s: string) => {
        const [i, f = ""] = s.split(".");
        return { int: i.replace(/^0+(?=\d)/, ""), frac: (f + "00").slice(0, 2) };
    };
    const x = parts(a);
    const y = parts(b);
    if (x.int.length !== y.int.length) return x.int.length < y.int.length ? -1 : 1;
    // Misma longitud entera: la comparación lexicográfica de dígitos es numérica.
    const p = `${x.int}.${x.frac}`;
    const q = `${y.int}.${y.frac}`;
    return p < q ? -1 : p > q ? 1 : 0;
}

type CondStatus = "CUMPLE" | "NO_CUMPLE" | "DESCONOCIDO";

function evalCondition(c: RuleCondition, facts: RateFacts): { status: CondStatus; missing: string | null } {
    if (c.kind === "PRIOR_YEAR_GROSS_INCOME") {
        const v = facts.priorYearGrossIncome;
        if (v === undefined || v === null || !/^\d+(\.\d{1,2})?$/.test(v)) {
            return { status: "DESCONOCIDO", missing: "Ingresos brutos anuales del ejercicio anterior" };
        }
        if (c.minExclusive !== null && !(compareMoney(v, c.minExclusive) > 0)) return { status: "NO_CUMPLE", missing: null };
        if (c.maxInclusive !== null && !(compareMoney(v, c.maxInclusive) <= 0)) return { status: "NO_CUMPLE", missing: null };
        return { status: "CUMPLE", missing: null };
    }
    const declared = facts.declared?.[c.factKey];
    if (declared === undefined) return { status: "DESCONOCIDO", missing: c.description };
    return { status: declared === c.expected ? "CUMPLE" : "NO_CUMPLE", missing: null };
}

export function suggestRate(sets: readonly RateRuleSet[], q: RateQuery): RateSuggestion {
    const covering = sets.filter(
        ({ manifest: m }) =>
            isApproved(m.review, RULES_REVIEW_LEVELS) &&
            m.jurisdiction === q.jurisdiction &&
            m.nomenclator === q.nomenclator &&
            (q.catalogId === null || m.catalogIds.includes(q.catalogId)) &&
            isValidOn(m, q.date),
    );
    if (covering.length === 0) {
        return {
            status: "SIN_COBERTURA",
            message: `No hay reglas verificadas para esta jurisdicción, nomenclador y fecha. Alícuota pendiente de determinar.`,
        };
    }
    if (covering.length > 1) {
        // Dos normas vigentes para lo mismo es un error de datos: no se elige una.
        return { status: "SIN_COBERTURA", message: "Hay más de un conjunto de reglas vigente para la fecha: revisar la carga de normas. Alícuota pendiente de determinar." };
    }
    const set = covering[0];
    const m = set.manifest;
    const withCode = set.rules.filter((r) => r.activityCodes.includes(q.code));
    // Reglas retenidas (interpretación pendiente): nunca se ofrecen como alternativa.
    const forCode = withCode.filter((r) => r.pendingInterpretation === undefined);
    if (forCode.length === 0) {
        const held = withCode.length > 0 ? " Hay reglas cargadas para este código, retenidas hasta que el estudio decida su interpretación." : "";
        return { status: "SIN_REGLA", norm: m.norm, message: `${m.norm} no tiene una regla habilitada para el código ${q.code}.${held} Alícuota pendiente de determinar.` };
    }

    const missing = new Set<string>();
    const alternatives: RateAlternative[] = [];
    for (const r of forCode) {
        const from = r.validFrom ?? m.validFrom;
        const to = r.validTo ?? m.validTo;
        if (!isValidOn({ validFrom: from, validTo: to }, q.date)) continue;
        if (r.registrations.length > 0) {
            if (q.registration === null) missing.add("Inscripción en Ingresos Brutos");
            else if (!r.registrations.includes(q.registration)) continue;
        }
        const evals = r.conditions.map((c) => ({ c, ...evalCondition(c, q.facts) }));
        if (evals.some((e) => e.status === "NO_CUMPLE")) continue;
        for (const e of evals) if (e.missing) missing.add(e.missing);
        alternatives.push({
            ruleRef: ruleRef(m.id, r.id),
            treatment: r.treatment,
            rate: r.rate,
            validFrom: from,
            validTo: to,
            norm: m.norm,
            legalReference: r.legalReference,
            sourceUrl: r.sourceUrl ?? m.sourceUrl,
            conditions: evals.map((e) => ({
                description: e.c.description,
                status: e.status === "CUMPLE" ? "CUMPLE" : "DESCONOCIDO",
                ...(e.c.kind === "DECLARED_FACT" ? { factKey: e.c.factKey, expected: e.c.expected } : {}),
            })),
        });
    }
    // Retenidas vigentes en la fecha: impiden presentar la respuesta como única o como «no aplica».
    const held = [
        ...new Set(
            withCode
                .filter((r) => r.pendingInterpretation !== undefined && isValidOn({ validFrom: r.validFrom ?? m.validFrom, validTo: r.validTo ?? m.validTo }, q.date))
                .map((r) => r.pendingInterpretation!),
        ),
    ];
    if (alternatives.length === 0) {
        if (held.length > 0) {
            return {
                status: "SIN_REGLA",
                norm: m.norm,
                message: `Las reglas de ${m.norm} para el código ${q.code} en esta fecha están retenidas hasta que el estudio decida su interpretación. Alícuota pendiente de determinar.`,
            };
        }
        return { status: "NO_APLICA", norm: m.norm, message: `Ninguna regla de ${m.norm} aplica con los datos y la fecha indicados. Alícuota pendiente de determinar.` };
    }
    const registrationUnknown = q.registration === null && forCode.some((r) => r.registrations.length > 0);
    const allKnown = alternatives.length === 1 && !registrationUnknown && held.length === 0 && alternatives[0].conditions.every((c) => c.status === "CUMPLE");
    if (allKnown) return { status: "UNICA", alternative: alternatives[0] };
    return { status: "ALTERNATIVAS", alternatives, missing: [...missing].sort(), held };
}

/** Busca una regla HABILITADA por referencia en conjuntos aprobados (verificación del servidor al confirmar). */
export function findRule(sets: readonly RateRuleSet[], ref: string): { set: RateRuleSet; rule: RateRule } | null {
    const [setId, ruleId] = ref.split("#");
    const set = sets.find((s) => s.manifest.id === setId && isApproved(s.manifest.review, RULES_REVIEW_LEVELS));
    const rule = set?.rules.find((r) => r.id === ruleId && r.pendingInterpretation === undefined);
    return set && rule ? { set, rule } : null;
}

/**
 * Conjuntos utilizables: sólo los que tienen al menos un catálogo de sus
 * `catalogIds` aprobado. Un conjunto de reglas no se publica antes que su
 * nomenclador (la revisión del catálogo es independiente y previa).
 */
export function withApprovedCatalog(sets: readonly RateRuleSet[], catalogs: readonly CatalogFile[]): RateRuleSet[] {
    const approved = new Set(catalogs.filter((c) => isApproved(c.manifest.review, CATALOG_REVIEW_LEVELS)).map((c) => c.manifest.id));
    return sets.filter((s) => s.manifest.catalogIds.some((id) => approved.has(id)));
}
