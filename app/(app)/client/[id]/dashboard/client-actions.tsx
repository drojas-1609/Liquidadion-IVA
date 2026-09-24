"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { submitClientDelete } from "@/lib/client-mutations";

/**
 * Acciones de gestión del cliente (sólo se renderiza para OWNER / ADMIN; la API
 * vuelve a exigir el rol). Eliminar requiere una confirmación visible en la
 * propia página: nunca `window.confirm`.
 */
export function ClientActions({
    clientId,
    clientName,
    canEdit,
    canDelete,
}: {
    clientId: string;
    clientName: string;
    canEdit: boolean;
    canDelete: boolean;
}) {
    const router = useRouter();
    const [confirming, setConfirming] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState("");

    async function handleDelete() {
        setDeleting(true);
        setError("");
        try {
            const result = await submitClientDelete(clientId);
            if (!result.ok) {
                setError(result.message);
                return;
            }
            router.push("/clients");
            router.refresh();
        } catch {
            setError("Ocurrió un error al eliminar el cliente.");
        } finally {
            setDeleting(false);
        }
    }

    if (!canEdit && !canDelete) return null;

    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--spacing-sm)" }}>
            <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                {canEdit && (
                    <Link href={`/client/${clientId}/edit`} className="btn btn-secondary">
                        Editar
                    </Link>
                )}
                {canDelete && !confirming && (
                    <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ color: "var(--error)" }}
                        onClick={() => {
                            setError("");
                            setConfirming(true);
                        }}
                    >
                        Eliminar
                    </button>
                )}
            </div>

            {canDelete && confirming && (
                <div role="alertdialog" aria-live="polite" className="card" style={{ maxWidth: "420px", border: "1px solid var(--error)" }}>
                    <p style={{ marginBottom: "var(--spacing-sm)" }}>
                        ¿Eliminar definitivamente el cliente <strong>{clientName}</strong>? Esta acción no se puede deshacer.
                    </p>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)" }}>
                        <button type="button" className="btn btn-secondary" disabled={deleting} onClick={() => setConfirming(false)}>
                            Cancelar
                        </button>
                        <button
                            type="button"
                            className="btn btn-primary"
                            style={{ backgroundColor: "var(--error)" }}
                            disabled={deleting}
                            onClick={handleDelete}
                        >
                            {deleting ? "Eliminando..." : "Sí, eliminar"}
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
