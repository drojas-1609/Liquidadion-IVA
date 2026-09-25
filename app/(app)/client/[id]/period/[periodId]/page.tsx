import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_DELETE, roleAllows } from "@/lib/auth/roles";
import { formatPeriodLabel } from "@/lib/period";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { computeLiquidation, type LiquidationResult } from "@/lib/liquidation-calc";
import { MissingGlobalProrationCoefficientError } from "@/lib/invoice-model";
import { formatMoney } from "@/lib/format";
import { PeriodActions } from "./period-actions";

export const dynamic = "force-dynamic";

export default async function PeriodDashboard({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requirePeriodAccess(profileId, periodId, ROLES_READ, {
            expectClientId: id,
        });
        const found = await prisma.period.findFirst({
            where: { id: periodId, organizationId },
            include: { invoices: { include: { vatLines: true } }, taxRecords: true, client: true, vatSettings: true },
        });
        if (!found) throw new NotFoundError();
        return { period: found, role };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { period, role } = guard.data;
    const canDelete = roleAllows(ROLES_DELETE, role);
    const hasMovements = period.invoices.length > 0 || period.taxRecords.length > 0;

    // Totales vía la única fuente de cálculo (lib/liquidation-calc).
    // Falla cerrada: con líneas sujetas a prorrateo global y sin coeficiente no
    // se muestra una liquidación parcial.
    let r: LiquidationResult;
    try {
        r = computeLiquidation(period);
    } catch (err) {
        if (!(err instanceof MissingGlobalProrationCoefficientError)) throw err;
        return (
            <div className="container">
                <div role="alert" className="card" style={{ color: "var(--error)" }}>
                    {err.message}
                </div>
            </div>
        );
    }
    const totalSales = r.sales.total;
    const totalSalesVAT = r.sales.vat;
    const totalPurchases = r.purchases.total;
    const totalPurchasesVAT = r.purchases.vat;
    const vatPosition = r.iva.balance;

    return (
        <div className="container">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--spacing-md)", flexWrap: "wrap", marginBottom: "var(--spacing-xl)" }}>
                <div>
                    <Link href={`/client/${id}/dashboard`} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                        &larr; Volver al Cliente
                    </Link>
                    <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>
                        Período {formatPeriodLabel(period)}
                    </h1>
                </div>
                <PeriodActions
                    clientId={id}
                    periodId={period.id}
                    periodLabel={formatPeriodLabel(period)}
                    canDelete={canDelete}
                    hasMovements={hasMovements}
                />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "var(--spacing-lg)", marginBottom: "var(--spacing-xl)" }}>
                {/* Sales Card */}
                <div className="card">
                    <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)", color: "var(--success)" }}>Ventas</h3>
                    <div style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                        ${formatMoney(totalSales.toFixed(2))}
                    </div>
                    <div style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>
                        IVA Débito: ${formatMoney(totalSalesVAT.toFixed(2))}
                    </div>
                    <Link href={`/client/${id}/period/${periodId}/sales`} className="btn btn-secondary" style={{ width: "100%" }}>
                        Gestionar Ventas
                    </Link>
                </div>

                {/* Purchases Card */}
                <div className="card">
                    <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)", color: "var(--error)" }}>Compras</h3>
                    <div style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                        ${formatMoney(totalPurchases.toFixed(2))}
                    </div>
                    <div style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>
                        IVA Crédito: ${formatMoney(totalPurchasesVAT.toFixed(2))}
                    </div>
                    <Link href={`/client/${id}/period/${periodId}/purchases`} className="btn btn-secondary" style={{ width: "100%" }}>
                        Gestionar Compras
                    </Link>
                </div>

                {/* Tax Position Card */}
                <div className="card glass-panel" style={{ borderColor: vatPosition.greaterThan(0) ? "var(--error)" : "var(--success)" }}>
                    <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)" }}>Posición IVA</h3>
                    <div style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)", color: vatPosition.greaterThan(0) ? "var(--error)" : "var(--success)" }}>
                        ${formatMoney(vatPosition.abs().toFixed(2))}
                    </div>
                    <div style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>
                        {vatPosition.greaterThan(0) ? "A Pagar" : "A Favor"}
                    </div>
                    <Link href={`/client/${id}/period/${periodId}/liquidation`} className="btn btn-primary" style={{ width: "100%" }}>
                        Ver Liquidación Completa
                    </Link>
                </div>
            </div>

            <div className="card">
                <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)" }}>Retenciones y Percepciones</h3>
                <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-md)" }}>Gestiona las retenciones y percepciones sufridas en el período.</p>
                <Link href={`/client/${id}/period/${periodId}/taxes`} className="btn btn-secondary">
                    Gestionar Retenciones/Percepciones
                </Link>
            </div>
        </div>
    );
}
