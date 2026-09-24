"use client";

import { useState, use } from "react";
import { useRouter } from "next/navigation";

export default function NewSalePage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = use(params);
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Previsualización SOLO para pantalla (number de JS). No es autoritativa:
    // el servidor recalcula vatAmount/totalAmount con Decimal e ignora lo que
    // se envíe. El valor que se ENVÍA es el string crudo del input.
    const [netRaw, setNetRaw] = useState("0");
    const [vatRate, setVatRate] = useState("21");

    const netPreview = parseFloat(netRaw) || 0;
    const vatPreview = netPreview * (parseFloat(vatRate) / 100);
    const totalPreview = netPreview + vatPreview;

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
                    // vatAmount / totalAmount NO se envían: los calcula el servidor.
                    category: "SALES",
                    periodId,
                }),
            });

            if (!res.ok) {
                const j = await res.json().catch(() => null);
                throw new Error(j?.field ? `${j.field}: ${j.error}` : j?.error || "Error al crear la factura");
            }

            router.push(`/client/${id}/period/${periodId}/sales`);
            router.refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Ocurrió un error al guardar la factura.");
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
                        type="text"
                        inputMode="decimal"
                        required
                        className="input"
                        value={netRaw}
                        onChange={(e) => setNetRaw(e.target.value)}
                    />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Alícuota IVA</label>
                    <select
                        name="vatRate"
                        className="input"
                        value={vatRate}
                        onChange={(e) => setVatRate(e.target.value)}
                    >
                        <option value="21">21%</option>
                        <option value="10.5">10.5%</option>
                        <option value="27">27%</option>
                        <option value="2.5">2.5%</option>
                        <option value="0">0%</option>
                    </select>
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>IVA Calculado (previsualización)</label>
                    <input type="text" className="input" value={vatPreview.toFixed(2)} disabled />
                </div>

                <div>
                    <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>Total (previsualización)</label>
                    <input type="text" className="input" value={totalPreview.toFixed(2)} disabled />
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
