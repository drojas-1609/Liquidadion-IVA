import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CREATE, ROLES_DELETE, ROLES_READ, ROLES_UPDATE } from "@/lib/auth/roles";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney, formatUtcDate } from "@/lib/format";
import { describeTaxRecordType } from "@/lib/tax-types";
import { taxEditHref, taxRowLabel } from "@/lib/tax-form-client";
import { TaxRowActions } from "./_components/tax-row-actions";

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
        const { organizationId, role } = await requirePeriodAccess(profileId, periodId, ROLES_READ, {
            expectClientId: id,
        });
        const taxes = await prisma.taxRecord.findMany({
            where: { periodId, organizationId },
            orderBy: { date: "desc" },
        });
        return { taxes, role };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { taxes, role } = guard.data;

    // La API sigue siendo la autoridad; esto sólo decide qué se ofrece.
    const canCreate = ROLES_CREATE.includes(role);
    const canEdit = ROLES_UPDATE.includes(role);
    const canDelete = ROLES_DELETE.includes(role);
    const showActions = canEdit || canDelete;

    return (
        <div className="container">
            <div style={{ marginBottom: "var(--spacing-lg)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                    <Link href={`/client/${id}/period/${periodId}`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                        &larr; Volver al Periodo
                    </Link>
                    <h1 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>Retenciones y Percepciones</h1>
                </div>
                {canCreate && (
                    <Link href={`/client/${id}/period/${periodId}/taxes/new`} className="btn btn-primary">
                        Nueva Retención/Percepción
                    </Link>
                )}
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Tipo</th>
                            <th>Descripción</th>
                            <th>Monto</th>
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
                                        <td>{tax.description}</td>
                                        <td>${formatMoney(tax.amount.toFixed(2))}</td>
                                        {showActions && (
                                            <td>
                                                <TaxRowActions
                                                    key={`${tax.id}-${updatedAt}`}
                                                    taxId={tax.id}
                                                    updatedAt={updatedAt}
                                                    label={taxRowLabel(typeText, date)}
                                                    editHref={canEdit ? taxEditHref(id, periodId, tax.id) : null}
                                                    canDelete={canDelete}
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
