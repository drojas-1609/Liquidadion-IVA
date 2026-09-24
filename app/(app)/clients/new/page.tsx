"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewClientPage() {
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
            const res = await fetch("/api/clients", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });

            if (!res.ok) {
                const j = await res.json().catch(() => null);
                throw new Error(j?.field ? `${j.field}: ${j.error}` : j?.error || "Error al crear el cliente");
            }

            router.push("/clients");
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Ocurrió un error al guardar el cliente.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="container" style={{ maxWidth: "600px" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-lg)" }}>
                Nuevo Cliente
            </h1>

            <form onSubmit={handleSubmit} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                {error && (
                    <div style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                        {error}
                    </div>
                )}

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Nombre / Razón Social</label>
                    <input name="name" type="text" required className="input" placeholder="Ej. Empresa S.A." />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>CUIT</label>
                    <input name="cuit" type="text" required className="input" placeholder="20-12345678-9" />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Condición Fiscal</label>
                    <select name="condition" className="input" required>
                        <option value="Responsable Inscripto">Responsable Inscripto</option>
                        <option value="Monotributo">Monotributo</option>
                        <option value="Exento">Exento</option>
                    </select>
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Alícuota IIBB Default (%)</label>
                    <input name="defaultIibbRate" type="text" inputMode="decimal" className="input" placeholder="3.0" defaultValue="3.0" />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Dirección</label>
                    <input name="address" type="text" className="input" placeholder="Calle Falsa 123" />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    <button type="button" onClick={() => router.back()} className="btn btn-secondary">
                        Cancelar
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? "Guardando..." : "Guardar Cliente"}
                    </button>
                </div>
            </form>
        </div>
    );
}
