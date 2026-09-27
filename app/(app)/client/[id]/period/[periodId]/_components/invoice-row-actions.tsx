"use client";

import { useEffect, useId, useReducer, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ROW_ACTION_INITIAL, deleteInvoice, rowActionReducer, runExclusive } from "@/lib/invoice-form-client";

/**
 * Acciones de una fila de ventas / compras. Recibe del servidor SÓLO lo
 * necesario: id, token updatedAt (ISO exacto), una etiqueta de identificación
 * (tipo y número, sin importes ni contraparte) y qué acciones corresponden
 * (rol + editabilidad / eliminabilidad, resueltos en el servidor).
 *
 * La baja pide confirmación dentro de la página (sin diálogos del navegador),
 * impide el doble envío y no actualiza la lista de forma optimista: tras el
 * 204 se pide al servidor la lista nueva.
 */
export interface InvoiceRowActionsProps {
    invoiceId: string;
    updatedAt: string;
    label: string;
    /** null = sin edición (rol o fila no editable). */
    editHref: string | null;
    canDelete: boolean;
}

export function InvoiceRowActions({ invoiceId, updatedAt, label, editHref, canDelete }: InvoiceRowActionsProps) {
    const router = useRouter();
    const [state, dispatch] = useReducer(rowActionReducer, ROW_ACTION_INITIAL);
    // Evita dobles envíos aun antes de que React re-renderice los botones deshabilitados.
    const inFlight = useRef(false);
    const deleteButton = useRef<HTMLButtonElement>(null);
    const confirmButton = useRef<HTMLButtonElement>(null);
    const prevPhase = useRef(state.phase);
    const baseId = useId();
    const promptId = `${baseId}-prompt`;

    // Foco: al abrir la confirmación, en "Confirmar"; al cancelar, de vuelta en "Eliminar".
    useEffect(() => {
        if (state.phase === "confirming") confirmButton.current?.focus();
        if (state.phase === "idle" && prevPhase.current !== "idle") deleteButton.current?.focus();
        prevPhase.current = state.phase;
    }, [state.phase]);

    const busy = state.phase === "deleting";

    async function onConfirm() {
        if (state.phase !== "confirming") return;
        // Guardia compartido (lib): un segundo clic antes del re-render no ejecuta nada.
        await runExclusive(inFlight, async () => {
            dispatch({ type: "start" });
            const result = await deleteInvoice(invoiceId, updatedAt);
            if (!result.ok) {
                dispatch({ type: "fail", feedback: result.feedback });
                return;
            }
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
                <button
                    ref={deleteButton}
                    type="button"
                    className="btn btn-secondary"
                    aria-label={`Eliminar ${label}`}
                    onClick={() => dispatch({ type: "open" })}
                >
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

            {state.phase === "deleting" && <span role="status">Eliminando el comprobante…</span>}
            {state.phase === "deleted" && <span role="status">Comprobante eliminado.</span>}
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
