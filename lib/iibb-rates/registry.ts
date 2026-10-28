import "server-only";
import { validateRuleSet } from "./validate";
import { withApprovedCatalog } from "./suggest";
import { activityCatalogs } from "../activity-catalog/registry";
import { previewFixtures } from "../preview-fixtures/loader";
import type { RateRuleSet } from "./types";
import cabaLey6927_2026 from "@/data/iibb-rate-rules/caba-ley-6927-2026.json";
import arbaLey15558_2026 from "@/data/iibb-rate-rules/arba-ley-15558-2026.json";

/**
 * Conjuntos de reglas de alícuotas incluidos en la aplicación (import
 * explícito, revisable en el PR). Sólo los REVISADOS y estructuralmente
 * válidos se usan para sugerir.
 *
 * Estado actual: CABA 2026 (Ley 6927 con fe de erratas y Ley 6948,
 * scripts/iibb-rates/caba-2026.ts) y Provincia de Buenos Aires 2026 (Ley 15.558,
 * scripts/iibb-rates/arba-2026.ts), ambos PENDIENTES de la revisión del estudio
 * (no se usan todavía). Santa Cruz sigue pendiente: fuentes oficiales no verificables.
 * Ver docs/catalogos-actividades/README.md, «Cobertura de alícuotas».
 */
// El JSON se tipa con strings amplios; la forma real se valida al cargar.
const RULE_SETS: readonly RateRuleSet[] = [cabaLey6927_2026, arbaLey15558_2026] as unknown as RateRuleSet[];

let cache: RateRuleSet[] | null = null;

function validOnly(sets: readonly RateRuleSet[]): RateRuleSet[] {
    return sets.filter((s) => {
        const problems = validateRuleSet(s);
        if (problems.length > 0) console.error(`[iibb-rates] ${s.manifest?.id ?? "?"} descartado: ${problems.slice(0, 5).join("; ")}`);
        return problems.length === 0;
    });
}

/** Conjuntos oficiales registrados y, sólo con las barreras habilitadas, el sintético de prueba. */
export function rateRuleSets(): readonly RateRuleSet[] {
    cache ??= validOnly(RULE_SETS);
    const fx = previewFixtures();
    return fx ? [...cache, ...validOnly([fx.PREVIEW_RULES])] : cache;
}

/** Conjuntos que pueden usarse para sugerir y verificar: válidos y con su catálogo aprobado. */
export function usableRateRuleSets(): readonly RateRuleSet[] {
    return withApprovedCatalog(rateRuleSets(), activityCatalogs());
}
