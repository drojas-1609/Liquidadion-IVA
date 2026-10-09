/**
 * Estado de un período fiscal (abierto / cerrado): textos y reglas puras,
 * compartidas por la API y la UI. Sin dependencias ni `server-only`.
 *
 * Un período CERRADO admite consulta y exportación; el servidor rechaza toda
 * modificación o eliminación del período y de su contenido (lib/period-lock).
 * El cierre NO congela la liquidación: se sigue calculando con la alícuota
 * IIBB vigente del cliente.
 */

export type PeriodStatusValue = "OPEN" | "CLOSED";

/** true sólo para CLOSED. Para la UI: un valor desconocido no se muestra como cerrado (el servidor falla cerrado igual). */
export function isPeriodClosed(status: string): boolean {
    return status === "CLOSED";
}

export const PERIOD_STATUS_LABEL: Record<PeriodStatusValue, string> = {
    OPEN: "Abierto",
    CLOSED: "Cerrado",
};

export function periodStatusLabel(status: string): string {
    return status === "OPEN" || status === "CLOSED" ? PERIOD_STATUS_LABEL[status] : status;
}

/** 409 CONFLICT: la pantalla vio otra versión del estado del período. */
export const PERIOD_STALE_MESSAGE =
    "El estado del período cambió desde que abriste esta pantalla. Recargala para ver el estado actual.";

/** Alcance del cierre, para la confirmación visible y el aviso de período cerrado. */
export const PERIOD_CLOSE_SCOPE_NOTICE =
    "Un período cerrado se puede consultar y exportar, pero no se pueden cargar, editar ni eliminar sus comprobantes, " +
    "retenciones/percepciones ni su configuración, ni eliminar el período.";

/** Limitación explícita: el cierre no es una liquidación fiscal inmutable. */
export const PERIOD_CLOSE_IIBB_NOTICE =
    "El cierre no congela la liquidación: se sigue calculando con la alícuota IIBB vigente del cliente.";

/**
 * Nuevo `Period.updatedAt` de una transición de estado: el instante actual,
 * pero SIEMPRE posterior (≥ 1 ms) al anterior. Así dos transiciones
 * consecutivas nunca comparten versión, aunque caigan en el mismo milisegundo
 * o el reloj retroceda, y un token viejo no puede volver a coincidir.
 */
export function nextPeriodUpdatedAt(previous: Date, now: Date): Date {
    return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}
