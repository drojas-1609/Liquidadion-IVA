/**
 * Verificación de procedencia (autoridad: servidor) de la ficha IIBB:
 *
 *  - Una actividad con origen CATALOG debe ser una copia EXACTA de una entrada
 *    de una versión REVISADA del catálogo indicado (código, descripción,
 *    nomenclador, jurisdicción, versión y referencia). El cliente no puede
 *    marcar como "de catálogo" una carga manual ni alterar la copia.
 *  - Una alícuota con origen CONFIRMED_SUGGESTION debe corresponder a una regla
 *    HABILITADA de un conjunto aprobado para esa jurisdicción, nomenclador y
 *    código, con el mismo tratamiento y la misma tasa. Además la regla no puede
 *    depender de hechos que el servidor no puede acreditar al guardar
 *    (condiciones de ingresos o hechos declarados, que no se guardan), y su
 *    inscripción, si la exige, debe coincidir con la de la ficha. Lo que no se
 *    puede acreditar se guarda como decisión del estudio (STUDIO_MANUAL), sin
 *    procedencia normativa.
 *
 * Lo ya GUARDADO y sin cambios no se vuelve a verificar: si después se retira o
 * reemplaza un catálogo o una norma, las fichas existentes siguen pudiendo
 * editarse y conservan su copia (nunca se cambian en silencio).
 *
 * Pura respecto de los datos: recibe los catálogos y las reglas.
 */
import { activityKey, checkRateString, type IibbProfileData } from "./client-profile";
import { findCatalogEntry } from "./activity-catalog/search";
import { CATALOG_REVIEW_LEVELS, isApproved } from "./activity-catalog/review";
import { catalogReferenceLabel, type CatalogFile } from "./activity-catalog/types";
import { findRule } from "./iibb-rates/suggest";
import type { RateRuleSet } from "./iibb-rates/types";

export interface StoredProfileForSources {
    activities: ReadonlyArray<{
        nomenclator: string;
        nomenclatorJurisdiction: string;
        nomenclatorReference: string | null;
        code: string;
        description: string;
        origin: string;
        catalogId: string | null;
        catalogVersion: string | null;
        rates: ReadonlyArray<{ jurisdiction: string; rate: string | null; treatment: string; origin: string | null; ruleRef: string | null }>;
    }>;
}

/** "3.50" y "3.5" son la misma tasa (ya validadas con checkRateString). */
function sameRate(a: string | null, b: string | null): boolean {
    if (a === null || b === null) return a === b;
    const norm = (s: string) => {
        const [i, f = ""] = s.split(".");
        const frac = f.replace(/0+$/, "");
        return `${i.replace(/^0+(?=\d)/, "")}${frac ? `.${frac}` : ""}`;
    };
    return norm(a) === norm(b);
}

export function verifyProfileSources(
    next: Pick<IibbProfileData, "activities" | "registration">,
    stored: StoredProfileForSources | null,
    catalogs: readonly CatalogFile[],
    ruleSets: readonly RateRuleSet[],
): { field: string; error: string } | null {
    const storedByKey = new Map((stored?.activities ?? []).map((a) => [activityKey(a), a]));
    for (const [i, a] of next.activities.entries()) {
        const f = `iibb.activities[${i}]`;
        const prev = storedByKey.get(activityKey(a));

        if (a.origin === "CATALOG") {
            const unchanged =
                prev !== undefined &&
                prev.origin === "CATALOG" &&
                prev.catalogId === a.catalogId &&
                prev.catalogVersion === a.catalogVersion &&
                prev.description === a.description &&
                prev.nomenclatorReference === a.nomenclatorReference;
            if (!unchanged) {
                const found = a.catalogId ? findCatalogEntry(catalogs, a.catalogId, a.code) : null;
                const m = found?.manifest;
                if (!found || !m || !isApproved(m.review, CATALOG_REVIEW_LEVELS)) {
                    return { field: `${f}.code`, error: `el código ${a.code} no figura en un catálogo revisado (${a.catalogId ?? "sin catálogo"})` };
                }
                const expectedJur = m.nomenclator === "PROVINCIAL" ? (m.jurisdiction ?? "") : "";
                if (
                    m.nomenclator !== a.nomenclator ||
                    expectedJur !== a.nomenclatorJurisdiction ||
                    m.version !== a.catalogVersion ||
                    found.entry.description !== a.description ||
                    catalogReferenceLabel(m, found.entry) !== a.nomenclatorReference
                ) {
                    return { field: `${f}.code`, error: "los datos de la actividad no coinciden con el catálogo indicado: elegila de nuevo del buscador o registrala como carga manual" };
                }
            }
        }

        for (const [k, r] of a.rates.entries()) {
            if (r.origin !== "CONFIRMED_SUGGESTION") continue;
            const fr = `${f}.rates[${k}]`;
            const prevRate = prev?.rates.find((x) => x.jurisdiction === r.jurisdiction);
            if (
                prevRate &&
                prevRate.origin === "CONFIRMED_SUGGESTION" &&
                prevRate.ruleRef === r.ruleRef &&
                prevRate.treatment === r.treatment &&
                sameRate(prevRate.rate, r.rate)
            ) {
                // Sin cambios: no se reverifica (la norma pudo retirarse). Pero si la regla
                // sigue publicada y exige una inscripción, un cambio de inscripción la invalida.
                const still = r.ruleRef ? findRule(ruleSets, r.ruleRef) : null;
                if (still && still.rule.registrations.length > 0 && (next.registration === null || !still.rule.registrations.includes(next.registration))) {
                    return { field: fr, error: "la inscripción de la ficha ya no corresponde a la regla de esta alícuota: registrala como decisión del estudio o revisá la inscripción" };
                }
                continue;
            }
            const found = r.ruleRef ? findRule(ruleSets, r.ruleRef) : null;
            if (!found) return { field: fr, error: "la regla de la sugerencia no existe o no está revisada" };
            const { set, rule } = found;
            const catalogOk = a.origin !== "CATALOG" || (a.catalogId !== null && set.manifest.catalogIds.includes(a.catalogId));
            if (set.manifest.jurisdiction !== r.jurisdiction || set.manifest.nomenclator !== a.nomenclator || !rule.activityCodes.includes(a.code) || !catalogOk) {
                return { field: fr, error: "la regla confirmada no corresponde a esta actividad y jurisdicción" };
            }
            if (rule.treatment !== r.treatment || (r.rate !== null && checkRateString(r.rate) !== null) || !sameRate(rule.rate, r.rate)) {
                return { field: fr, error: "el valor confirmado no coincide con la regla sugerida" };
            }
            if (rule.conditions.length > 0) {
                return {
                    field: fr,
                    error: "la regla depende de condiciones que no se acreditan al guardar (ingresos o hechos declarados): registrá la alícuota como decisión del estudio",
                };
            }
            if (rule.registrations.length > 0 && (next.registration === null || !rule.registrations.includes(next.registration))) {
                return { field: fr, error: "la regla exige una inscripción en Ingresos Brutos distinta de la registrada en la ficha" };
            }
        }
    }
    return null;
}
