/**
 * Catálogo de jurisdicciones de Ingresos Brutos.
 *
 * Códigos de jurisdicción del Convenio Multilateral (Comisión Arbitral,
 * COMARB): 901 a 924, según la RG CA 3/2015 ("dígitos asignados como
 * Jurisdicción Sede ... entre 901 y 924") y el listado de jurisdicciones de
 * https://www.ca.gob.ar/datos-jurisdicciones (902 a 924 publicados con su
 * nombre). 901 corresponde a la Ciudad Autónoma de Buenos Aires: es el único
 * código del rango no asignado a una provincia y la única jurisdicción del
 * listado publicada sin código.
 *
 * Estos códigos NO son los `idProvincia` del padrón de ARCA (otro catálogo):
 * nunca se convierten automáticamente entre sí.
 *
 * Lógica pura, sin `server-only`: apta para la API y los formularios.
 */

export interface Jurisdiction {
    /** Código de Convenio Multilateral, "901" a "924". */
    code: string;
    name: string;
}

export const JURISDICTIONS: readonly Jurisdiction[] = [
    { code: "901", name: "Ciudad Autónoma de Buenos Aires" },
    { code: "902", name: "Buenos Aires" },
    { code: "903", name: "Catamarca" },
    { code: "904", name: "Córdoba" },
    { code: "905", name: "Corrientes" },
    { code: "906", name: "Chaco" },
    { code: "907", name: "Chubut" },
    { code: "908", name: "Entre Ríos" },
    { code: "909", name: "Formosa" },
    { code: "910", name: "Jujuy" },
    { code: "911", name: "La Pampa" },
    { code: "912", name: "La Rioja" },
    { code: "913", name: "Mendoza" },
    { code: "914", name: "Misiones" },
    { code: "915", name: "Neuquén" },
    { code: "916", name: "Río Negro" },
    { code: "917", name: "Salta" },
    { code: "918", name: "San Juan" },
    { code: "919", name: "San Luis" },
    { code: "920", name: "Santa Cruz" },
    { code: "921", name: "Santa Fe" },
    { code: "922", name: "Santiago del Estero" },
    { code: "923", name: "Tierra del Fuego, Antártida e Islas del Atlántico Sur" },
    { code: "924", name: "Tucumán" },
];

const BY_CODE: ReadonlyMap<string, Jurisdiction> = new Map(JURISDICTIONS.map((j) => [j.code, j]));

export function isJurisdictionCode(value: unknown): value is string {
    return typeof value === "string" && BY_CODE.has(value);
}

/** Nombre de la jurisdicción, o el código tal cual si no está en el catálogo. */
export function jurisdictionName(code: string): string {
    return BY_CODE.get(code)?.name ?? code;
}

/** Etiqueta "901 · Ciudad Autónoma de Buenos Aires". */
export function jurisdictionLabel(code: string): string {
    const j = BY_CODE.get(code);
    return j ? `${j.code} · ${j.name}` : code;
}
