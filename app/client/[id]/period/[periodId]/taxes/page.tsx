import Link from "next/link";
import prisma from "@/lib/prisma";


export const dynamic = "force-dynamic";

export default async function TaxesPage({ params }: { params: { id: string; periodId: string } }) {
    const { id, periodId } = params;

    const taxes = await prisma.taxRecord.findMany({
        where: { periodId },
        orderBy: { date: "desc" },
    });

    return (
        <div className="container">
            <div style={{ marginBottom: "var(--spacing-lg)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                    <Link href={`/client/${id}/period/${periodId}`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                        &larr; Volver al Periodo
                    </Link>
                    <h1 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Retenciones y Percepciones</h1>
                </div>
                <Link href={`/client/${id}/period/${periodId}/taxes/new`} className="btn btn-primary">
                    Nueva Retención/Percepción
                </Link>
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Tipo</th>
                            <th>Descripción</th>
                            <th>Monto</th>
                        </tr>
                    </thead>
                    <tbody>
                        {taxes.length === 0 ? (
                            <tr>
                                <td colSpan={4} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                    No hay registros.
                                </td>
                            </tr>
                        ) : (
                            taxes.map((tax) => (
                                <tr key={tax.id}>
                                    <td>{new Date(tax.date).toLocaleDateString("es-AR")}</td>
                                    <td>{tax.type}</td>
                                    <td>{tax.description}</td>
                                    <td>${tax.amount.toLocaleString("es-AR", { minimumFractionDigits: 2 })}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
