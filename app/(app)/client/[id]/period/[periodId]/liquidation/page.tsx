import Link from "next/link";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE, roleAllows } from "@/lib/auth/roles";
import { VAT_CREDIT_ADJUSTMENT_LABELS, VAT_CREDIT_ADJUSTMENT_REGIMES } from "@/lib/vat-position-input";
import { VatPositionForm } from "./vat-position-form";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { computeLiquidation, type LiquidationResult } from "@/lib/liquidation-calc";
import { loadPeriodLiquidationInput } from "@/lib/liquidation-totals";
import { MissingGlobalProrationCoefficientError } from "@/lib/invoice-model";
import { formatMoney } from "@/lib/format";
import { LIQUIDATION_RATE_NOTE } from "@/lib/legacy-iibb-rate";

export const dynamic = "force-dynamic";

const m = (d: Prisma.Decimal) => formatMoney(d.toFixed(2));
const clampPos = (d: Prisma.Decimal) => (d.isNegative() ? new Prisma.Decimal(0) : d);

export default async function LiquidationPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requirePeriodAccess(profileId, periodId, ROLES_READ, {
            expectClientId: id,
        });
        // Totales del período COMPLETO agregados en la base (lib/liquidation-totals).
        const found = await prisma.period.findFirst({
            where: { id: periodId, organizationId },
            include: {
                client: { select: { name: true } },
                vatSettings: { select: { previousTechnicalBalance: true, previousTechnicalBalanceReference: true } },
                vatCreditAdjustments: { select: { regime: true, contributionsAmount: true, computableAmount: true, reference: true } },
            },
        });
        if (!found) throw new NotFoundError();
        const liquidation = await loadPeriodLiquidationInput(prisma, { organizationId, periodId: found.id });
        if (!liquidation) throw new NotFoundError();
        return { ...found, liquidation, role };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const period = guard.data;

    // Falla cerrada: con líneas sujetas a prorrateo global y sin coeficiente no
    // se muestra una liquidación parcial.
    let r: LiquidationResult;
    try {
        r = computeLiquidation(period.liquidation);
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

                {[
                    ["Total del débito fiscal del período", r.iva.debit],
                    ["Crédito fiscal por compras", r.iva.creditPurchases],
                    ...(r.iva.creditSocialSecurityAnnexI.isZero() ? [] : [[VAT_CREDIT_ADJUSTMENT_LABELS.LEY_27541_ANEXO_I, r.iva.creditSocialSecurityAnnexI] as const]),
                    ...(r.iva.creditSocialSecurityArt91Declared.isZero() ? [] : [[VAT_CREDIT_ADJUSTMENT_LABELS.LEY_27467_ART_91, r.iva.creditSocialSecurityArt91] as const]),
                    ["Total del crédito fiscal del período", r.iva.credit],
                    ["Saldo técnico a favor del contribuyente del período anterior", r.iva.previousTechnicalBalance],
                ].map(([label, value]) => (
                    <div key={label as string} style={{ display: "flex", justifyContent: "space-between", gap: "var(--spacing-md)", marginBottom: "var(--spacing-sm)" }}>
                        <span>{label as string}</span>
                        <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>${m(value as Prisma.Decimal)}</span>
                    </div>
                ))}
                {r.iva.creditSocialSecurityArt91.lessThan(r.iva.creditSocialSecurityArt91Declared) && (
                    <p role="note" style={{ color: "var(--secondary)", fontSize: "0.8125rem", marginBottom: "var(--spacing-sm)" }}>
                        Art. 91 Ley 27.467: se computan ${m(r.iva.creditSocialSecurityArt91)} de ${m(r.iva.creditSocialSecurityArt91Declared)} cargados (tope: débito fiscal del período).
                    </p>
                )}

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)", padding: "var(--spacing-sm) 0", borderTop: "1px dashed var(--border)", borderBottom: "1px dashed var(--border)" }}>
                    <span style={{ fontWeight: 600 }}>{r.iva.technicalBalanceInFavor.isZero() ? "Saldo técnico a favor de ARCA" : "Saldo técnico a favor del contribuyente"}</span>
                    <span style={{ fontWeight: 600, color: r.iva.technicalBalanceInFavor.isZero() && !r.iva.technicalBalanceArca.isZero() ? "var(--error)" : "var(--success)" }}>
                        ${m(r.iva.technicalBalanceInFavor.isZero() ? r.iva.technicalBalanceArca : r.iva.technicalBalanceInFavor)}
                    </span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Retenciones / Percepciones IVA</span>
                    <span style={{ fontWeight: 500 }}>- ${m(r.iva.retentions)}</span>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", marginTop: "var(--spacing-lg)", padding: "var(--spacing-md)", backgroundColor: "var(--surface-hover)", borderRadius: "var(--radius-md)" }}>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold" }}>Saldo de impuesto a favor de ARCA</span>
                    <span style={{ fontSize: "1.25rem", fontWeight: "bold", color: r.iva.payable.greaterThan(0) ? "var(--error)" : "var(--success)" }}>
                        ${m(clampPos(r.iva.payable))}
                    </span>
                </div>
                {r.iva.payable.isNegative() && (
                    <div style={{ textAlign: "right", marginTop: "var(--spacing-xs)", color: "var(--success)", fontSize: "0.875rem" }}>
                        Saldo a favor de libre disponibilidad: ${m(r.iva.payable.abs())}
                    </div>
                )}
                {!r.iva.technicalBalanceInFavor.isZero() && (
                    <div style={{ textAlign: "right", marginTop: "var(--spacing-xs)", color: "var(--secondary)", fontSize: "0.875rem" }}>
                        El saldo técnico a favor (${m(r.iva.technicalBalanceInFavor)}) se traslada al período siguiente.
                    </div>
                )}
            </div>

            <VatPositionForm
                periodId={periodId}
                canEdit={roleAllows(ROLES_UPDATE, period.role) && period.status === "OPEN"}
                previousTechnicalBalance={period.vatSettings?.previousTechnicalBalance.toFixed(2) ?? "0.00"}
                previousTechnicalBalanceReference={period.vatSettings?.previousTechnicalBalanceReference ?? ""}
                rows={VAT_CREDIT_ADJUSTMENT_REGIMES.map((regime) => {
                    const a = (period.vatCreditAdjustments ?? []).find((x) => x.regime === regime);
                    return {
                        regime,
                        label: VAT_CREDIT_ADJUSTMENT_LABELS[regime],
                        contributionsAmount: a ? a.contributionsAmount.toFixed(2) : "",
                        computableAmount: a ? a.computableAmount.toFixed(2) : "",
                        reference: a?.reference ?? "",
                    };
                })}
            />

            {/* IIBB Section */}
            <div className="card">
                <h2 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-md)", borderBottom: "1px solid var(--border)", paddingBottom: "var(--spacing-sm)" }}>
                    Ingresos Brutos (IIBB)
                </h2>

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-sm)" }}>
                    <span>Base Imponible IIBB</span>
                    <span style={{ fontWeight: 500 }}>${m(r.iibb.base)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "var(--spacing-md)" }}>
                    <span>Impuesto Determinado ({r.iibb.rate.toString()}%)</span>
                    <span style={{ fontWeight: 500 }}>${m(r.iibb.tax)}</span>
                </div>
                <p style={{ color: "var(--secondary)", fontSize: "0.8125rem", marginTop: "calc(-1 * var(--spacing-sm))", marginBottom: "var(--spacing-md)" }}>
                    {LIQUIDATION_RATE_NOTE}
                </p>

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
