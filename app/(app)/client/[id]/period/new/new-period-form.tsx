"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MONTH_NAMES } from "@/lib/period";
import { submitNewPeriod } from "@/lib/period-mutations";

export function NewPeriodForm({
    clientId,
    clientName,
    years,
}: {
    clientId: string;
    clientName: string;
    years: number[];
}) {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    // Evita dobles envíos aun antes de que React re-renderice el botón deshabilitado.
    const inFlight = useRef(false);
    const dashboardHref = `/client/${clientId}/dashboard`;

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (inFlight.current) return;
        // Se lee ANTES de deshabilitar los selects (un control deshabilitado no
        // forma parte de FormData).
        const formData = new FormData(e.currentTarget);
        const month = Number(formData.get("month"));
        const year = Number(formData.get("year"));

        inFlight.current = true;
        setLoading(true);
        setError("");

        try {
            const result = await submitNewPeriod({ clientId, month, year });
            if (!result.ok) {
                setError(result.message);
                return;
            }
            router.push(dashboardHref);
            router.refresh();
        } catch {
            setError("Ocurrió un error inesperado al crear el período.");
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }

    return (
        <div className="container" style={{ maxWidth: "600px" }}>
            <Link href={dashboardHref} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                &larr; Volver a {clientName}
            </Link>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-lg)" }}>
                Nuevo período
            </h1>

            <form onSubmit={handleSubmit} className="card" aria-busy={loading} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                {error && (
                    <div role="alert" style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                        {error}
                    </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--spacing-md)" }}>
                    <div>
                        <label htmlFor="period-month" style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Mes</label>
                        <select id="period-month" name="month" className="input" required disabled={loading}>
                            {MONTH_NAMES.map((m, i) => (
                                <option key={m} value={i + 1}>{m}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label htmlFor="period-year" style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Año</label>
                        <select id="period-year" name="year" className="input" required disabled={loading}>
                            {years.map((y) => (
                                <option key={y} value={y}>{y}</option>
                            ))}
                        </select>
                    </div>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    <Link href={dashboardHref} className="btn btn-secondary" aria-disabled={loading}>
                        Cancelar
                    </Link>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? "Creando período..." : "Crear período"}
                    </button>
                </div>
            </form>
        </div>
    );
}
