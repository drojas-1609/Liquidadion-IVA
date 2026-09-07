"use client";

import { useState, use } from "react";
import { useRouter } from "next/navigation";

export default function NewTaxPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = use(params);
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setLoading(true);
        setError("");

        const formData = new FormData(e.currentTarget);
        const data = Object.fromEntries(formData.entries());

        try {
            const res = await fetch("/api/taxes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...data,
                    periodId,
                }),
            });

            if (!res.ok) {
                const j = await res.json().catch(() => null);
                throw new Error(j?.field ? `${j.field}: ${j.error}` : j?.error || "Error al crear el registro");
            }

            router.push(`/client/${id}/period/${periodId}/taxes`);
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Ocurrió un error al guardar.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="container" style={{ maxWidth: "600px" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-lg)" }}>
                Nueva Retención / Percepción
            </h1>

            <form onSubmit={handleSubmit} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                {error && (
                    <div style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                        {error}
                    </div>
                )}

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Fecha</label>
                    <input name="date" type="date" required className="input" />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Tipo</label>
                    <select name="type" className="input" required>
                        <option value="RETENCION IVA">Retención IVA</option>
                        <option value="RETENCION IIBB">Retención IIBB</option>
                        <option value="PERCEPCION IVA">Percepción IVA</option>
                        <option value="PERCEPCION IIBB">Percepción IIBB</option>
                        <option value="SIRCREB">SIRCREB</option>
                        <option value="SIRTAC">SIRTAC</option>
                    </select>
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Monto</label>
                    <input name="amount" type="text" inputMode="decimal" required className="input" placeholder="0.00" />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Descripción (Opcional)</label>
                    <input name="description" type="text" className="input" placeholder="Ej. Banco Galicia" />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    <button type="button" onClick={() => router.back()} className="btn btn-secondary">
                        Cancelar
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        Guardar
                    </button>
                </div>
            </form>
        </div>
    );
}
