import { VAT_CONDITION_EXENTO, VAT_CONDITION_MONOTRIBUTO, VAT_CONDITION_RI } from "./arca/catalogs";

/**
 * Condición fiscal del CLIENTE del estudio (columna de texto `Client.condition`).
 *
 * Sólo se admiten las tres etiquetas que ofrecen las pantallas de alta y
 * edición; cada una corresponde a un código oficial de "Tipos de responsables".
 * No depende de la situación del cliente frente a IIBB (Convenio Multilateral
 * queda fuera de alcance).
 *
 * Lógica pura, sin `server-only`: apta para la API y los formularios.
 */

export const CLIENT_CONDITIONS = ["Responsable Inscripto", "Monotributo", "Exento"] as const;

export type ClientCondition = (typeof CLIENT_CONDITIONS)[number];

const CODE_BY_CONDITION: Readonly<Record<ClientCondition, number>> = {
    "Responsable Inscripto": VAT_CONDITION_RI,
    Monotributo: VAT_CONDITION_MONOTRIBUTO,
    Exento: VAT_CONDITION_EXENTO,
};

export function isClientCondition(value: unknown): value is ClientCondition {
    return typeof value === "string" && (CLIENT_CONDITIONS as readonly string[]).includes(value);
}

/**
 * Código oficial de la condición del cliente, o null si el texto guardado no
 * es una de las tres etiquetas (p. ej. datos cargados antes de esta regla).
 * Con null, la matriz normativa no habilita ningún comprobante.
 */
export function clientConditionCode(value: unknown): number | null {
    return isClientCondition(value) ? CODE_BY_CONDITION[value] : null;
}

export const CLIENT_CONDITION_ERROR = `condición fiscal inválida (${CLIENT_CONDITIONS.join(", ")})`;
