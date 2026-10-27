/**
 * Validación estructural de un conjunto de reglas de alícuotas. Pura. Un
 * conjunto con problemas nunca se usa para sugerir.
 */
import { checkRateString } from "../client-profile";
import { isJurisdictionCode } from "../iibb/jurisdictions";
import { isIibbRegistration } from "../iibb/registration";
import { CATALOG_CODE_RE } from "../activity-catalog/validate";
import { RULES_REVIEW_LEVELS, validateReview } from "../activity-catalog/review";
import type { RateRuleSet } from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d+(\.\d{1,2})?$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;
const RULE_ID_RE = /^[A-Za-z0-9._-]{1,60}$/;

export function validateRuleSet(raw: unknown): string[] {
    const p: string[] = [];
    if (typeof raw !== "object" || raw === null) return ["el conjunto no es un objeto"];
    const { manifest: m, rules } = raw as Partial<RateRuleSet>;
    if (typeof m !== "object" || m === null) return ["falta el manifiesto"];
    if (typeof m.id !== "string" || !ID_RE.test(m.id)) p.push("id inválido");
    if (!isJurisdictionCode(m.jurisdiction)) p.push("jurisdicción inválida");
    if (m.nomenclator !== "NAES" && m.nomenclator !== "PROVINCIAL") p.push("nomenclador inválido");
    if (!Array.isArray(m.catalogIds) || m.catalogIds.length === 0) p.push("catalogIds requerido");
    for (const k of ["organism", "norm", "sourceUrl", "version"] as const) if (typeof m[k] !== "string" || m[k].trim() === "") p.push(`falta ${k}`);
    for (const k of ["publishedAt", "consultedAt", "validFrom"] as const) if (typeof m[k] !== "string" || !ISO_DATE.test(m[k])) p.push(`${k} inválido`);
    if (m.validTo !== null && (typeof m.validTo !== "string" || !ISO_DATE.test(m.validTo))) p.push("validTo inválido");
    if (typeof m.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sourceSha256)) p.push("sourceSha256 inválido");
    p.push(...validateReview(m.review, RULES_REVIEW_LEVELS));

    if (!Array.isArray(rules)) return [...p, "faltan las reglas"];
    const ids = new Set<string>();
    rules.forEach((r, i) => {
        const at = `regla ${i + 1}`;
        if (typeof r?.id !== "string" || !RULE_ID_RE.test(r.id) || ids.has(r.id)) p.push(`${at}: id inválido o repetido`);
        else ids.add(r.id);
        if (!Array.isArray(r.activityCodes) || r.activityCodes.length === 0 || !r.activityCodes.every((c) => typeof c === "string" && CATALOG_CODE_RE.test(c))) {
            p.push(`${at}: códigos inválidos`);
        }
        if (!Array.isArray(r.registrations) || !r.registrations.every(isIibbRegistration)) p.push(`${at}: inscripciones inválidas`);
        for (const k of ["validFrom", "validTo"] as const) if (r[k] !== null && (typeof r[k] !== "string" || !ISO_DATE.test(r[k]!))) p.push(`${at}: ${k} inválido`);
        if (r.treatment === "RATE") {
            if (typeof r.rate !== "string" || checkRateString(r.rate) !== null) p.push(`${at}: tasa inválida`);
        } else if (r.treatment === "EXEMPT") {
            if (r.rate !== null) p.push(`${at}: una exención no lleva tasa`);
        } else p.push(`${at}: tratamiento inválido`);
        if (typeof r.legalReference !== "string" || r.legalReference.trim() === "") p.push(`${at}: falta la referencia legal`);
        if (r.pendingInterpretation !== undefined && (typeof r.pendingInterpretation !== "string" || r.pendingInterpretation.trim() === "")) {
            p.push(`${at}: pendingInterpretation debe describir la interpretación pendiente`);
        }
        if (r.sourceUrl !== undefined && (typeof r.sourceUrl !== "string" || !/^https:\/\//.test(r.sourceUrl))) p.push(`${at}: sourceUrl debe ser https`);
        if (!Array.isArray(r.conditions)) p.push(`${at}: condiciones inválidas`);
        else
            r.conditions.forEach((c, k) => {
                if (typeof c?.description !== "string" || c.description.trim() === "") p.push(`${at}, condición ${k + 1}: falta descripción`);
                if (c?.kind === "PRIOR_YEAR_GROSS_INCOME") {
                    if (c.minExclusive === null && c.maxInclusive === null) p.push(`${at}, condición ${k + 1}: umbral sin límites`);
                    for (const v of [c.minExclusive, c.maxInclusive]) if (v !== null && !MONEY.test(v)) p.push(`${at}, condición ${k + 1}: monto inválido`);
                } else if (c?.kind === "DECLARED_FACT") {
                    if (typeof c.factKey !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/.test(c.factKey) || typeof c.expected !== "boolean") p.push(`${at}, condición ${k + 1}: hecho inválido`);
                } else p.push(`${at}, condición ${k + 1}: tipo desconocido`);
            });
    });
    return p;
}
