"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { submitClientUpdate } from "@/lib/client-mutations";

const CONDITIONS = ["Responsable Inscripto", "Monotributo", "Exento"];

export interface EditableClient {
    id: string;
    name: string;
    cuit: string;
    condition: string;
    address: string;
    defaultIibbRate: string;
}

export function EditClientForm({ client }: { client: EditableClient }) {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const conditions = CONDITIONS.includes(client.condition) ? CONDITIONS : [client.condition, ...CONDITIONS];
    const dashboardHref = `/client/${client.id}/dashboard`;

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setLoading(true);
        setError("");

        const data = Object.fromEntries(new FormData(e.currentTarget).entries());

        try {
            const result = await submitClientUpdate(client.id, data);
            if (!result.ok) {
                setError(result.message);
                return;
            }

            router.push(dashboardHref);
            router.refresh();
        } catch {
            setError("Ocurrió un error al guardar el cliente.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="container" style={{ maxWidth: "600px" }}>
            <Link href={dashboardHref} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                &larr; Volver al cliente
            </Link>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-lg)" }}>
                Editar Cliente
            </h1>

            <form onSubmit={handleSubmit} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                {error && (
                    <div role="alert" style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                        {error}
                    </div>
                )}

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Nombre / Razón Social</label>
                    <input name="name" type="text" required className="input" defaultValue={client.name} />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>CUIT</label>
                    <input name="cuit" type="text" required className="input" defaultValue={client.cuit} />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Condición Fiscal</label>
                    <select name="condition" className="input" required defaultValue={client.condition}>
                        {conditions.map((c) => (
                            <option key={c} value={c}>{c}</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Alícuota IIBB Default (%)</label>
                    <input name="defaultIibbRate" type="text" inputMode="decimal" required className="input" defaultValue={client.defaultIibbRate} />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Dirección</label>
                    <input name="address" type="text" className="input" defaultValue={client.address} />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    <Link href={dashboardHref} className="btn btn-secondary">
                        Cancelar
                    </Link>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        {loading ? "Guardando..." : "Guardar Cambios"}
                    </button>
                </div>
            </form>
        </div>
    );
}
