"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { submitPeriodDelete, DELETE_PERIOD_HAS_MOVEMENTS_ERROR } from "@/lib/period-mutations";

/**
 * Eliminación de un período (sólo se renderiza para OWNER / ADMIN; la API
 * vuelve a exigir el rol y que el período esté vacío). Confirmación visible en
 * la propia página: nunca `window.confirm`.
 */
export function PeriodActions({
    clientId,
    periodId,
    periodLabel,
    canDelete,
    hasMovements,
}: {
    clientId: string;
    periodId: string;
    periodLabel: string;
    canDelete: boolean;
    hasMovements: boolean;
}) {
    const router = useRouter();
    const [confirming, setConfirming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState("");
    const inFlight = useRef(false);

    async function handleDelete() {
        if (inFlight.current) return;
        inFlight.current = true;
        setDeleting(true);
        setError("");
        try {
            const result = await submitPeriodDelete(periodId);
            if (!result.ok) {
                setError(result.message);
                return;
            }
            router.push(`/client/${clientId}/dashboard`);
            router.refresh();
        } catch {
            setError("Ocurrió un error inesperado al eliminar el período.");
        } finally {
            inFlight.current = false;
            setDeleting(false);
        }
    }

    if (!canDelete) return null;

    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--spacing-sm)" }}>
            {!confirming && (
                <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ color: "var(--error)" }}
                    onClick={() => {
                        setError("");
                        setConfirming(true);
                    }}
                >
                    Eliminar período
                </button>
            )}

            {confirming && (
                <div role="alertdialog" aria-live="polite" className="card" style={{ maxWidth: "420px", border: "1px solid var(--error)" }}>
                    {hasMovements ? (
                        <p style={{ marginBottom: "var(--spacing-sm)" }}>{DELETE_PERIOD_HAS_MOVEMENTS_ERROR}</p>
                    ) : (
                        <p style={{ marginBottom: "var(--spacing-sm)" }}>
                            ¿Eliminar definitivamente el período <strong>{periodLabel}</strong>? Esta acción no se puede deshacer.
                        </p>
                    )}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)" }}>
                        <button type="button" className="btn btn-secondary" disabled={deleting} onClick={() => setConfirming(false)}>
                            Cancelar
                        </button>
                        {!hasMovements && (
                            <button
                                type="button"
                                className="btn btn-primary"
                                style={{ backgroundColor: "var(--error)" }}
                                disabled={deleting}
                                aria-busy={deleting}
                                onClick={handleDelete}
                            >
                                {deleting ? "Eliminando período..." : "Sí, eliminar"}
                            </button>
                        )}
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
