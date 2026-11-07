import Link from "next/link";
import prisma from "@/lib/prisma";
import { listPeriodInvoices } from "@/lib/period-invoice-list";
import { parsePageParam } from "@/lib/pagination";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE } from "@/lib/auth/roles";
import { isPeriodClosed } from "@/lib/period-status";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney, formatIsoDate } from "@/lib/format";
import { normalizeInvoiceRow } from "@/lib/invoice-model";
import { invoiceRowActions } from "@/lib/invoice-edit";
import { otherConceptsOf } from "@/lib/invoice-list-view";
import { invoiceEditHref } from "@/lib/invoice-form-client";
import { InvoiceRowActions } from "../_components/invoice-row-actions";
import { DeletableInvoiceRow, DeletableInvoiceRows } from "../_components/invoice-deletable-row";
import { InvoicePager } from "../_components/invoice-pager";


export const dynamic = "force-dynamic";

export default async function SalesPage({ params, searchParams }: { params: Promise<{ id: string; periodId: string }>; searchParams?: Promise<{ page?: string | string[] }> }) {
    const { id, periodId } = await params;
    const requestedPage = parsePageParam((await searchParams)?.page);

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role, period } = await requirePeriodAccess(profileId, periodId, ROLES_READ, {
            expectClientId: id,
        });
        // Detalle paginado (100 por página): con miles de comprobantes la lista
        // completa no entra en una respuesta.
        const { invoices, window } = await listPeriodInvoices(prisma, { organizationId, periodId }, "SALES", requestedPage);
        return { role, invoices, window, closed: isPeriodClosed(period.status) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { role, invoices, window, closed } = guard.data;
    const pager = <InvoicePager basePath={`/client/${id}/period/${periodId}/sales`} window={window} noun="ventas" />;
    // VIEWER o período cerrado: sin columna de acciones ni alta (sólo consulta).
    const showActions = ROLES_UPDATE.includes(role) && !closed;

    return (
        <div className="container">
            <div style={{ marginBottom: "var(--spacing-lg)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                    <Link href={`/client/${id}/period/${periodId}`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                        &larr; Volver al Periodo
                    </Link>
                    <h1 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Ventas</h1>
                </div>
                {closed ? (
                    <span role="status" style={{ color: "var(--secondary)" }}>Período cerrado: sólo consulta</span>
                ) : (
                    <Link href={`/client/${id}/period/${periodId}/sales/new`} className="btn btn-primary">
                        Nueva Venta
                    </Link>
                )}
            </div>

            {pager}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <p style={{ fontSize: "0.85rem", color: "var(--secondary)", marginBottom: "var(--spacing-sm)" }}>
                    El total incluye el exento, el no gravado, las percepciones y los otros tributos, que no forman parte del neto ni del IVA. Las notas de crédito restan.
                </p>
                {/* Retira localmente las filas cuya baja ya confirmó el servidor (204). */}
                <DeletableInvoiceRows label="Lista de ventas">
                <table className="table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Tipo</th>
                            <th>Número</th>
                            <th>Cliente</th>
                            <th>Neto</th>
                            <th>IVA</th>
                            <th>Exento, no gravado y otros</th>
                            <th>Total</th>
                            {showActions && <th>Acciones</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {invoices.length === 0 ? (
                            <tr>
                                <td colSpan={showActions ? 9 : 8} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                    No hay ventas registradas.
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
                                // Venta global diaria (documento 99): el rango del día, no sólo el primer número.
                                const range = invoice.numberTo !== null && invoice.numberTo !== invoice.number ? ` a ${invoice.numberTo.toString().padStart(8, "0")}` : "";
                                const actions = showActions
                                    ? invoiceRowActions(role, { ...columns, vatRateCodes: vatLines.map((l) => l.vatRateCode) })
                                    : null;
                                return (
                                    <DeletableInvoiceRow key={invoice.id} invoiceId={invoice.id}>
                                        <td>{formatIsoDate(view.voucherDate)}</td>
                                        <td>{view.voucherLabel}</td>
                                        <td>{number}{range}</td>
                                        <td>{view.counterpartyName}</td>
                                        <td>${formatMoney(view.signedNet.toFixed(2))}</td>
                                        <td>${formatMoney(view.signedVat.toFixed(2))}</td>
                                        <td>
                                            {otherConceptsOf(columns).map((c) => (
                                                <div key={c.label}>{c.label} ${formatMoney(c.signed.toFixed(2))}</div>
                                            ))}
                                        </td>
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
                                                    editHref={actions.canEdit ? invoiceEditHref("SALES", id, periodId, invoice.id) : null}
                                                    canDelete={actions.canDelete}
                                                    imported={invoice.source === "IMPORT"}
                                                />}
                                            </td>
                                        )}
                                    </DeletableInvoiceRow>
                                );
                            })
                        )}
                    </tbody>
                </table>
                </DeletableInvoiceRows>
            </div>
            {window.pageCount > 1 && pager}
        </div>
    );
}
