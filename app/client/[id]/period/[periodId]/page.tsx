import Link from "next/link";
import prisma from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function PeriodDashboard({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const period = await prisma.period.findUnique({
        where: { id: periodId },
        include: {
            invoices: true,
            taxRecords: true,
        },
    });

    if (!period) {
        redirect(`/client/${id}/dashboard`);
    }

    // Calculate Totals
    const sales = period.invoices.filter((i: any) => i.category === "SALES");
    const purchases = period.invoices.filter((i: any) => i.category === "PURCHASES");

    const totalSales = sales.reduce((acc: number, curr: any) => acc + curr.totalAmount, 0);
    const totalSalesVAT = sales.reduce((acc: number, curr: any) => acc + curr.vatAmount, 0);

    const totalPurchases = purchases.reduce((acc: number, curr: any) => acc + curr.totalAmount, 0);
    const totalPurchasesVAT = purchases.reduce((acc: number, curr: any) => acc + curr.vatAmount, 0);

    const vatPosition = totalSalesVAT - totalPurchasesVAT;

    return (
        <div className="container">
            <div style={{ marginBottom: "var(--spacing-xl)" }}>
                <Link href={`/client/${id}/dashboard`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                    &larr; Volver al Cliente
                </Link>
                <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>
                    Periodo {period.month.toString().padStart(2, "0")}/{period.year}
                </h1>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "var(--spacing-lg)", marginBottom: "var(--spacing-xl)" }}>
                {/* Sales Card */}
                <div className="card">
                    <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)", color: "var(--success)" }}>Ventas</h3>
                    <div style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                        ${totalSales.toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </div>
                    <div style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>
                        IVA Débito: ${totalSalesVAT.toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </div>
                    <Link href={`/client/${id}/period/${periodId}/sales`} className="btn btn-secondary" style={{ width: "100%" }}>
                        Gestionar Ventas
                    </Link>
                </div>

                {/* Purchases Card */}
                <div className="card">
                    <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)", color: "var(--error)" }}>Compras</h3>
                    <div style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                        ${totalPurchases.toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </div>
                    <div style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>
                        IVA Crédito: ${totalPurchasesVAT.toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </div>
                    <Link href={`/client/${id}/period/${periodId}/purchases`} className="btn btn-secondary" style={{ width: "100%" }}>
                        Gestionar Compras
                    </Link>
                </div>

                {/* Tax Position Card */}
                <div className="card glass-panel" style={{ borderColor: vatPosition > 0 ? "var(--error)" : "var(--success)" }}>
                    <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)" }}>Posición IVA</h3>
                    <div style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)", color: vatPosition > 0 ? "var(--error)" : "var(--success)" }}>
                        ${Math.abs(vatPosition).toLocaleString("es-AR", { minimumFractionDigits: 2 })}
                    </div>
                    <div style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>
                        {vatPosition > 0 ? "A Pagar" : "A Favor"}
                    </div>
                    <Link href={`/client/${id}/period/${periodId}/liquidation`} className="btn btn-primary" style={{ width: "100%" }}>
                        Ver Liquidación Completa
                    </Link>
                </div>
            </div>

            <div className="card">
                <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)" }}>Retenciones y Percepciones</h3>
                <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-md)" }}>Gestiona las retenciones y percepciones sufridas en el periodo.</p>
                <Link href={`/client/${id}/period/${periodId}/taxes`} className="btn btn-secondary">
                    Gestionar Retenciones/Percepciones
                </Link>
            </div>
        </div>
    );
}