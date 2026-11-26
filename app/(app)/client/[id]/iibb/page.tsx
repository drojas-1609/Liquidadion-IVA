import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_CLIENT_MANAGE, ROLES_READ, ROLES_UPDATE, roleAllows } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { localIibbJurisdiction, salesIibbBaseForYear } from "@/lib/liquidation-totals";
import { currentFiscalYear } from "@/lib/iibb/rate-years";
import { formatMoney } from "@/lib/format";
import { IibbActivityForm } from "./iibb-activity-form";
import { GrossIncomeForm } from "./gross-income-form";
import { AnnualReview, type ReviewRowView } from "./annual-review";
import { loadAnnualReview } from "@/lib/iibb/annual-review-store";
import { canApplyRule, canKeep } from "@/lib/iibb/annual-review";

export const dynamic = "force-dynamic";

// Configuración de IIBB por actividad del cliente: actividad principal (por
// defecto para todas las ventas) y puntos de venta asignados a una actividad.
export default async function IibbActivitiesPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requireClientAccess(profileId, id, ROLES_READ, { module: MODULES_CLIENT_DIRECTORY });
        const client = await prisma.client.findFirst({
            where: { id, organizationId },
            select: {
                id: true, name: true, iibbRegistration: true, iibbPrincipalActivityCode: true,
                jurisdictions: { select: { jurisdictionCode: true } },
                activities: { select: { code: true, description: true, rates: { select: { jurisdictionCode: true, rate: true, treatment: true, minimumAmount: true, additionalLabel: true, additionalRate: true } } }, orderBy: { code: "asc" } },
                posActivities: { select: { pointOfSale: true, activityCode: true }, orderBy: { pointOfSale: "asc" } },
                iibbProviders: { select: { cuit: true, name: true, activityCode: true }, orderBy: { name: "asc" } },
            },
        });
        if (!client) throw new NotFoundError();
        const thisYear = currentFiscalYear();
        const incomeYears = [thisYear - 1, thisYear - 2];
        const [incomes, rateYears, references] = await Promise.all([
            prisma.clientGrossIncomeYear.findMany({ where: { organizationId, clientId: id }, select: { incomeYear: true, amount: true, note: true, updatedAt: true }, orderBy: { incomeYear: "desc" } }),
            prisma.clientIibbRateYear.findMany({
                where: { organizationId, clientId: id },
                select: { fiscalYear: true, jurisdictionCode: true, activityCode: true, rate: true, treatment: true, minimumAmount: true, additionalLabel: true, additionalRate: true, confirmedAt: true },
                orderBy: [{ fiscalYear: "desc" }, { jurisdictionCode: "asc" }, { activityCode: "asc" }],
            }),
            Promise.all(incomeYears.map((y) => salesIibbBaseForYear(prisma, { organizationId, clientId: id, year: y }).then((r) => ({ year: y, ...r })))),
        ]);
        const review = await loadAnnualReview(prisma, { organizationId, clientId: id });
        const seen = await prisma.invoice.groupBy({ by: ["pointOfSale"], where: { organizationId, category: "SALES", period: { clientId: id } }, _count: { _all: true } });
        // Proveedores con compras del año en curso (para marcar prestadores con un clic).
        const supplierRows = await prisma.invoice.groupBy({
            by: ["counterpartyDocNumber", "counterpartyName"],
            where: { organizationId, category: "PURCHASES", period: { clientId: id, year: thisYear }, counterpartyDocNumber: { not: null } },
            _count: { _all: true },
            orderBy: { _count: { counterpartyDocNumber: "desc" } },
            take: 60,
        });
        const suppliers = [...new Map(supplierRows.filter((r) => r.counterpartyDocNumber && /^\d{11}$/.test(r.counterpartyDocNumber)).map((r) => [r.counterpartyDocNumber as string, { cuit: r.counterpartyDocNumber as string, name: r.counterpartyName ?? "" }])).values()];
        return { client, suppliers, seenPos: seen.map((s) => s.pointOfSale).sort((a, b) => a - b), canEdit: roleAllows(ROLES_UPDATE, role), canReview: roleAllows(ROLES_CLIENT_MANAGE, role), review, thisYear, incomeYears, incomes, rateYears, references };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, suppliers, seenPos, canEdit, canReview, review, thisYear, incomeYears, incomes, rateYears, references } = guard.data;
    const years = [...new Set(rateYears.map((r) => r.fiscalYear))];
    const descByCode = new Map(client.activities.map((a) => [a.code, a.description]));
    const pctLabel = (r: { rate: { toFixed: (n: number) => string } | null; treatment: string }) =>
        r.treatment === "EXEMPT" ? "exenta" : r.rate == null ? "sin informar" : `${r.rate.toFixed(2).replace(".", ",")} %`;
    const fmtRate = (v: { rate: string | null; treatment: string; minimum: string | null; additional?: { label: string; rate: string } | null } | null) => {
        if (!v) return "—";
        const base = v.treatment === "EXEMPT" ? "exenta" : v.rate == null ? "sin informar" : `${Number(v.rate).toFixed(2).replace(".", ",")} %`;
        const withMin = v.minimum ? `${base} · mín. $ ${formatMoney(Number(v.minimum).toFixed(2))}` : base;
        return v.additional ? `${withMin} + ${v.additional.label} ${Number(v.additional.rate).toFixed(2).replace(".", ",")} %` : withMin;
    };
    const reviewRows: ReviewRowView[] = (review?.rows ?? []).map((r) => ({
        rateId: r.rateId,
        jurisdictionCode: r.jurisdictionCode,
        activity: `${r.activityCode} · ${r.description}`,
        prior: fmtRate(r.prior),
        current: fmtRate(r),
        suggestion: r.suggestion ? fmtRate({ rate: r.suggestion.rate, treatment: r.suggestion.treatment, minimum: r.suggestion.minimumMonthly ?? null, additional: r.suggestion.additional ?? null }) : null,
        norm: r.suggestion ? `${r.suggestion.norm} — ${r.suggestion.legalReference}` : null,
        ruleRef: r.suggestion?.ruleRef ?? null,
        status: r.status,
        message: r.message,
        yearConfirmedAt: r.yearConfirmedAt ? r.yearConfirmedAt.split("-").reverse().join("/") : null,
        canApply: canApplyRule(r),
        canKeep: canKeep(r),
    }));
    const jur = localIibbJurisdiction(client);
    const activities = client.activities.map((a) => {
        const r = jur ? a.rates.find((x) => x.jurisdictionCode === jur) : undefined;
        const rate = !r ? "sin informar" : fmtRate({ rate: r.rate?.toString() ?? null, treatment: r.treatment, minimum: r.minimumAmount?.toString() ?? null, additional: r.additionalLabel && r.additionalRate != null ? { label: r.additionalLabel, rate: r.additionalRate.toString() } : null });
        return { code: a.code, label: `${a.code} · ${a.description}`, rate };
    });

    return (
        <div className="container stack-lg">
            <header className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <p className="eyebrow"><Link href={`/client/${id}/dashboard`}>← Volver al cliente</Link></p>
                    <h1>Alícuotas e ingresos anuales de IIBB · {client.name}</h1>
                    <p className="subtitle">
                        Cada venta se liquida con la alícuota de su actividad: primero la corrección manual del comprobante (desde la liquidación de cada período), luego la actividad del punto de venta y, si no hay, la actividad principal.
                        {jur ? ` Jurisdicción local: ${jur}.` : ""}
                    </p>
                </div>
            </header>
            {!jur && (
                <p role="alert">
                    El cálculo por actividad aplica, por ahora, a clientes inscriptos como <strong>local</strong> en una sola jurisdicción. Para Convenio Multilateral la liquidación sigue con la alícuota de la ficha hasta la fase de coeficientes (CM05).
                </p>
            )}
            {activities.length === 0 ? (
                <p role="alert">El cliente no tiene actividades cargadas. Cargalas en <Link href={`/client/${id}/edit`}>Datos del cliente</Link> (o desde la constancia de inscripción).</p>
            ) : (
                <section className="card" aria-labelledby="act-title">
                    <h2 id="act-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Actividades y alícuotas{jur ? ` en ${jur}` : ""}</h2>
                    <table className="table" style={{ width: "100%" }}>
                        <thead><tr><th>Actividad</th><th style={{ textAlign: "right" }}>Alícuota</th></tr></thead>
                        <tbody>{activities.map((a) => <tr key={a.code}><td>{a.label}{a.code === client.iibbPrincipalActivityCode ? " (principal)" : ""}</td><td style={{ textAlign: "right" }}>{a.rate}</td></tr>)}</tbody>
                    </table>
                    <p style={{ color: "var(--secondary)", fontSize: "0.8125rem", marginTop: "var(--spacing-sm)" }}>Las alícuotas se editan en <Link href={`/client/${id}/edit`}>Datos del cliente</Link>. Una actividad «sin informar» se liquida con la alícuota de respaldo de la ficha y queda advertida en la liquidación.</p>
                </section>
            )}
            {activities.length > 0 && (
                canEdit ? (
                    <IibbActivityForm
                        clientId={id}
                        activities={activities.map((a) => ({ code: a.code, label: a.label }))}
                        principalCode={client.iibbPrincipalActivityCode}
                        pos={client.posActivities}
                        seenPos={seenPos}
                        providers={client.iibbProviders}
                        suppliers={suppliers}
                    />
                ) : (
                    <p>Actividad principal: <strong>{client.iibbPrincipalActivityCode ?? "sin definir"}</strong>. Puntos de venta asignados: {client.posActivities.length === 0 ? "ninguno" : client.posActivities.map((p) => `${p.pointOfSale} → ${p.activityCode}`).join(", ")}. Prestadores (base por diferencia): {client.iibbProviders.length === 0 ? "ninguno" : client.iibbProviders.map((p) => `${p.name} → ${p.activityCode}`).join(", ")}.</p>
                )
            )}
            <section className="card" aria-labelledby="income-title">
                <h2 id="income-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-xs)" }}>Ingresos brutos anuales (para los tramos)</h2>
                <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                    Total de ingresos del año por todas las actividades y jurisdicciones, según lo pida cada norma. Los de {thisYear - 1} definen el tramo de las alícuotas de {thisYear}. La referencia es lo que la app tiene registrado y puede estar incompleta.
                </p>
                <GrossIncomeForm
                    clientId={client.id}
                    canEdit={canEdit}
                    rows={incomeYears.map((y) => {
                        const saved = incomes.find((i) => i.incomeYear === y);
                        const ref = references.find((r) => r.year === y)!;
                        return {
                            year: y,
                            amount: saved ? saved.amount.toFixed(2).replace(".", ",") : "",
                            note: saved?.note ?? "",
                            reference: ref.periods > 0 ? `$ ${formatMoney(ref.base.toFixed(2))} en ${ref.periods} período(s) cargado(s)` : "sin períodos cargados en la app",
                        };
                    })}
                />
            </section>
            {review && (
                <section className="card" aria-labelledby="review-title">
                    <h2 id="review-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-xs)" }}>Revisión anual de alícuotas {review.year}</h2>
                    <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                        Compara cada alícuota de la ficha con la del año anterior y con la que fija la norma aprobada de {review.year} (con los ingresos de {review.year - 1} para los tramos). «Aplicar norma» actualiza la ficha con la sugerencia de la norma; «Mantener la actual» la deja igual. Las dos la registran para {review.year} con quién y cuándo. Elegir entre alternativas (hechos declarados) o cargar una alícuota sin regla se hace en la ficha.
                    </p>
                    <AnnualReview clientId={client.id} year={review.year} incomeLoaded={review.incomeLoaded} rows={reviewRows} canEdit={canReview} />
                </section>
            )}
            <section className="card" aria-labelledby="years-title">
                <h2 id="years-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-xs)" }}>Alícuotas por año</h2>
                <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-sm)" }}>
                    Cada período se liquida con las alícuotas de su año. Las de {thisYear} se actualizan al guardar la ficha; las de años anteriores quedan fijas.
                </p>
                {years.length === 0 ? <p>Todavía no hay alícuotas confirmadas por año.</p> : years.map((y) => (
                    <div key={y} style={{ marginBottom: "var(--spacing-md)" }}>
                        <h3 style={{ fontSize: "1rem", fontWeight: 600 }}>{y}{y === thisYear ? " (año en curso)" : ""}</h3>
                        <table className="table" style={{ width: "100%" }}>
                            <thead><tr><th>Jurisdicción</th><th>Actividad</th><th style={{ textAlign: "right" }}>Alícuota</th><th>Confirmada</th></tr></thead>
                            <tbody>
                                {rateYears.filter((r) => r.fiscalYear === y).map((r) => (
                                    <tr key={`${r.jurisdictionCode}-${r.activityCode}`}>
                                        <td>{r.jurisdictionCode}</td>
                                        <td>{r.activityCode} · {descByCode.get(r.activityCode) ?? "(ya no está en la ficha)"}</td>
                                        <td style={{ textAlign: "right" }}>
                                            {pctLabel(r)}
                                            {r.minimumAmount != null && <div style={{ color: "var(--secondary)", fontSize: "0.8125rem" }}>mín. $ {formatMoney(r.minimumAmount.toFixed(2))}</div>}
                                            {r.additionalLabel && r.additionalRate != null && <div style={{ color: "var(--secondary)", fontSize: "0.8125rem" }}>+ {r.additionalLabel} {r.additionalRate.toFixed(2).replace(".", ",")} %</div>}
                                        </td>
                                        <td>{r.confirmedAt.toISOString().slice(0, 10).split("-").reverse().join("/")}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ))}
            </section>
        </div>
    );
}
