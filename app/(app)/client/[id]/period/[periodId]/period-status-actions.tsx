"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { submitPeriodTransition, PERIOD_TRANSITION_GENERIC_ERROR, type PeriodTransition } from "@/lib/period-mutations";
import { PERIOD_CLOSE_IIBB_NOTICE, PERIOD_CLOSE_SCOPE_NOTICE } from "@/lib/period-status";

/**
 * Cierre / reapertura del período. Sólo se renderiza el botón que corresponde
 * al estado y al rol (cerrar: OWNER / ADMIN / ACCOUNTANT; reabrir: OWNER /
 * ADMIN); la API vuelve a exigir el rol y rechaza con 409 si el estado cambió
 * desde que se cargó la pantalla (`updatedAt`). Confirmación visible en la
 * propia página: nunca `window.confirm`.
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
    const [confirming, setConfirming] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const inFlight = useRef(false);

    const transition: PeriodTransition = closed ? "reopen" : "close";
    const allowed = closed ? canReopen : canClose;

    async function handleConfirm() {
        if (inFlight.current) return;
        inFlight.current = true;
        setLoading(true);
        setError("");
        try {
            const result = await submitPeriodTransition(transition, periodId, updatedAt);
            if (!result.ok) {
                setError(result.message);
                return;
            }
            setConfirming(false);
            router.refresh();
        } catch {
            setError(PERIOD_TRANSITION_GENERIC_ERROR[transition]);
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }

    if (!allowed) return null;

    const label = closed ? "Reabrir período" : "Cerrar período";
    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--spacing-sm)" }}>
            {!confirming && (
                <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                        setError("");
                        setConfirming(true);
                    }}
                >
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
                        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => setConfirming(false)}>
                            Cancelar
                        </button>
                        <button type="button" className="btn btn-primary" disabled={loading} aria-busy={loading} onClick={handleConfirm}>
                            {loading ? (closed ? "Reabriendo período..." : "Cerrando período...") : closed ? "Sí, reabrir" : "Sí, cerrar"}
                        </button>
                    </div>
                </div>
            )}

            {error && (
                <div role="alert" style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)", maxWidth: "420px" }}>
                    {error}
                </div>
            )}
        </div>
    );
}
