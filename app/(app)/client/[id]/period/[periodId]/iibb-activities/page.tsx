import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requirePeriodAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { isPeriodClosed } from "@/lib/period-status";
import { formatMoney } from "@/lib/format";
import { localIibbJurisdiction } from "@/lib/liquidation-totals";
import { resolveActivity, type IibbActivityConfig } from "@/lib/iibb/activity-base";
import { ActivityAssignmentTable } from "./assignment-table";

export const dynamic = "force-dynamic";

const PAGE = 200;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const SOURCE = { MANUAL: "corrección manual", POS: "punto de venta", PRINCIPAL: "actividad principal", NONE: "sin actividad" } as const;

// Asignación de las ventas del período a actividades de IIBB, con corrección
// manual por comprobante (la de punto de venta y la principal son automáticas).
export default async function IibbActivitiesPeriodPage({ params, searchParams }: {
    params: Promise<{ id: string; periodId: string }>;
    searchParams?: Promise<{ page?: string | string[]; pv?: string | string[] }>;
}) {
    const { id, periodId } = await params;
    const sp = await searchParams;
    const pageNum = Math.max(1, Number.parseInt(one(sp?.page) ?? "1", 10) || 1);
    const pvRaw = one(sp?.pv);
    const pv = pvRaw && /^\d{1,5}$/.test(pvRaw) ? Number(pvRaw) : null;

    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role, period } = await requirePeriodAccess(profileId, periodId, ROLES_READ, { expectClientId: id });
        const client = await prisma.client.findFirst({
            where: { id, organizationId },
            select: {
                name: true, iibbRegistration: true, iibbPrincipalActivityCode: true,
                jurisdictions: { select: { jurisdictionCode: true } },
                activities: { select: { code: true, description: true }, orderBy: { code: "asc" } },
                posActivities: { select: { pointOfSale: true, activityCode: true } },
            },
        });
        if (!client) throw new NotFoundError();
        const pm = await prisma.period.findFirst({ where: { id: periodId, organizationId }, select: { month: true, year: true } });
        if (!pm) throw new NotFoundError();
        const where = { organizationId, periodId, category: "SALES", ...(pv != null ? { pointOfSale: pv } : {}) };
        const [total, byPos, invoices] = await Promise.all([
            prisma.invoice.count({ where }),
            prisma.invoice.groupBy({ by: ["pointOfSale", "iibbActivityCode"], where: { organizationId, periodId, category: "SALES" }, _count: { _all: true } }),
            prisma.invoice.findMany({
                where,
                select: { id: true, voucherDate: true, date: true, type: true, voucherCode: true, pointOfSale: true, number: true, counterpartyName: true, entityName: true, grossIncomeTaxBaseAmount: true, netAmount: true, iibbActivityCode: true },
                orderBy: [{ pointOfSale: "asc" }, { number: "asc" }],
                skip: (pageNum - 1) * PAGE,
                take: PAGE,
            }),
        ]);
        return { client, total, byPos, invoices, canEdit: ROLES_UPDATE.includes(role) && !isPeriodClosed(period.status), label: `${String(pm.month).padStart(2, "0")}/${pm.year}` };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, total, byPos, invoices, canEdit, label } = guard.data;
    const jur = localIibbJurisdiction(client);
    const cfg: IibbActivityConfig = {
        jurisdictionCode: jur ?? "",
        principalCode: client.iibbPrincipalActivityCode,
        posMap: Object.fromEntries(client.posActivities.map((p) => [p.pointOfSale, p.activityCode])),
        activities: client.activities.map((a) => ({ code: a.code, description: a.description, rate: null, exempt: false })),
    };
    const base = `/client/${id}/period/${periodId}/iibb-activities`;

    // Resumen por punto de venta: actividad resuelta y cantidad de comprobantes.
    const summary = new Map<number, Map<string, number>>();
    for (const g of byPos) {
        const r = resolveActivity({ pointOfSale: g.pointOfSale, manualCode: g.iibbActivityCode }, cfg);
        const k = `${r.code ?? "—"} (${SOURCE[r.source]})`;
        const m = summary.get(g.pointOfSale) ?? new Map<string, number>();
        m.set(k, (m.get(k) ?? 0) + g._count._all);
        summary.set(g.pointOfSale, m);
    }
    const rows = invoices.map((inv) => {
        const r = resolveActivity({ pointOfSale: inv.pointOfSale, manualCode: inv.iibbActivityCode }, cfg);
        const d = inv.voucherDate ?? inv.date;
        return {
            id: inv.id,
            date: d ? d.toISOString().slice(0, 10).split("-").reverse().join("/") : "",
            voucher: `${inv.type ?? inv.voucherCode ?? ""} ${String(inv.pointOfSale).padStart(5, "0")}-${String(inv.number).padStart(8, "0")}`,
            name: inv.counterpartyName ?? inv.entityName ?? "",
            amount: formatMoney((inv.grossIncomeTaxBaseAmount ?? inv.netAmount).toFixed(2)),
            code: r.code,
            source: SOURCE[r.source],
            manual: r.source === "MANUAL",
        };
    });
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const href = (p: number, pvv: number | null = pv) => `${base}?${new URLSearchParams({ ...(p > 1 ? { page: String(p) } : {}), ...(pvv != null ? { pv: String(pvv) } : {}) }).toString()}`;

    return (
        <div className="container stack-lg">
            <header className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <p className="eyebrow"><Link href={`/client/${id}/period/${periodId}/iibb-liquidation`}>← Volver a la liquidación de IIBB</Link></p>
                    <h1>Ventas por actividad de IIBB · {label}</h1>
                    <p className="subtitle">
                        {client.name}. Por defecto cada venta va a la actividad de su punto de venta o, si no tiene, a la principal (<Link href={`/client/${id}/iibb`}>configurar</Link>). Corregí acá sólo los comprobantes que correspondan a otra actividad.
                    </p>
                </div>
            </header>
            {!jur && <p role="alert">El cliente no es local de una sola jurisdicción: esta asignación todavía no cambia la liquidación (Convenio Multilateral llega con la fase de coeficientes).</p>}
            {client.activities.length === 0 && <p role="alert">El cliente no tiene actividades cargadas en su ficha.</p>}
            <section className="card" aria-labelledby="pos-title">
                <h2 id="pos-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Resumen por punto de venta</h2>
                {summary.size === 0 ? <p>El período no tiene ventas.</p> : (
                    <table className="table" style={{ width: "100%" }}>
                        <thead><tr><th>Punto de venta</th><th>Actividad (comprobantes)</th><th /></tr></thead>
                        <tbody>
                            {[...summary.entries()].sort((a, b) => a[0] - b[0]).map(([p, m]) => (
                                <tr key={p}>
                                    <td>{String(p).padStart(5, "0")}</td>
                                    <td>{[...m.entries()].map(([k, n]) => `${k}: ${n}`).join(" · ")}</td>
                                    <td><Link href={href(1, p)}>Ver comprobantes</Link></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </section>
            <section className="card" aria-labelledby="inv-title" style={{ overflowX: "auto" }}>
                <h2 id="inv-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                    Comprobantes{pv != null ? ` del punto de venta ${pv}` : ""} ({total})
                    {pv != null && <> · <Link href={href(1, null)} style={{ fontSize: "0.875rem", fontWeight: "normal" }}>ver todos</Link></>}
                </h2>
                <ActivityAssignmentTable periodId={periodId} rows={rows} activities={client.activities.map((a) => ({ code: a.code, label: `${a.code} · ${a.description}` }))} canEdit={canEdit && client.activities.length > 0} />
                {pages > 1 && (
                    <nav aria-label="Páginas" style={{ display: "flex", gap: "0.75rem", marginTop: "var(--spacing-sm)" }}>
                        {pageNum > 1 && <Link href={href(pageNum - 1)}>← Anterior</Link>}
                        <span>Página {pageNum} de {pages}</span>
                        {pageNum < pages && <Link href={href(pageNum + 1)}>Siguiente →</Link>}
                    </nav>
                )}
            </section>
        </div>
    );
}
