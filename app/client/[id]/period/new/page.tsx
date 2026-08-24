"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewPeriodPage({ params }: { params: { id: string } }) {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setLoading(true);
        setError("");

        const formData = new FormData(e.currentTarget);
        const month = parseInt(formData.get("month") as string);
        const year = parseInt(formData.get("year") as string);

        try {
            const res = await fetch(`/api/periods`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ clientId: params.id, month, year }),
            });

            if (!res.ok) throw new Error("Error al crear el periodo");

            router.push(`/client/${params.id}/dashboard`);
            router.refresh();
        } catch (err) {
            setError("Ocurrió un error al crear el periodo.");
        } finally {
            setLoading(false);
        }
    }

    const currentYear = new Date().getFullYear();
    const years = Array.from({ length: 5 }, (_, i) => currentYear - i);
    const months = [
        "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
        "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
    ];

    return (
        <div className="container" style={{ maxWidth: "600px" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-lg)" }}>
                Nuevo Periodo
            </h1>

            <form onSubmit={handleSubmit} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                {error && (
                    <div style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                        {error}
                    </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--spacing-md)" }}>
                    <div>
                        <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Mes</label>
                        <select name="month" className="input" required>
                            {months.map((m, i) => (
                                <option key={i} value={i + 1}>{m}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Año</label>
                        <select name="year" className="input" required>
                            {years.map((y) => (
                                <option key={y} value={y}>{y}</option>
                            ))}
                        </select>
                    </div>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    <button type="button" onClick={() => router.back()} className="btn btn-secondary">
                        Cancelar
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? "Crear Periodo" : "Crear Periodo"}
                    </button>
                </div>
            </form>
        </div>
    );
}
