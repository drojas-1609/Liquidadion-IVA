import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE, roleAllows } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { loadReadiness } from "@/lib/vat-export/service";
import { effectiveBuyerType } from "@/lib/vat-export/classification";
import { ISSUE_HELP, LEVEL_LABEL } from "@/lib/vat-export/issue-help";
import { voucherDisplayLabel } from "@/lib/invoice-model";
import { formatIsoDate, formatMoney } from "@/lib/format";
import { ClassificationBatch, type ClassificationRow } from "./classification-batch";

export const dynamic = "force-dynamic";

/** Filas de la clasificación por lote que se envían a la pantalla (el resto se resume). */
const MAX_ROWS = 2000;

export default async function PresentationPage({ params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { id, periodId } = await params;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requirePeriodAccess(profileId, periodId, ROLES_READ, { expectClientId: id });
        const loaded = await loadReadiness(prisma, { organizationId, periodId });
        if (!loaded) throw new NotFoundError();
        const [versions, activities] = await Promise.all([
            prisma.periodLiquidationVersion.findMany({
                where: { periodId, organizationId },
                orderBy: { version: "desc" },
                select: {
                    version: true, closedAt: true, engineVersion: true, packageSha256: true, supersededAt: true, reopenReason: true, summary: true,
                    closedBy: { select: { email: true } }, supersededBy: { select: { email: true } },
                },
            }),
            prisma.clientActivity.findMany({
                where: { clientId: id, organizationId, nomenclator: "ARCA" },
                select: { code: true, description: true },
                orderBy: { code: "asc" },
            }),
        ]);
        return { ...loaded, versions, activities, role };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { data, readiness, versions, activities, role } = guard.data;
    const open = data.period.status === "OPEN";
    const current = versions.find((v) => v.supersededAt === null) ?? null;
    const canEdit = open && roleAllows(ROLES_UPDATE, role);
    const per = `${String(data.period.month).padStart(2, "0")}/${data.period.year}`;

    const missingByInvoice = new Map<string, string[]>();
    for (const i of readiness.issues) {
        if (!i.invoiceId || (i.level !== "EXPORT" && i.code !== "INVOICE_PERCEPTIONS_NOT_REGISTERED")) continue;
        missingByInvoice.set(i.invoiceId, [...(missingByInvoice.get(i.invoiceId) ?? []), ISSUE_HELP[i.code].title]);
    }
    const pending = data.invoices.filter((i) => missingByInvoice.has(i.id) && i.voucherCode !== null);
    const rows: ClassificationRow[] = pending.slice(0, MAX_ROWS).map((i) => ({
        id: i.id,
        category: i.category === "SALES" ? "SALES" : "PURCHASES",
        label: `${formatIsoDate(i.voucherDate)} · ${voucherDisplayLabel(i.voucherCode!)} ${String(i.pointOfSale).padStart(5, "0")}-${String(i.number).padStart(8, "0")}`,
        counterparty: i.counterpartyName ?? "",
        total: formatMoney((i.voucherTotalAmount ?? 0).toString()),
        missing: missingByInvoice.get(i.id) ?? [],
        activityCode: i.activityCode,
        saleOperationType: i.saleOperationType,
        buyerType: i.buyerType ?? null,
        derivedBuyerType: i.buyerType ? null : effectiveBuyerType(i),
        purchaseCreditConcept: i.purchaseCreditConcept,
        operationCode: i.operationCode,
        dationInPayment: i.dationInPayment,
    }));

    const liq = readiness.liquidation;
    const box: React.CSSProperties = { marginBottom: "var(--spacing-xl)" };
    const h2: React.CSSProperties = { fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-md)" };
    const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: "var(--spacing-md)", marginBottom: "var(--spacing-xs)" };

    return (
        <div className="container" style={{ maxWidth: "1100px" }}>
            <div style={{ marginBottom: "var(--spacing-xl)" }}>
                <Link href={`/client/${id}/period/${periodId}`} style={{ color: "var(--secondary)", fontSize: "0.875rem" }}>&larr; Volver al período</Link>
                <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>Presentación ARCA — IVA</h1>
                <p style={{ color: "var(--secondary)" }}>
                    {data.client.name} · CUIT {data.client.cuit} · Período {per} · {open ? "Abierto (borrador)" : current ? `Cerrado — versión ${current.version}` : "Cerrado"}
                </p>
                <p style={{ color: "var(--secondary)", fontSize: "0.875rem" }}>
                    La aplicación genera los archivos y el resumen; no sube archivos ni presenta declaraciones en ARCA.
                </p>
            </div>

            <section className="card" style={box} aria-labelledby="dl">
                <h2 id="dl" style={h2}>Paquete de presentación</h2>
                {open ? (
                    <>
                        <p style={{ marginBottom: "var(--spacing-sm)" }}>
                            Período abierto: el paquete es un <strong>BORRADOR</strong> (puede cambiar). La versión final se genera al cerrar el período{readiness.blocked ? ", y sólo si no quedan bloqueos" : ""}.
                        </p>
                        {liq ? (
                            <a className="btn btn-secondary" href={`/api/periods/${periodId}/vat-package?mode=draft`}>Descargar borrador (ZIP)</a>
                        ) : (
                            <p role="alert" style={{ color: "var(--error)" }}>{readiness.liquidationError}</p>
                        )}
                    </>
                ) : current?.packageSha256 ? (
                    <>
                        <p style={{ marginBottom: "var(--spacing-sm)" }}>
                            Versión {current.version} cerrada el {current.closedAt.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}. Se descarga tal como se generó al cerrar (huella {current.packageSha256.slice(0, 12)}…).
                        </p>
                        <a className="btn btn-primary" href={`/api/periods/${periodId}/vat-package?mode=final`}>Descargar versión final (ZIP)</a>
                    </>
                ) : (
                    <p role="alert" style={{ color: "var(--error)" }}>
                        {current
                            ? "La versión cerrada no tiene paquete: al cerrar había bloqueos de exportación. Reabrí el período, resolvelos y volvé a cerrar."
                            : "El período se cerró antes de que existieran las versiones de liquidación: reabrilo y volvé a cerrarlo para generar el paquete."}
                    </p>
                )}
            </section>

            {liq && (
                <section className="card" style={box} aria-labelledby="det">
                    <h2 id="det" style={h2}>Determinación (mismo motor que la liquidación y el Excel)</h2>
                    {[
                        ["Total del débito fiscal", liq.iva.debit],
                        ["Total del crédito fiscal", liq.iva.credit],
                        ["Saldo técnico a favor del contribuyente del período anterior", liq.iva.previousTechnicalBalance],
                        ["Saldo técnico a favor de ARCA", liq.iva.technicalBalanceArca],
                        ["Saldo técnico a favor del contribuyente", liq.iva.technicalBalanceInFavor],
                        ["Libre disponibilidad del período anterior", liq.iva.previousFreeBalance],
                        ["Retenciones · percepciones · aduaneras", `${formatMoney(liq.iva.withholdings)} · ${formatMoney(liq.iva.perceptions)} · ${formatMoney(liq.iva.customsPerceptions)}`],
                        ["Saldo de impuesto a favor de ARCA", liq.iva.balanceToPay],
                        ["Saldo de libre disponibilidad a favor del contribuyente", liq.iva.freeBalanceInFavor],
                    ].map(([label, v]) => (
                        <div key={label} style={row}>
                            <span>{label}</span>
                            <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{String(v).includes("·") ? v : `$${formatMoney(v)}`}</span>
                        </div>
                    ))}
                </section>
            )}

            <section className="card" style={box} aria-labelledby="ctl">
                <h2 id="ctl" style={h2}>Controles</h2>
                <p style={{ marginBottom: "var(--spacing-sm)" }}>
                    Impiden liquidar: {readiness.counts.LIQUIDATION} · Impiden exportar: {readiness.counts.EXPORT} · Advertencias: {readiness.counts.WARNING} · Información: {readiness.counts.INFO}
                </p>
                <p style={{ color: "var(--secondary)", fontSize: "0.8125rem", marginBottom: "var(--spacing-md)" }}>
                    Los errores que impiden importar y las filas pendientes de revisión de un archivo se resuelven en la vista previa de la importación: no llegan al período.
                </p>
                {readiness.byCode.length === 0 ? (
                    <p role="status" style={{ color: "var(--success)" }}>Sin observaciones: el período está listo para exportar.</p>
                ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                            <tr><th style={{ textAlign: "left" }}>Nivel</th><th style={{ textAlign: "left" }}>Control</th><th style={{ textAlign: "right" }}>Casos</th><th style={{ textAlign: "left" }}>Cómo resolverlo</th></tr>
                        </thead>
                        <tbody>
                            {readiness.byCode.map((b) => (
                                <tr key={`${b.level}-${b.code}`} style={{ borderTop: "1px solid var(--border)" }}>
                                    <td style={{ padding: "var(--spacing-xs)", color: b.level === "EXPORT" || b.level === "LIQUIDATION" ? "var(--error)" : "var(--secondary)", whiteSpace: "nowrap" }}>{LEVEL_LABEL[b.level]}</td>
                                    <td style={{ padding: "var(--spacing-xs)" }}>{ISSUE_HELP[b.code].title}<div style={{ color: "var(--secondary)", fontSize: "0.8125rem" }}>{b.example}</div></td>
                                    <td style={{ padding: "var(--spacing-xs)", textAlign: "right" }}>{b.count}</td>
                                    <td style={{ padding: "var(--spacing-xs)", fontSize: "0.875rem" }}>{ISSUE_HELP[b.code].fix}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                <p style={{ marginTop: "var(--spacing-sm)", fontSize: "0.875rem" }}>
                    Retenciones y percepciones: <Link href={`/client/${id}/period/${periodId}/taxes`}>cargar o completar el detalle del F.2051</Link>.
                </p>
            </section>

            <section className="card" style={box} aria-labelledby="cls">
                <h2 id="cls" style={h2}>Clasificación de comprobantes pendientes</h2>
                {pending.length === 0 ? (
                    <p role="status" style={{ color: "var(--success)" }}>No hay comprobantes pendientes de clasificar.</p>
                ) : (
                    <>
                        {pending.length > MAX_ROWS && (
                            <p role="note" style={{ marginBottom: "var(--spacing-sm)" }}>Se muestran los primeros {MAX_ROWS} de {pending.length} pendientes; al aplicar, la pantalla se actualiza con los siguientes.</p>
                        )}
                        <ClassificationBatch periodId={periodId} canEdit={canEdit} rows={rows} activities={activities} />
                    </>
                )}
            </section>

            <section className="card" style={box} aria-labelledby="hist">
                <h2 id="hist" style={h2}>Historial de liquidaciones cerradas</h2>
                {versions.length === 0 ? (
                    <p>El período todavía no se cerró con el registro de versiones.</p>
                ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                            <tr><th style={{ textAlign: "left" }}>Versión</th><th style={{ textAlign: "left" }}>Cierre</th><th style={{ textAlign: "left" }}>Paquete</th><th style={{ textAlign: "left" }}>Estado</th></tr>
                        </thead>
                        <tbody>
                            {versions.map((v) => {
                                const s = v.summary as { liquidation?: { iva?: { balanceToPay?: string; freeBalanceInFavor?: string; technicalBalanceInFavor?: string } } } | null;
                                return (
                                    <tr key={v.version} style={{ borderTop: "1px solid var(--border)" }}>
                                        <td style={{ padding: "var(--spacing-xs)" }}>v{v.version}</td>
                                        <td style={{ padding: "var(--spacing-xs)", fontSize: "0.875rem" }}>
                                            {v.closedAt.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })} · {v.closedBy?.email ?? "—"} · motor {v.engineVersion}
                                            {s?.liquidation?.iva && <div style={{ color: "var(--secondary)" }}>A pagar ${formatMoney(s.liquidation.iva.balanceToPay ?? "0")} · saldo técnico a favor ${formatMoney(s.liquidation.iva.technicalBalanceInFavor ?? "0")} · libre disponibilidad ${formatMoney(s.liquidation.iva.freeBalanceInFavor ?? "0")}</div>}
                                        </td>
                                        <td style={{ padding: "var(--spacing-xs)", fontSize: "0.875rem" }}>{v.packageSha256 ? `sha256 ${v.packageSha256.slice(0, 12)}…` : "sin paquete (bloqueos)"}</td>
                                        <td style={{ padding: "var(--spacing-xs)", fontSize: "0.875rem" }}>
                                            {v.supersededAt ? (
                                                <>Reemplazada el {v.supersededAt.toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })} por {v.supersededBy?.email ?? "—"}: {v.reopenReason}</>
                                            ) : "Vigente"}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
}
