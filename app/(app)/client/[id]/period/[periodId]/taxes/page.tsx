import Link from "next/link";
import { TaxRecordsImport } from "./_components/tax-records-import";
import { InvoicePerceptionsSync } from "./_components/invoice-perceptions-sync";
import { IibbDeductionsImport } from "./_components/iibb-deductions-import";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CREATE, ROLES_DELETE, ROLES_READ, ROLES_UPDATE } from "@/lib/auth/roles";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney, formatUtcDate } from "@/lib/format";
import { describeTaxRecordType } from "@/lib/tax-types";
import { taxEditHref, taxRowLabel } from "@/lib/tax-form-client";
import { TaxRowActions } from "./_components/tax-row-actions";
import { isPeriodClosed } from "@/lib/period-status";
import { summarizeIibbDeductions, IIBB_SUMMARY_CONCEPTS, type IibbSummaryCell } from "@/lib/iibb-deductions-summary";

export const dynamic = "force-dynamic";

/** Rótulo del catálogo; un tipo histórico desconocido se muestra marcado y con su valor original. */
function TaxTypeCell({ type }: { type: string }) {
    const d = describeTaxRecordType(type);
    if (d.known) return <>{d.label}</>;
    return (
        <>
            <strong>Tipo no reconocido</strong> <span>({d.value})</span>
        </>
    );
}

export default async function TaxesPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role, period } = await requirePeriodAccess(profileId, periodId, ROLES_READ, {
            expectClientId: id,
        });
        const taxes = await prisma.taxRecord.findMany({
            where: { periodId, organizationId },
            orderBy: { date: "desc" },
        });
        return { taxes, role, closed: isPeriodClosed(period.status) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { taxes, role, closed } = guard.data;

    // La API sigue siendo la autoridad; esto sólo decide qué se ofrece. Período
    // cerrado: sólo consulta.
    const canCreate = ROLES_CREATE.includes(role) && !closed;
    const canEdit = ROLES_UPDATE.includes(role) && !closed;
    const canDelete = ROLES_DELETE.includes(role) && !closed;
    const showActions = canEdit || canDelete;
    const iibbSummary = summarizeIibbDeductions(taxes);
    const CONCEPT_LABEL: Record<string, string> = { "RETENCION IIBB": "Retenciones", "PERCEPCION IIBB": "Percepciones", SIRCREB: "SIRCREB", SIRTAC: "SIRTAC" };
    const money = (d: IibbSummaryCell["total"]) => `$${formatMoney(d.toFixed(2))}`;
    const cellTitle = (c: IibbSummaryCell) => `Informado por el fisco ${money(c.byOrigin.reported)} · tomado de compras ${money(c.byOrigin.purchases)} · carga manual ${money(c.byOrigin.manual)}`;

    return (
        <div className="container">
            <div style={{ marginBottom: "var(--spacing-lg)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                    <Link href={`/client/${id}/period/${periodId}`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                        &larr; Volver al Periodo
                    </Link>
                    <h1>Retenciones y Percepciones</h1>
                </div>
                {canCreate && (
                    <Link href={`/client/${id}/period/${periodId}/taxes/new`} className="btn btn-primary">
                        Nueva Retención/Percepción
                    </Link>
                )}
                {closed && <span role="status" style={{ color: "var(--secondary)" }}>Período cerrado: sólo consulta</span>}
            </div>

            {canEdit && <InvoicePerceptionsSync periodId={periodId} />}
            {canCreate && <TaxRecordsImport periodId={periodId} />}
            {canCreate && <IibbDeductionsImport periodId={periodId} />}

            {iibbSummary.length > 0 && (
                <section className="card" aria-labelledby="iibb-summary" style={{ marginBottom: "var(--spacing-lg)" }}>
                    <h2 id="iibb-summary" style={{ fontSize: "1.125rem", fontWeight: 600, marginBottom: "var(--spacing-xs)" }}>Deducciones de IIBB por jurisdicción</h2>
                    <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                        Para controlar contra los resúmenes del fisco (SIRCREB, SIRTAC, e-SICOL, SIFERE). Debajo de cada importe, cuánto informó el fisco, cuánto se tomó de las compras y cuánto se cargó a mano.
                    </p>
                    <div className="table-wrap">
                        <table className="table" aria-label="Deducciones de IIBB por jurisdicción">
                            <thead><tr><th>Jurisdicción</th>{IIBB_SUMMARY_CONCEPTS.map((c) => <th key={c} className="num">{CONCEPT_LABEL[c]}</th>)}<th className="num">Total</th></tr></thead>
                            <tbody>
                                {iibbSummary.map((row) => (
                                    <tr key={row.jurisdictionCode ?? "sin"}>
                                        <td>{row.jurisdictionCode ?? "Sin jurisdicción"}</td>
                                        {IIBB_SUMMARY_CONCEPTS.map((c) => {
                                            const cell = row.cells[c];
                                            return (
                                                <td key={c} className="num" title={cell.count > 0 ? cellTitle(cell) : undefined}>
                                                    {cell.count > 0 ? (
                                                        <>
                                                            {money(cell.total)}
                                                            <div style={{ fontSize: "0.75rem", color: "var(--secondary)" }}>
                                                                {([["fisco", cell.byOrigin.reported], ["compras", cell.byOrigin.purchases], ["manual", cell.byOrigin.manual]] as const)
                                                                    .filter(([, v]) => !v.isZero())
                                                                    .map(([k, v]) => `${k} ${money(v)}`).join(" · ")}
                                                            </div>
                                                        </>
                                                    ) : "—"}
                                                </td>
                                            );
                                        })}
                                        <td className="num"><strong>{money(row.total)}</strong></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Tipo</th>
                            <th>Descripción</th>
                            <th className="num">Monto</th>
                            {showActions && <th>Acciones</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {taxes.length === 0 ? (
                            <tr>
                                <td colSpan={showActions ? 5 : 4} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                    No hay registros.
                                </td>
                            </tr>
                        ) : (
                            taxes.map((tax) => {
                                const date = formatUtcDate(tax.date);
                                const typeInfo = describeTaxRecordType(tax.type);
                                const typeText = typeInfo.known ? typeInfo.label : `Tipo no reconocido (${typeInfo.value})`;
                                const updatedAt = tax.updatedAt.toISOString();
                                return (
                                    <tr key={tax.id}>
                                        <td>{date}</td>
                                        <td>
                                            <TaxTypeCell type={tax.type} />
                                        </td>
                                        <td>
                                            {tax.description}
                                            {tax.fromInvoice && <> <span className="badge badge-info">Del comprobante</span></>}
                                            {!tax.fromInvoice && tax.invoiceId && <> <span className="badge badge-success">Vinculada a la compra</span></>}
                                            {tax.jurisdictionCode && <> <span className="badge badge-plain">Jurisdicción {tax.jurisdictionCode}</span></>}
                                        </td>
                                        <td className="num">${formatMoney(tax.amount.toFixed(2))}</td>
                                        {showActions && (
                                            <td>
                                                <TaxRowActions
                                                    key={`${tax.id}-${updatedAt}`}
                                                    taxId={tax.id}
                                                    updatedAt={updatedAt}
                                                    label={taxRowLabel(typeText, date)}
                                                    editHref={canEdit ? taxEditHref(id, periodId, tax.id) : null}
                                                    canDelete={canDelete && !tax.fromInvoice}
                                                />
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
