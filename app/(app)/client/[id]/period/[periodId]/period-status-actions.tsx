"use client";

import { useReducer, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitPeriodTransition, PERIOD_TRANSITION_UNCERTAIN_ERROR, type PeriodTransition } from "@/lib/period-mutations";
import {
    PERIOD_CLOSE_IIBB_NOTICE,
    PERIOD_CLOSE_SCOPE_NOTICE,
    PERIOD_TRANSITION_INITIAL,
    canStartPeriodTransition,
    periodTransitionDisplay,
    periodTransitionNotice,
    periodTransitionReducer,
    type PeriodVersion,
} from "@/lib/period-status";

/**
 * Cierre / reapertura del período. Sólo se renderiza el botón que corresponde
 * al estado y al rol (cerrar: OWNER / ADMIN / ACCOUNTANT; reabrir: OWNER /
 * ADMIN); la API vuelve a exigir el rol y rechaza con 409 si el estado cambió
 * desde que se cargó la pantalla (`updatedAt`). Confirmación visible en la
 * propia página: nunca `window.confirm`.
 *
 * Tras un 200 el control usa el estado y la versión que devolvió la API y no
 * ofrece otra transición hasta que las props reflejen esa versión (o una
 * posterior). Un resultado incierto (red, 5xx, respuesta ilegible) también
 * bloquea hasta ver una versión posterior. En ambos casos siempre se ofrece
 * recargar la página (GET completo); nunca se repite la mutación.
 */
export function PeriodStatusActions({
    periodId,
    periodLabel,
    closed,
    updatedAt,
    canClose,
    canReopen,
}: {
    periodId: string;
    periodLabel: string;
    closed: boolean;
    /** `Period.updatedAt` ISO que vio esta pantalla: versión del estado. */
    updatedAt: string;
    canClose: boolean;
    canReopen: boolean;
}) {
    const router = useRouter();
    const [state, dispatch] = useReducer(periodTransitionReducer, PERIOD_TRANSITION_INITIAL);
    const [refreshing, startRefresh] = useTransition();
    const inFlight = useRef(false);

    const view: PeriodVersion = { status: closed ? "CLOSED" : "OPEN", updatedAt };
    const display = periodTransitionDisplay(state, view);
    const notice = periodTransitionNotice(display, refreshing);

    const transition: PeriodTransition = closed ? "reopen" : "close";
    const allowed = closed ? canReopen : canClose;
    const canStart = canStartPeriodTransition(display);
    const confirming = display.kind === "confirming" || display.kind === "submitting";
    const loading = display.kind === "submitting";

    async function handleConfirm() {
        if (inFlight.current || display.kind !== "confirming") return;
        inFlight.current = true;
        dispatch({ type: "start", view });
        try {
            const result = await submitPeriodTransition(transition, periodId, updatedAt);
            if (result.ok) {
                dispatch({ type: "succeed", confirmed: result.confirmed, view });
            } else if (result.uncertain) {
                dispatch({ type: "uncertain", message: result.message, view });
            } else {
                dispatch({ type: "fail", message: result.message, view });
                return;
            }
            startRefresh(() => router.refresh());
        } catch {
            dispatch({ type: "uncertain", message: PERIOD_TRANSITION_UNCERTAIN_ERROR[transition], view });
        } finally {
            inFlight.current = false;
        }
    }

    if (notice) {
        return (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--spacing-sm)" }}>
                <div
                    role={notice.tone}
                    aria-live="polite"
                    data-period-transition={display.kind}
                    style={{ padding: "var(--spacing-sm)", borderRadius: "var(--radius-sm)", maxWidth: "420px", ...(notice.tone === "alert" ? { backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)" } : {}) }}
                >
                    {notice.message}{" "}
                    {/* Recarga completa de la página (GET); nunca repite la transición. */}
                    <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
                        Recargar
                    </button>
                </div>
            </div>
        );
    }

    if (!allowed) return null;

    const label = closed ? "Reabrir período" : "Cerrar período";
    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--spacing-sm)" }}>
            {!confirming && (
                <button type="button" className="btn btn-secondary" disabled={!canStart} onClick={() => dispatch({ type: "open", view })}>
                    {label}
                </button>
            )}

            {confirming && (
                <div role="alertdialog" aria-live="polite" className="card" style={{ maxWidth: "420px" }}>
                    {closed ? (
                        <p style={{ marginBottom: "var(--spacing-sm)" }}>
                            ¿Reabrir el período <strong>{periodLabel}</strong>? Se podrán volver a cargar, editar y eliminar sus datos.
                        </p>
                    ) : (
                        <>
                            <p style={{ marginBottom: "var(--spacing-sm)" }}>
                                ¿Cerrar el período <strong>{periodLabel}</strong>? {PERIOD_CLOSE_SCOPE_NOTICE}
                            </p>
                            <p style={{ marginBottom: "var(--spacing-sm)", color: "var(--secondary)" }}>{PERIOD_CLOSE_IIBB_NOTICE}</p>
                        </>
                    )}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)" }}>
                        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => dispatch({ type: "cancel", view })}>
                            Cancelar
                        </button>
                        <button type="button" className="btn btn-primary" disabled={loading} aria-busy={loading} onClick={handleConfirm}>
                            {loading ? (closed ? "Reabriendo período..." : "Cerrando período...") : closed ? "Sí, reabrir" : "Sí, cerrar"}
                        </button>
                    </div>
                </div>
            )}

            {display.kind === "error" && (
                <div role="alert" style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)", maxWidth: "420px" }}>
                    {display.message}
                </div>
            )}
        </div>
    );
}
