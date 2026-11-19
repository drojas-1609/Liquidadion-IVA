import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE, roleAllows } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney } from "@/lib/format";
import { ANNEX_I_ZONES, annexIZone } from "@/lib/payroll/annex-i";
import { PayrollForms, DeleteSlipButton } from "./payroll-forms";

export const dynamic = "force-dynamic";

const pl = (m: number, y: number) => `${String(m).padStart(2, "0")}/${y}`;
const fmtDate = (d: Date) => d.toISOString().slice(0, 10).split("-").reverse().join("/");

export default async function PayrollPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requireClientAccess(profileId, id, ROLES_READ, { module: MODULES_CLIENT_DIRECTORY });
        const client = await prisma.client.findFirst({
            where: { id, organizationId },
            select: {
                id: true, name: true, payrollZoneCode: true,
                periods: {
                    select: {
                        id: true, month: true, year: true, status: true,
                        f931: { select: { contributionsBase: true, employerContributions: true, creditAmount: true, annexIPercent: true, zoneCode: true, reference: true } },
                        unionSlips: { select: { id: true, union: true, amount: true, paidDate: true, reference: true }, orderBy: { createdAt: "asc" } },
                    },
                    orderBy: [{ year: "desc" }, { month: "desc" }],
                },
                chartAccounts: { where: { imputable: true, active: true, code: { startsWith: "1.01." } }, select: { id: true, code: true, name: true, role: true }, orderBy: { code: "asc" } },
            },
        });
        if (!client) throw new NotFoundError();
        const hasChart = (await prisma.chartAccount.count({ where: { organizationId, clientId: id } })) > 0;
        return { client, hasChart, canEdit: roleAllows(ROLES_UPDATE, role) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, hasChart, canEdit } = guard.data;
    const zone = annexIZone(client.payrollZoneCode);
    const periods = client.periods.map((p) => ({
        id: p.id, label: pl(p.month, p.year), open: p.status === "OPEN",
        f931: p.f931 ? { contributionsBase: p.f931.contributionsBase.toFixed(2), employerContributions: p.f931.employerContributions.toFixed(2), reference: p.f931.reference ?? "" } : null,
    }));
    const zones = ANNEX_I_ZONES.map((z) => ({ code: z.code, label: `${z.code} · ${z.name} · ${z.percent.replace(".", ",")} %` }));
    const payAccounts = client.chartAccounts.map((a) => ({ id: a.id, label: `${a.code} · ${a.name}`, role: a.role }));

    return (
        <div className="container stack-lg">
            <header className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <p className="eyebrow"><Link href={`/client/${id}/dashboard`}>← Volver al cliente</Link></p>
                    <h1>Sueldos · {client.name}</h1>
                    <p className="subtitle">F.931 (crédito fiscal Anexo I Ley 27.541 en la DDJJ de IVA del mismo período) y boletas sindicales, con sus asientos en el <Link href={`/client/${id}/journal`}>libro diario</Link>. Zona actual: <strong>{zone ? `${zone.code} · ${zone.name} (${zone.percent.replace(".", ",")} %)` : "sin definir"}</strong>.</p>
                </div>
            </header>
            {!hasChart && <p role="alert">El cliente no tiene plan de cuentas: el F.931 calcula el crédito de IVA pero no genera asiento, y las boletas sindicales no se pueden registrar. Creá el plan en <Link href={`/client/${id}/accounts`}>Plan de cuentas</Link>.</p>}
            {canEdit && <PayrollForms clientId={id} zoneCode={client.payrollZoneCode} zones={zones} periods={periods} payAccounts={payAccounts} hasChart={hasChart} />}
            <section className="card" aria-labelledby="hist-title">
                <h2 id="hist-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Historial</h2>
                <table className="table" style={{ width: "100%" }}>
                    <thead><tr><th>Período</th><th style={{ textAlign: "right" }}>Base contribuciones</th><th style={{ textAlign: "right" }}>Contribuciones</th><th style={{ textAlign: "right" }}>Crédito IVA</th><th>Boletas sindicales</th></tr></thead>
                    <tbody>
                        {client.periods.filter((p) => p.f931 || p.unionSlips.length).map((p) => (
                            <tr key={p.id}>
                                <td>{pl(p.month, p.year)}</td>
                                <td style={{ textAlign: "right" }}>{p.f931 ? formatMoney(p.f931.contributionsBase.toFixed(2)) : "—"}</td>
                                <td style={{ textAlign: "right" }}>{p.f931 ? formatMoney(p.f931.employerContributions.toFixed(2)) : "—"}</td>
                                <td style={{ textAlign: "right" }}>{p.f931 ? `${formatMoney(p.f931.creditAmount.toFixed(2))} (zona ${p.f931.zoneCode}, ${p.f931.annexIPercent.toFixed(2).replace(".", ",")} %)` : "—"}</td>
                                <td>
                                    {p.unionSlips.length === 0 ? "—" : p.unionSlips.map((s) => (
                                        <div key={s.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                                            <span>{s.union}: {formatMoney(s.amount.toFixed(2))} · {s.paidDate ? `pagada ${fmtDate(s.paidDate)}` : "impaga"}</span>
                                            {canEdit && <DeleteSlipButton clientId={id} slipId={s.id} />}
                                        </div>
                                    ))}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </div>
    );
}
