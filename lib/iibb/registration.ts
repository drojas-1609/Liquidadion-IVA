/**
 * Inscripción en Ingresos Brutos del cliente: categorías OPERATIVAS elegidas por
 * el estudio (no verificación oficial de inscripción).
 *
 * Se distingue la naturaleza técnica de cada opción sin cambiar las opciones
 * visibles: Local, Simplificado y Convenio Multilateral son REGÍMENES; Exento
 * es un TRATAMIENTO fiscal; No Inscripto es una SITUACIÓN. Ninguna opción se
 * infiere de la condición frente al IVA, ni aplica alícuotas, ni determina
 * obligaciones, presentaciones o vencimientos (módulo futuro).
 *
 * Lógica pura, sin `server-only`.
 */

export const IIBB_REGISTRATIONS = ["LOCAL", "SIMPLIFICADO", "EXENTO", "NO_INSCRIPTO", "CONVENIO_MULTILATERAL"] as const;
export type IibbRegistration = (typeof IIBB_REGISTRATIONS)[number];

/** Etiquetas visibles EXACTAS, en el orden del selector. */
export const IIBB_REGISTRATION_LABEL: Readonly<Record<IibbRegistration, string>> = {
    LOCAL: "Local",
    SIMPLIFICADO: "Simplificado",
    EXENTO: "Exento",
    NO_INSCRIPTO: "No Inscripto",
    CONVENIO_MULTILATERAL: "Convenio Multilateral",
};

export type IibbRegistrationNature = "REGIMEN" | "TRATAMIENTO" | "SITUACION";

export const IIBB_REGISTRATION_NATURE: Readonly<Record<IibbRegistration, IibbRegistrationNature>> = {
    LOCAL: "REGIMEN",
    SIMPLIFICADO: "REGIMEN",
    CONVENIO_MULTILATERAL: "REGIMEN",
    EXENTO: "TRATAMIENTO",
    NO_INSCRIPTO: "SITUACION",
};

export function isIibbRegistration(value: unknown): value is IibbRegistration {
    return typeof value === "string" && (IIBB_REGISTRATIONS as readonly string[]).includes(value);
}

/**
 * Reglas de jurisdicciones por inscripción.
 *  - min / max: cantidad admitida (CM sin mínimo de dos: transiciones).
 *  - headquarters: CM exige UNA sede incluida entre las seleccionadas; el resto
 *    no admite sede.
 *  - kind: cómo se presentan las jurisdicciones registradas.
 */
export interface IibbJurisdictionRule {
    min: number;
    max: number;
    headquarters: "required" | "forbidden";
    kind: "INSCRIPTA" | "ALCANZADA" | "ACTIVIDAD";
}

export const MAX_JURISDICTIONS = 24;

export const IIBB_JURISDICTION_RULES: Readonly<Record<IibbRegistration, IibbJurisdictionRule>> = {
    LOCAL: { min: 1, max: 1, headquarters: "forbidden", kind: "INSCRIPTA" },
    SIMPLIFICADO: { min: 1, max: 1, headquarters: "forbidden", kind: "INSCRIPTA" },
    CONVENIO_MULTILATERAL: { min: 1, max: MAX_JURISDICTIONS, headquarters: "required", kind: "ALCANZADA" },
    EXENTO: { min: 1, max: MAX_JURISDICTIONS, headquarters: "forbidden", kind: "INSCRIPTA" },
    NO_INSCRIPTO: { min: 0, max: MAX_JURISDICTIONS, headquarters: "forbidden", kind: "ACTIVIDAD" },
};

/** Texto que acompaña a las jurisdicciones según cómo deben leerse. */
export const IIBB_JURISDICTION_KIND_LABEL: Readonly<Record<IibbJurisdictionRule["kind"], string>> = {
    INSCRIPTA: "Jurisdicción de inscripción informada por el estudio",
    ALCANZADA: "Jurisdicciones alcanzadas por el Convenio Multilateral",
    ACTIVIDAD: "Jurisdicciones de actividad (no son inscripciones vigentes)",
};

export const IIBB_UNCLASSIFIED_NOTICE =
    "Inscripción en Ingresos Brutos sin clasificar: información pendiente de completar por el estudio.";

/** Aclaración fija del formulario: los datos no son una verificación oficial. */
export const IIBB_INFORMATIVE_NOTICE =
    "Datos informativos cargados por el estudio: no constituyen una verificación oficial de inscripción ni determinan obligaciones, presentaciones o vencimientos.";
