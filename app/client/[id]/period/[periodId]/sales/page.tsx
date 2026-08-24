import Link from "next/link";
import prisma from "@/lib/prisma";


export const dynamic = "force-dynamic";

export default async function SalesPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const invoices = await prisma.invoice.findMany({
        where: {
            periodId,
            category: "SALES",
        },
        orderBy: { date: "desc" },
    });

    return (
        <div className="container">
            <div style={{ marginBottom: "var(--spacing-lg)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                    <Link href={`/client/${id}/period/${periodId}`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                        &larr; Volver al Periodo
                    </Link>
                    <h1 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Ventas</h1>
                </div>
                <Link href={`/client/${id}/period/${periodId}/sales/new`} className="btn btn-primary">
                    Nueva Venta
                </Link>
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Tipo</th>
                            <th>Número</th>
                            <th>Cliente</th>
                            <th>Neto</th>
                            <th>IVA</th>
                            <th>Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {invoices.length === 0 ? (
                            <tr>
                                <td colSpan={7} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                    No hay ventas registradas.
                                </td>
                            </tr>
                        ) : (
                            invoices.map((invoice: any) => (
                                <tr key={invoice.id}>
                                    <td>{new Date(invoice.date).toLocaleDateString("es-AR")}</td>
                                    <td>{invoice.type}</td>
                                    <td>{invoice.pointOfSale.toString().padStart(4, "0")}-{invoice.number.toString().padStart(8, "0")}</td>
                                    <td>{invoice.entityName}</td>
                                    <td>${invoice.netAmount.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</td>
                                    <td>${invoice.vatAmount.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</td>
                                    <td>${invoice.totalAmount.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
