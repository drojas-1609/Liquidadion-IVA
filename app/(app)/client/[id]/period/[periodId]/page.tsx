import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_DELETE, ROLES_UPDATE, ROLES_PERIOD_CLOSE, ROLES_PERIOD_REOPEN, roleAllows } from "@/lib/auth/roles";
import { formatPeriodLabel } from "@/lib/period";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { computeLiquidation, type LiquidationResult } from "@/lib/liquidation-calc";
import { MissingGlobalProrationCoefficientError } from "@/lib/invoice-model";
import { formatMoney } from "@/lib/format";
import { isPeriodClosed, periodStatusLabel, PERIOD_CLOSE_IIBB_NOTICE, PERIOD_CLOSE_SCOPE_NOTICE } from "@/lib/period-status";
import { PeriodActions } from "./period-actions";
import { PeriodStatusActions } from "./period-status-actions";
import { TurivaSetting } from "./turiva-setting";

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
    // Período cerrado: consulta y exportación; ninguna acción de modificación o
    // baja (la API las rechaza igual con 409 PERIOD_CLOSED).
    const closed = isPeriodClosed(period.status);
    const canDelete = roleAllows(ROLES_DELETE, role) && !closed;
    const hasMovements = period.invoices.length > 0 || period.taxRecords.length > 0;

    // Inclusión en el Régimen TurIVA: sin PeriodVatSettings -> false. Al cliente
    // sólo llegan dos booleanos (nada de organización, rol ni configuración).
    // key: tras router.refresh() con otro valor del servidor, se reinicia el estado.
    const turivaIncluded = period.vatSettings?.turivaIncluded === true;
    const turivaCard = (
        <TurivaSetting
            key={String(turivaIncluded)}
            periodId={period.id}
            turivaIncluded={turivaIncluded}
            canEdit={roleAllows(ROLES_UPDATE, role) && !closed}
        />
    );

    // Estado del período: etiqueta, cerrar / reabrir según rol y aviso de alcance.
    // Cerrar NO depende de que la liquidación sea calculable: también se ofrece
    // cuando falta el coeficiente de prorrateo global.
    const statusActions = (
        <PeriodStatusActions
            periodId={period.id}
            periodLabel={formatPeriodLabel(period)}
            closed={closed}
            updatedAt={period.updatedAt.toISOString()}
            canClose={roleAllows(ROLES_PERIOD_CLOSE, role)}
            canReopen={roleAllows(ROLES_PERIOD_REOPEN, role)}
        />
    );
    const statusHeader = (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--spacing-sm)" }}>
            {statusActions}
            <PeriodActions
                clientId={id}
                periodId={period.id}
                periodLabel={formatPeriodLabel(period)}
                canDelete={canDelete}
                hasMovements={hasMovements}
            />
        </div>
    );
    const statusBadge = (
        <span
            data-period-status={period.status}
            style={{ fontSize: "0.875rem", padding: "2px 8px", borderRadius: "var(--radius-sm)", border: "1px solid var(--secondary)", marginLeft: "var(--spacing-sm)", verticalAlign: "middle" }}
        >
            {periodStatusLabel(period.status)}
        </span>
    );
    const closedNotice = closed ? (
        <div role="status" className="card" style={{ marginBottom: "var(--spacing-xl)" }}>
            <h3 style={{ fontSize: "1.125rem", marginBottom: "var(--spacing-sm)" }}>Período cerrado</h3>
            <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-sm)" }}>{PERIOD_CLOSE_SCOPE_NOTICE}</p>
            <p style={{ color: "var(--secondary)" }}>{PERIOD_CLOSE_IIBB_NOTICE}</p>
        </div>
    ) : null;
    const manageText = closed ? "Ver" : "Gestionar";

    // Totales vía la única fuente de cálculo (lib/liquidation-calc).
    // Falla cerrada: con líneas sujetas a prorrateo global y sin coeficiente no
    // se muestra una liquidación parcial (sí la configuración TurIVA, que no
    // depende de la liquidación).
    let r: LiquidationResult;
    try {
        r = computeLiquidation(period);
    } catch (err) {
        if (!(err instanceof MissingGlobalProrationCoefficientError)) throw err;
        return (
            <div className="container">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--spacing-md)", flexWrap: "wrap", marginBottom: "var(--spacing-xl)" }}>
                    <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>
                        Período {formatPeriodLabel(period)}
                        {statusBadge}
                    </h1>
                    {statusActions}
                </div>
                {closedNotice}
                <div role="alert" className="card" style={{ color: "var(--error)" }}>
                    {err.message}
                </div>
                {turivaCard}
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
                        {statusBadge}
                    </h1>
                </div>
                {statusHeader}
            </div>

            {closedNotice}

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
                        {manageText} Ventas
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
                        {manageText} Compras
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
                    {manageText} Retenciones/Percepciones
                </Link>
            </div>

            {turivaCard}
        </div>
    );
}
