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

// ── Cierre / reapertura en la UI: estado después de enviar ──────────────────

/** Estado y versión (`updatedAt` ISO exacto) de un período. */
export interface PeriodVersion {
    status: PeriodStatusValue;
    updatedAt: string;
}

/**
 * Estado del control de cierre/reapertura. Tras un 200 con respuesta
 * autoritativa (`applied`) o un resultado incierto (`uncertain`) el control
 * NO vuelve a permitir transiciones hasta que las props del servidor reflejen
 * una versión verificable: nunca por terminar el refresco. Mientras tanto
 * siempre ofrece recargar la página.
 */
export type PeriodTransitionState =
    | { phase: "idle" }
    | { phase: "confirming" }
    | { phase: "submitting"; base: string }
    | { phase: "error"; message: string }
    | { phase: "applied"; confirmed: PeriodVersion }
    | { phase: "uncertain"; base: string; message: string };

export const PERIOD_TRANSITION_INITIAL: PeriodTransitionState = { phase: "idle" };

/** Todo evento lleva la vista actual (props del servidor) para reconciliar primero. */
export type PeriodTransitionEvent = { view: PeriodVersion } & (
    | { type: "open" }
    | { type: "cancel" }
    | { type: "start" }
    | { type: "succeed"; confirmed: PeriodVersion }
    | { type: "fail"; message: string }
    | { type: "uncertain"; message: string }
);

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Versión válida: ISO 8601 UTC con milisegundos, como la serializa la API. */
export function isPeriodVersionString(value: unknown): value is string {
    return typeof value === "string" && isoTime(value) !== null;
}

function isoTime(value: string): number | null {
    if (!ISO_INSTANT.test(value)) return null;
    const t = Date.parse(value);
    // Ida y vuelta exacta: rechaza fechas inexistentes que Date.parse normaliza (p. ej. 30 de febrero).
    return Number.isFinite(t) && new Date(t).toISOString() === value ? t : null;
}

/** true si `a` es una versión estrictamente posterior a `b` (ambas ISO válidas). */
function isLaterVersion(a: string, b: string): boolean {
    const ta = isoTime(a);
    const tb = isoTime(b);
    return ta !== null && tb !== null && ta > tb;
}

/** La vista refleja la versión confirmada: mismo estado y misma versión, o una versión posterior. */
export function viewReflectsConfirmed(confirmed: PeriodVersion, view: PeriodVersion): boolean {
    const tv = isoTime(view.updatedAt);
    const tc = isoTime(confirmed.updatedAt);
    if (tv === null || tc === null) return false;
    return (view.status === confirmed.status && tv === tc) || tv > tc;
}

/** Libera `applied` / `uncertain` sólo ante una vista verificable. */
export function reconcilePeriodTransition(state: PeriodTransitionState, view: PeriodVersion): PeriodTransitionState {
    if (state.phase === "applied" && viewReflectsConfirmed(state.confirmed, view)) return PERIOD_TRANSITION_INITIAL;
    if (state.phase === "uncertain" && isLaterVersion(view.updatedAt, state.base)) return PERIOD_TRANSITION_INITIAL;
    return state;
}

export function periodTransitionReducer(state: PeriodTransitionState, event: PeriodTransitionEvent): PeriodTransitionState {
    const s = reconcilePeriodTransition(state, event.view);
    switch (event.type) {
        case "open":
            return s.phase === "idle" || s.phase === "error" ? { phase: "confirming" } : s;
        case "cancel":
            return s.phase === "confirming" || s.phase === "error" ? PERIOD_TRANSITION_INITIAL : s;
        case "start":
            return s.phase === "confirming" ? { phase: "submitting", base: event.view.updatedAt } : s;
        case "succeed":
            if (s.phase !== "submitting") return s;
            return reconcilePeriodTransition({ phase: "applied", confirmed: event.confirmed }, event.view);
        case "fail":
            return s.phase === "submitting" ? { phase: "error", message: event.message } : s;
        case "uncertain":
            if (s.phase !== "submitting") return s;
            return reconcilePeriodTransition({ phase: "uncertain", base: s.base, message: event.message }, event.view);
    }
}

/** Qué muestra el control, con el estado ya reconciliado contra la vista actual. */
export type PeriodTransitionDisplay =
    | { kind: "idle" }
    | { kind: "confirming" }
    | { kind: "submitting" }
    | { kind: "error"; message: string }
    | { kind: "uncertain"; message: string }
    | { kind: "applied"; status: PeriodStatusValue };

export function periodTransitionDisplay(state: PeriodTransitionState, view: PeriodVersion): PeriodTransitionDisplay {
    const s = reconcilePeriodTransition(state, view);
    switch (s.phase) {
        case "applied":
            return { kind: "applied", status: s.confirmed.status };
        case "error":
            return { kind: "error", message: s.message };
        case "uncertain":
            return { kind: "uncertain", message: s.message };
        default:
            return { kind: s.phase };
    }
}

/** Sólo estos estados permiten iniciar o confirmar una transición. */
export function canStartPeriodTransition(display: PeriodTransitionDisplay): boolean {
    return display.kind === "idle" || display.kind === "confirming" || display.kind === "error";
}

/** Éxito confirmado mientras el refresco está en curso. */
export const PERIOD_TRANSITION_APPLIED_MESSAGE: Record<PeriodStatusValue, string> = {
    CLOSED: "Período cerrado. Actualizando la pantalla…",
    OPEN: "Período reabierto. Actualizando la pantalla…",
};

/** Éxito confirmado sin refresco en curso: no afirma un fallo, sólo ofrece recargar. */
export const PERIOD_TRANSITION_RELOAD_HINT_MESSAGE: Record<PeriodStatusValue, string> = {
    CLOSED: "El período quedó cerrado. Si la pantalla no muestra el cambio, recargá la página.",
    OPEN: "El período quedó reabierto. Si la pantalla no muestra el cambio, recargá la página.",
};

/**
 * Aviso de los estados bloqueados posteriores a una respuesta. Siempre ofrece
 * recargar la página (recarga completa por GET, nunca repite la transición),
 * esté o no el refresco en curso. `null`: el control muestra sus botones.
 */
export type PeriodTransitionNotice = { tone: "status" | "alert"; message: string; reload: true };

export function periodTransitionNotice(display: PeriodTransitionDisplay, refreshing: boolean): PeriodTransitionNotice | null {
    if (display.kind === "uncertain") return { tone: "alert", message: display.message, reload: true };
    if (display.kind === "applied") {
        const message = refreshing ? PERIOD_TRANSITION_APPLIED_MESSAGE[display.status] : PERIOD_TRANSITION_RELOAD_HINT_MESSAGE[display.status];
        return { tone: "status", message, reload: true };
    }
    return null;
}
