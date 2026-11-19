import Link from "next/link";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, requireClientAccess, guardPage } from "@/lib/auth/authz";
import { ROLES_READ, ROLES_UPDATE, roleAllows } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";
import { AccessNotice } from "@/app/_components/access-notice";
import { formatMoney } from "@/lib/format";
import { JOURNAL_KIND_LABEL, totals, type JournalKind } from "@/lib/accounting/journal";
import { JournalActions, DeleteEntryButton } from "./journal-actions";

export const dynamic = "force-dynamic";

const fmtDate = (d: Date) => d.toISOString().slice(0, 10).split("-").reverse().join("/");

export default async function JournalPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const guard = await guardPage(async () => {
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId, role } = await requireClientAccess(profileId, id, ROLES_READ, { module: MODULES_CLIENT_DIRECTORY });
        const client = await prisma.client.findFirst({
            where: { id, organizationId },
            select: {
                id: true, name: true,
                periods: { select: { id: true, month: true, year: true }, orderBy: [{ year: "desc" }, { month: "desc" }] },
                chartAccounts: { where: { imputable: true, active: true, code: { startsWith: "1.01." } }, select: { id: true, code: true, name: true, role: true }, orderBy: { code: "asc" } },
                journalEntries: {
                    select: {
                        id: true, number: true, date: true, kind: true, description: true, sourceKey: true,
                        lines: { select: { id: true, debit: true, credit: true, memo: true, account: { select: { code: true, name: true } } }, orderBy: { position: "asc" } },
                    },
                    orderBy: [{ date: "desc" }, { number: "desc" }],
                },
            },
        });
        if (!client) throw new NotFoundError();
        return { client, canEdit: roleAllows(ROLES_UPDATE, role) };
    });
    if (!guard.ok) return <AccessNotice notice={guard.notice} />;
    const { client, canEdit } = guard.data;
    const periods = client.periods.map((p) => ({ id: p.id, label: `${String(p.month).padStart(2, "0")}/${p.year}` }));
    const payAccounts = client.chartAccounts.map((a) => ({ id: a.id, label: `${a.code} · ${a.name}`, role: a.role }));

    return (
        <div className="container stack-lg">
            <header className="page-header" style={{ marginBottom: 0 }}>
                <div>
                    <p className="eyebrow"><Link href={`/client/${id}/dashboard`}>← Volver al cliente</Link></p>
                    <h1>Libro diario · {client.name}</h1>
                    <p className="subtitle">Asientos de la liquidación de IVA, la DDJJ de Ingresos Brutos y los pagos de impuestos. Usan las cuentas con «uso automático» del <Link href={`/client/${id}/accounts`}>plan de cuentas</Link>.</p>
                </div>
            </header>
            {canEdit && <JournalActions clientId={id} periods={periods} payAccounts={payAccounts} />}
            <section className="card" aria-labelledby="entries-title">
                <h2 id="entries-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Asientos ({client.journalEntries.length})</h2>
                {client.journalEntries.length === 0 && <p>Todavía no hay asientos registrados.</p>}
                <div className="stack">
                    {client.journalEntries.map((e) => {
                        const t = totals(e.lines);
                        return (
                            <article key={e.id} style={{ borderTop: "1px solid var(--color-border, #333)", paddingTop: "var(--spacing-sm)" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                                    <h3 style={{ fontWeight: "bold" }}>N.º {e.number} · {fmtDate(e.date)} · {e.description}</h3>
                                    <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                                        <span className="badge">{JOURNAL_KIND_LABEL[e.kind as JournalKind] ?? e.kind}{e.sourceKey ? " · automático" : ""}</span>
                                        {canEdit && <DeleteEntryButton clientId={id} entryId={e.id} number={e.number} />}
                                    </span>
                                </div>
                                <table className="table" style={{ width: "100%" }}>
                                    <thead><tr><th>Cuenta</th><th>Detalle</th><th style={{ textAlign: "right" }}>Debe</th><th style={{ textAlign: "right" }}>Haber</th></tr></thead>
                                    <tbody>
                                        {e.lines.map((l) => (
                                            <tr key={l.id}>
                                                <td style={{ paddingLeft: l.credit.isZero() ? 0 : "2rem" }}>{l.account.code} · {l.account.name}</td>
                                                <td>{l.memo}</td>
                                                <td style={{ textAlign: "right" }}>{l.debit.isZero() ? "" : formatMoney(l.debit.toFixed(2))}</td>
                                                <td style={{ textAlign: "right" }}>{l.credit.isZero() ? "" : formatMoney(l.credit.toFixed(2))}</td>
                                            </tr>
                                        ))}
                                        <tr><td colSpan={2}><strong>Totales</strong></td><td style={{ textAlign: "right" }}><strong>{formatMoney(t.debit.toFixed(2))}</strong></td><td style={{ textAlign: "right" }}><strong>{formatMoney(t.credit.toFixed(2))}</strong></td></tr>
                                    </tbody>
                                </table>
                            </article>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}
