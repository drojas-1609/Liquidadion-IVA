"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewSalePage({ params }: { params: { id: string; periodId: string } }) {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Auto-calculate VAT and Total
    const [netAmount, setNetAmount] = useState(0);
    const [vatRate, setVatRate] = useState(21);

    const vatAmount = netAmount * (vatRate / 100);
    const totalAmount = netAmount + vatAmount;

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setLoading(true);
        setError("");

        const formData = new FormData(e.currentTarget);
        const data = Object.fromEntries(formData.entries());

        try {
            const res = await fetch("/api/invoices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...data,
                    vatAmount,
                    totalAmount,
                    category: "SALES",
                    periodId: params.periodId,
                }),
            });

            if (!res.ok) throw new Error("Error al crear la factura");

            router.push(`/client/${params.id}/period/${params.periodId}/sales`);
            router.refresh();
        } catch (err) {
            setError("Ocurrió un error al guardar la factura.");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="container" style={{ maxWidth: "800px" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-lg)" }}>
                Nueva Venta
            </h1>

            <form onSubmit={handleSubmit} className="card" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--spacing-md)" }}>
                {error && (
                    <div style={{ gridColumn: "1 / -1", padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                        {error}
                    </div>
                )}

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Fecha</label>
                    <input name="date" type="date" required className="input" />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Tipo Comprobante</label>
                    <select name="type" className="input" required>
                        <option value="FC A">Factura A</option>
                        <option value="FC B">Factura B</option>
                        <option value="FC C">Factura C</option>
                        <option value="NC A">Nota de Crédito A</option>
                    </select>
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Punto de Venta</label>
                    <input name="pointOfSale" type="number" required className="input" placeholder="0001" />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Número</label>
                    <input name="number" type="number" required className="input" placeholder="12345678" />
                </div>

                <div style={{ gridColumn: "1 / -1" }}>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Cliente (Razón Social)</label>
                    <input name="entityName" type="text" required className="input" />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>CUIT Cliente</label>
                    <input name="entityCuit" type="text" required className="input" />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Neto Gravado</label>
                    <input
                        name="netAmount"
                        type="number"
                        step="0.01"
                        required
                        className="input"
                        value={netAmount}
                        onChange={(e) => setNetAmount(parseFloat(e.target.value) || 0)}
                    />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Alícuota IVA</label>
                    <select
                        name="vatRate"
                        className="input"
                        value={vatRate}
                        onChange={(e) => setVatRate(parseFloat(e.target.value))}
                    >
                        <option value={21}>21%</option>
                        <option value={10.5}>10.5%</option>
                        <option value={27}>27%</option>
                        <option value={0}>0%</option>
                    </select>
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>IVA Calculado</label>
                    <input type="text" className="input" value={vatAmount.toFixed(2)} disabled />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Total</label>
                    <input type="text" className="input" value={totalAmount.toFixed(2)} disabled />
                </div>

                <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    <button type="button" onClick={() => router.back()} className="btn btn-secondary">
                        Cancelar
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={loading}>
                        Guardar Venta
                    </button>
                </div>
            </form>
        </div>
    );
}
