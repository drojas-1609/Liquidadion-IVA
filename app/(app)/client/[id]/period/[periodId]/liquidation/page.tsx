import Link from "next/link";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { computeLiquidation } from "@/lib/liquidation-calc";
import { formatMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

const m = (d: Prisma.Decimal) => formatMoney(d.toFixed(2));
const clampPos = (d: Prisma.Decimal) => (d.isNegative() ? new Prisma.Decimal(0) : d);

export default async function LiquidationPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await requirePeriodAccess(profileId, periodId, ROLES_READ, {
            expectClientId: id,
        });
        const found = await prisma.period.findFirst({
            where: { id: periodId, organizationId },
            include: { invoices: true, taxRecords: true, client: true },
        });
        if (!found) throw new NotFoundError();
        return found;
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const period = guard.data;

    const r = computeLiquidation(period);

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
                    <span style={{ fontWeight: 500 }}>${m(r.iva.debit)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Crédito Fiscal (Compras)</span>
                    <span style={{ fontWeight: 500 }}>- ${m(r.iva.credit)}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)", padding: "var(--spacing-sm) 0", borderTop: "1px dashed var(--border)", borderBottom: "1px dashed var(--border)" }}>
                    <span style={{ fontWeight: 600 }}>Saldo Técnico</span>
                    <span style={{ fontWeight: 600, color: r.iva.balance.greaterThan(0) ? "var(--error)" : "var(--success)" }}>
                        ${m(r.iva.balance)}
                    </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Retenciones / Percepciones IVA</span>
                    <span style={{ fontWeight: 500 }}>- ${m(r.iva.retentions)}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--spacing-lg)", padding: "var(--spacing-md)", backgroundColor: "var(--surface-hover)", borderRadius: "var(--radius-md)" }}>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold" }}>Saldo a Pagar IVA</span>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold", color: r.iva.payable.greaterThan(0) ? "var(--error)" : "var(--success)" }}>
                        ${m(clampPos(r.iva.payable))}
                    </span>
                </div>
                {r.iva.payable.isNegative() && (
                    <div style={{ textAlign: "right", marginTop: "var(--spacing-xs)", color: "var(--success)", fontSize: "0.875rem" }}>
                        Saldo a favor: ${m(r.iva.payable.abs())}
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
                    <span style={{ fontWeight: 500 }}>${m(r.iibb.base)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Impuesto Determinado ({r.iibb.rate.toString()}%)</span>
                    <span style={{ fontWeight: 500 }}>${m(r.iibb.tax)}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Retenciones / Percepciones / SIRCREB</span>
                    <span style={{ fontWeight: 500 }}>- ${m(r.iibb.retentions)}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--spacing-lg)", padding: "var(--spacing-md)", backgroundColor: "var(--surface-hover)", borderRadius: "var(--radius-md)" }}>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold" }}>Saldo a Pagar IIBB</span>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold", color: r.iibb.payable.greaterThan(0) ? "var(--error)" : "var(--success)" }}>
                        ${m(clampPos(r.iibb.payable))}
                    </span>
                </div>
                {r.iibb.payable.isNegative() && (
                    <div style={{ textAlign: "right", marginTop: "var(--spacing-xs)", color: "var(--success)", fontSize: "0.875rem" }}>
                        Saldo a favor: ${m(r.iibb.payable.abs())}
                    </div>
                )}
            </div>
        </div>
    );
}
