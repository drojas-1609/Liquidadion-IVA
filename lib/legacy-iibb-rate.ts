/**
 * Alícuota del cálculo actual (`Client.defaultIibbRate`).
 *
 * Es la única alícuota que usan hoy la liquidación y las exportaciones. Las
 * alícuotas informativas por actividad y jurisdicción no la reemplazan ni la
 * modifican. Se edita dentro de la ficha (sin pantalla separada) y el
 * formulario la envía sólo si cambió.
 */

/** Valor inicial del alta cuando el cuerpo no trae `defaultIibbRate` (contrato vigente de la API). */
export const LEGACY_INITIAL_IIBB_RATE = "3";

/**
 * Aclaración junto a la alícuota en la liquidación y el Excel. Sólo texto: no
 * cambia fórmulas ni resultados.
 */
export const LIQUIDATION_RATE_NOTE =
    "Alícuota del cálculo actual del cliente: valor único aplicado a toda la base. No se obtiene automáticamente de las actividades y no representa una liquidación por jurisdicción.";
