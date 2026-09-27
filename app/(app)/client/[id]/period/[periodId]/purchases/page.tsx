import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE } from "@/lib/auth/roles";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney, formatIsoDate } from "@/lib/format";
import { normalizeInvoiceRow } from "@/lib/invoice-model";
import { invoiceRowActions } from "@/lib/invoice-edit";
import { invoiceEditHref } from "@/lib/invoice-form-client";
import { InvoiceRowActions } from "../_components/invoice-row-actions";


export const dynamic = "force-dynamic";

export default async function PurchasesPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requirePeriodAccess(profileId, periodId, ROLES_READ, {
            expectClientId: id,
        });
        const invoices = await prisma.invoice.findMany({
            where: { periodId, organizationId, category: "PURCHASES" },
            orderBy: { date: "desc" },
            // Sólo los códigos de alícuota: deciden editabilidad / eliminabilidad.
            include: { vatLines: { select: { vatRateCode: true } } },
        });
        return { role, invoices };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { role, invoices } = guard.data;
    // VIEWER: sin columna de acciones.
    const showActions = ROLES_UPDATE.includes(role);

    return (
        <div className="container">
            <div style={{ marginBottom: "var(--spacing-lg)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                    <Link href={`/client/${id}/period/${periodId}`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                        &larr; Volver al Periodo
                    </Link>
                    <h1 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Compras</h1>
                </div>
                <Link href={`/client/${id}/period/${periodId}/purchases/new`} className="btn btn-primary">
                    Nueva Compra
                </Link>
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Tipo</th>
                            <th>Número</th>
                            <th>Proveedor</th>
                            <th>Neto</th>
                            <th>IVA</th>
                            <th>Total</th>
                            {showActions && <th>Acciones</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {invoices.length === 0 ? (
                            <tr>
                                <td colSpan={showActions ? 8 : 7} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                    No hay compras registradas.
                                </td>
                            </tr>
                        ) : (
                            invoices.map((invoice) => {
                                // Vista única (modelo contable o fila heredada), con signo contable. Las
                                // líneas leídas sólo traen el código de alícuota: no se pasan a la vista
                                // (misma entrada que antes de agregarlas).
                                const { vatLines, ...columns } = invoice;
                                const view = normalizeInvoiceRow(columns);
                                const number = `${invoice.pointOfSale.toString().padStart(4, "0")}-${invoice.number.toString().padStart(8, "0")}`;
                                const actions = showActions
                                    ? invoiceRowActions(role, { ...columns, vatRateCodes: vatLines.map((l) => l.vatRateCode) })
                                    : null;
                                return (
                                    <tr key={invoice.id}>
                                        <td>{formatIsoDate(view.voucherDate)}</td>
                                        <td>{view.voucherLabel}</td>
                                        <td>{number}</td>
                                        <td>{view.counterpartyName}</td>
                                        <td>${formatMoney(view.signedNet.toFixed(2))}</td>
                                        <td>${formatMoney(view.signedVat.toFixed(2))}</td>
                                        <td>${formatMoney(view.signedTotal.toFixed(2))}</td>
                                        {actions && (
                                            <td>
                                                {/* Sin acciones permitidas no se envía nada al cliente. key con el
                                                    token: tras recargar, el estado de la fila se reinicia. */}
                                                {(actions.canEdit || actions.canDelete) && <InvoiceRowActions
                                                    key={`${invoice.id}-${invoice.updatedAt.toISOString()}`}
                                                    invoiceId={invoice.id}
                                                    updatedAt={invoice.updatedAt.toISOString()}
                                                    label={`${view.voucherLabel} ${number}`}
                                                    editHref={actions.canEdit ? invoiceEditHref("PURCHASES", id, periodId, invoice.id) : null}
                                                    canDelete={actions.canDelete}
                                                />}
                                            </td>
                                        )}
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
