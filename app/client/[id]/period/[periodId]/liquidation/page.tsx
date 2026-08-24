import Link from "next/link";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function LiquidationPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const period = await prisma.period.findUnique({
        where: { id: periodId },
        include: {
            invoices: true,
            taxRecords: true,
            client: true,
        },
    });

    if (!period) return <div>Periodo no encontrado</div>;

    // --- IVA Calculation ---
    const sales = period.invoices.filter((i: any) => i.category === "SALES");
    const purchases = period.invoices.filter((i: any) => i.category === "PURCHASES");

    const totalSalesNet = sales.reduce((acc: number, curr: any) => acc + curr.netAmount, 0);
    const totalSalesVAT = sales.reduce((acc: number, curr: any) => acc + curr.vatAmount, 0);

    const totalPurchasesVAT = purchases.reduce((acc: number, curr: any) => acc + curr.vatAmount, 0);

    const ivaDebit = totalSalesVAT;
    const ivaCredit = totalPurchasesVAT;
    const ivaTechnicalBalance = ivaDebit - ivaCredit;

    // Withholdings/Perceptions for IVA
    const ivaRetentions = period.taxRecords
        .filter((t: any) => t.type.includes("IVA"))
        .reduce((acc: number, curr: any) => acc + curr.amount, 0);

    const ivaPayable = ivaTechnicalBalance - ivaRetentions;

    // --- IIBB Calculation (Simplified) ---
    // Assuming a standard rate, in a real app this should be configurable per client/activity
    const iibbRate = period.client.defaultIibbRate || 3.0;
    const iibbTax = totalSalesNet * (iibbRate / 100);

    // Withholdings/Perceptions for IIBB
    const iibbRetentions = period.taxRecords
        .filter((t: any) => t.type.includes("IIBB") || t.type === "SIRCREB" || t.type === "SIRTAC")
        .reduce((acc: number, curr: any) => acc + curr.amount, 0);

    const iibbPayable = iibbTax - iibbRetentions;

    return (
        <div className="container" style={{ maxWidth: "800px" }}>
            <div style={{ marginBottom: "var(--spacing-xl)" }}>
                <Link href={`/client/${id}/period/${periodId}`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                    &larr; Volver al Periodo
                </Link>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>Liquidación de Impuestos</h1>
                    <a href={`/api/client/${id}/period/${periodId}/export`} className="btn btn-primary" target="_blank" rel="noreferrer">
                        Exportar a Excel
                    </a>
                </div>
                <p style={{ color: "var(--secondary)" }}>
                    Cliente: {period.client.name} - Periodo: {period.month.toString().padStart(2, "0")}/{period.year}
                </p>
            </div>

            {/* IVA Section */}
            <div className="card" style={{ marginBottom: "var(--spacing-xl)" }}>
                <h2 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-md)", borderBottom: "1px solid var(--border)", paddingBottom: "var(--spacing-sm)" }}>
                    Impuesto al Valor Agregado (IVA)
                </h2>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-sm)" }}>
                    <span>Débito Fiscal (Ventas)</span>
                    <span style={{ fontWeight: 500 }}>${ivaDebit.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Crédito Fiscal (Compras)</span>
                    <span style={{ fontWeight: 500 }}>- ${ivaCredit.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)", padding: "var(--spacing-sm) 0", borderTop: "1px dashed var(--border)", borderBottom: "1px dashed var(--border)" }}>
                    <span style={{ fontWeight: 600 }}>Saldo Técnico</span>
                    <span style={{ fontWeight: 600, color: ivaTechnicalBalance > 0 ? "var(--error)" : "var(--success)" }}>
                        ${ivaTechnicalBalance.toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Retenciones / Percepciones IVA</span>
                    <span style={{ fontWeight: 500 }}>- ${ivaRetentions.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--spacing-lg)", padding: "var(--spacing-md)", backgroundColor: "var(--surface-hover)", borderRadius: "var(--radius-md)" }}>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold" }}>Saldo a Pagar IVA</span>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold", color: ivaPayable > 0 ? "var(--error)" : "var(--success)" }}>
                        ${Math.max(0, ivaPayable).toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </span>
                </div>
                {ivaPayable < 0 && (
                    <div style={{ textAlign: "right", marginTop: "var(--spacing-xs)", color: "var(--success)", fontSize: "0.875rem" }}>
                        Saldo a favor: ${Math.abs(ivaPayable).toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </div>
                )}
            </div>

            {/* IIBB Section */}
            <div className="card">
                <h2 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-md)", borderBottom: "1px solid var(--border)", paddingBottom: "var(--spacing-sm)" }}>
                    Ingresos Brutos (IIBB)
                </h2>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-sm)" }}>
                    <span>Ventas Netas</span>
                    <span style={{ fontWeight: 500 }}>${totalSalesNet.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Impuesto Determinado ({iibbRate}%)</span>
                    <span style={{ fontWeight: 500 }}>${iibbTax.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Retenciones / Percepciones / SIRCREB</span>
                    <span style={{ fontWeight: 500 }}>- ${iibbRetentions.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--spacing-lg)", padding: "var(--spacing-md)", backgroundColor: "var(--surface-hover)", borderRadius: "var(--radius-md)" }}>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold" }}>Saldo a Pagar IIBB</span>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold", color: iibbPayable > 0 ? "var(--error)" : "var(--success)" }}>
                        ${Math.max(0, iibbPayable).toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </span>
                </div>
                {iibbPayable < 0 && (
                    <div style={{ textAlign: "right", marginTop: "var(--spacing-xs)", color: "var(--success)", fontSize: "0.875rem" }}>
                        Saldo a favor: ${Math.abs(iibbPayable).toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </div>
                )}
            </div>
        </div>
    );
}