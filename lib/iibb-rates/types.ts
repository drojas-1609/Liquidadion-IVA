/**
 * Reglas de alícuotas de Ingresos Brutos por jurisdicción, SEPARADAS del
 * catálogo de actividades. Cada conjunto de reglas corresponde a una norma
 * concreta (ley impositiva/tarifaria y modificatorias) con su vigencia, fuente,
 * checksum y estado de revisión. Sólo se sugieren reglas de conjuntos
 * REVISADOS. Nunca se infieren tasas de IIBB a partir de ARCA/CLAE.
 *
 * Puro: apto para cliente y servidor.
 */
import type { ReviewInfo } from "../activity-catalog/review";
import type { IibbRegistration } from "../iibb/registration";

/** Tratamiento de la actividad en la jurisdicción. 0 % explícito ≠ exención ≠ dato ausente. */
export const RATE_TREATMENTS = ["RATE", "EXEMPT"] as const;
export type RateTreatment = (typeof RATE_TREATMENTS)[number];

/**
 * Condición de la norma que debe cumplirse para que la regla aplique. Las que
 * el sistema no puede verificar con datos registrados quedan como "dato
 * faltante": nunca se asumen.
 */
export type RuleCondition =
    | {
          kind: "PRIOR_YEAR_GROSS_INCOME";
          /** Ingresos brutos anuales del ejercicio anterior (todas las actividades y jurisdicciones, según la norma). Pesos, string decimal. */
          minExclusive: string | null;
          maxInclusive: string | null;
          description: string;
      }
    | {
          /** Hecho declarado por el estudio (p. ej. "posee establecimiento industrial en la jurisdicción"). */
          kind: "DECLARED_FACT";
          factKey: string;
          expected: boolean;
          description: string;
      };

export interface RateRule {
    /** Identificador estable dentro del conjunto. */
    id: string;
    /** Códigos EXACTOS (string, con ceros iniciales) del nomenclador del conjunto. */
    activityCodes: string[];
    /** Inscripciones a las que aplica; vacío = la norma no distingue. */
    registrations: IibbRegistration[];
    /** Vigencia propia (cambios dentro del año); null = la del conjunto. */
    validFrom: string | null;
    validTo: string | null;
    treatment: RateTreatment;
    /** Porcentaje como string decimal (sólo con treatment RATE). "0" = 0 % explícito. */
    rate: string | null;
    conditions: RuleCondition[];
    /** Artículo/inciso/anexo que respalda la regla. */
    legalReference: string;
    /** Fuente oficial de ESTA regla cuando difiere de la del conjunto (p. ej. una ley modificatoria). */
    sourceUrl?: string;
    /**
     * Regla RETENIDA: su vigencia o alcance depende de una interpretación que el
     * estudio todavía no decidió. Nunca se sugiere ni se acepta al guardar, aunque
     * el conjunto esté aprobado; se habilita sólo regenerando el conjunto sin la marca.
     */
    pendingInterpretation?: string;
}

export interface RateRuleSetManifest {
    id: string;
    /** Jurisdicción CM 901–924. */
    jurisdiction: string;
    /** Nomenclador de los códigos de las reglas. */
    nomenclator: "NAES" | "PROVINCIAL";
    /** Catálogos (ids) cuyos códigos usa la norma. */
    catalogIds: string[];
    organism: string;
    norm: string;
    sourceUrl: string;
    publishedAt: string;
    consultedAt: string;
    version: string;
    validFrom: string;
    validTo: string | null;
    sourceSha256: string;
    review: ReviewInfo;
}

export interface RateRuleSet {
    manifest: RateRuleSetManifest;
    rules: RateRule[];
}

/** Datos del cliente que la norma puede exigir. Ausente = desconocido (nunca se asume). */
export interface RateFacts {
    priorYearGrossIncome?: string | null;
    declared?: Record<string, boolean>;
}

/** Referencia estable de una regla: "<conjunto>#<regla>". */
export function ruleRef(setId: string, ruleId: string): string {
    return `${setId}#${ruleId}`;
}

export function parseRuleRef(ref: string): { setId: string; ruleId: string } | null {
    const m = /^([a-z0-9][a-z0-9-]{2,79})#([A-Za-z0-9._-]{1,60})$/.exec(ref);
    return m ? { setId: m[1], ruleId: m[2] } : null;
}

/** Origen de una alícuota cargada en la ficha. */
export const RATE_ORIGINS = ["STUDIO_MANUAL", "CONFIRMED_SUGGESTION"] as const;
export type RateOrigin = (typeof RATE_ORIGINS)[number];

export const RATE_ORIGIN_LABEL: Readonly<Record<RateOrigin, string>> = {
    STUDIO_MANUAL: "Tasa manual confirmada por el estudio",
    CONFIRMED_SUGGESTION: "Sugerencia de norma confirmada por el estudio",
};

export const RATE_PENDING_LABEL = "Alícuota pendiente de determinar";
