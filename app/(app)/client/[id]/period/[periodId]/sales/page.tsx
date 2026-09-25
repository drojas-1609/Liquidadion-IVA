import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ } from "@/lib/auth/roles";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney, formatIsoDate } from "@/lib/format";
import { normalizeInvoiceRow } from "@/lib/invoice-model";


export const dynamic = "force-dynamic";

export default async function SalesPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await requirePeriodAccess(profileId, periodId, ROLES_READ, {
            expectClientId: id,
        });
        return prisma.invoice.findMany({
            where: { periodId, organizationId, category: "SALES" },
            orderBy: { date: "desc" },
        });
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const invoices = guard.data;

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
                            invoices.map((invoice) => {
                                // Vista única (modelo contable o fila heredada), con signo contable.
                                const view = normalizeInvoiceRow(invoice);
                                return (
                                    <tr key={invoice.id}>
                                        <td>{formatIsoDate(view.voucherDate)}</td>
                                        <td>{view.voucherLabel}</td>
                                        <td>{invoice.pointOfSale.toString().padStart(4, "0")}-{invoice.number.toString().padStart(8, "0")}</td>
                                        <td>{view.counterpartyName}</td>
                                        <td>${formatMoney(view.signedNet.toFixed(2))}</td>
                                        <td>${formatMoney(view.signedVat.toFixed(2))}</td>
                                        <td>${formatMoney(view.signedTotal.toFixed(2))}</td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
