"use client";

import { useEffect, useId, useReducer, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TAX_ROW_ACTION_INITIAL, deleteTaxRecord, runExclusive, taxRowActionReducer } from "@/lib/tax-form-client";

/**
 * Acciones de una fila de retenciones/percepciones. Recibe del servidor SÓLO
 * lo necesario: id, token updatedAt (ISO exacto), una etiqueta (tipo y fecha,
 * sin importe ni descripción) y qué acciones corresponden según el rol (la
 * API sigue siendo la autoridad).
 *
 * La baja pide confirmación dentro de la página (sin diálogos del navegador),
 * impide el doble envío y no retira la fila de forma optimista: la fila sigue
 * visible mientras el DELETE está pendiente, si falla y tras el 204 hasta que
 * el servidor devuelve la lista nueva (router.refresh()).
 */
export interface TaxRowActionsProps {
    taxId: string;
    updatedAt: string;
    label: string;
    /** null = sin edición (rol). */
    editHref: string | null;
    canDelete: boolean;
}

export function TaxRowActions({ taxId, updatedAt, label, editHref, canDelete }: TaxRowActionsProps) {
    const router = useRouter();
    const [state, dispatch] = useReducer(taxRowActionReducer, TAX_ROW_ACTION_INITIAL);
    // Evita dobles envíos aun antes de que React re-renderice los botones deshabilitados.
    const inFlight = useRef(false);
    const deleteButton = useRef<HTMLButtonElement>(null);
    const confirmButton = useRef<HTMLButtonElement>(null);
    const prevPhase = useRef(state.phase);
    const promptId = `${useId()}-prompt`;

    // Foco: al abrir la confirmación, en "Confirmar"; al cancelar, de vuelta en "Eliminar".
    useEffect(() => {
        if (state.phase === "confirming") confirmButton.current?.focus();
        if (state.phase === "idle" && prevPhase.current !== "idle") deleteButton.current?.focus();
        prevPhase.current = state.phase;
    }, [state.phase]);

    const busy = state.phase === "deleting";

    async function onConfirm() {
        if (state.phase !== "confirming") return;
        await runExclusive(inFlight, async () => {
            dispatch({ type: "start" });
            const result = await deleteTaxRecord(taxId, updatedAt);
            if (!result.ok) {
                dispatch({ type: "fail", feedback: result.feedback });
                return;
            }
            // Sin retiro optimista: la lista nueva llega del servidor.
            dispatch({ type: "done" });
            router.refresh();
        });
    }

    if (editHref === null && !canDelete) return null;

    return (
        <div aria-busy={busy} style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-xs)", alignItems: "center" }}>
            {editHref !== null && state.phase !== "deleted" && (
                <Link href={editHref} className="btn btn-secondary" aria-label={`Editar ${label}`} aria-disabled={busy} tabIndex={busy ? -1 : undefined}>
                    Editar
                </Link>
            )}

            {canDelete && (state.phase === "idle" || state.phase === "error") && (
                <button ref={deleteButton} type="button" className="btn btn-secondary" aria-label={`Eliminar ${label}`} onClick={() => dispatch({ type: "open" })}>
                    Eliminar
                </button>
            )}

            {canDelete && (state.phase === "confirming" || state.phase === "deleting") && (
                <div role="group" aria-labelledby={promptId} style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-xs)", alignItems: "center" }}>
                    <span id={promptId}>¿Eliminar {label}? Esta acción no se puede deshacer.</span>
                    <button ref={confirmButton} type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
                        {busy ? "Eliminando..." : "Confirmar eliminación"}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: "cancel" })} disabled={busy}>
                        Cancelar
                    </button>
                </div>
            )}

            {state.phase === "deleting" && <span role="status">Eliminando el registro…</span>}
            {state.phase === "deleted" && <span role="status">Registro eliminado. Actualizando la lista…</span>}
            {state.phase === "error" && (
                <span role="alert" style={{ color: "var(--error)" }}>
                    {state.feedback.message}
                    {state.feedback.stale && (
                        <>
                            {" "}
                            <button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>
                                Recargar
                            </button>
                        </>
                    )}
                </span>
            )}
        </div>
    );
}
