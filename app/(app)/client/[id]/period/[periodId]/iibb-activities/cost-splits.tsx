"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export type SplitInvoiceView = {
    id: string;
    providerName: string;
    label: string;
    date: string | null;
    /** Neto con signo, ya formateado ($). */
    net: string;
    /** Neto sin signo, con coma decimal (para precargar el reparto). */
    netAbs: string;
    allocation: string;
    pending: boolean;
    manual: boolean;
    manualMode: boolean;
    splits: { activityCode: string; amount: string }[];
};

/** Compras de prestadores: detalle del reparto y edición del reparto manual por factura. */
export function CostSplits({ periodId, activities, invoices, canEdit }: {
    periodId: string;
    activities: { code: string; label: string }[];
    invoices: SplitInvoiceView[];
    canEdit: boolean;
}) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [open, setOpen] = useState<string | null>(null);
    const [rows, setRows] = useState<{ activityCode: string; amount: string }[]>([]);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);

    function edit(inv: SplitInvoiceView) {
        setOpen(inv.id);
        setMsg(null);
        setRows(inv.splits.length > 0 ? inv.splits : [{ activityCode: activities[0]?.code ?? "", amount: inv.netAbs }]);
    }
    async function save(invoiceId: string, splits: { activityCode: string; amount: string }[]) {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setMsg(null);
        try {
            const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/iibb-cost-splits`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ invoiceId, splits }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) { setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo guardar el reparto." }); return; }
            setOpen(null);
            setMsg({ tone: "status", text: splits.length > 0 ? "Reparto guardado." : "Reparto quitado." });
            router.refresh();
        } finally { inFlight.current = false; setBusy(false); }
    }
    const set = (i: number, patch: Partial<{ activityCode: string; amount: string }>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

    return (
        <div className="stack">
            <table className="table" style={{ width: "100%" }}>
                <thead><tr><th>Prestador</th><th>Comprobante</th><th>Fecha</th><th style={{ textAlign: "right" }}>Neto</th><th>Reparto</th>{canEdit && <th />}</tr></thead>
                <tbody>
                    {invoices.map((inv) => (
                        <tr key={inv.id} className={inv.pending ? "is-warn" : undefined}>
                            <td>{inv.providerName}</td>
                            <td>{inv.label}</td>
                            <td>{inv.date ? inv.date.split("-").reverse().join("/") : "—"}</td>
                            <td style={{ textAlign: "right" }}>$ {inv.net}</td>
                            <td>
                                {inv.pending ? <strong>Pendiente de repartir (no resta)</strong> : inv.allocation}
                                {inv.manual && <small style={{ display: "block", color: "var(--secondary)" }}>reparto manual</small>}
                                {open === inv.id && (
                                    <div className="stack" style={{ marginTop: "0.5rem" }}>
                                        {rows.map((r, i) => (
                                            <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "end", flexWrap: "wrap" }}>
                                                <select value={r.activityCode} onChange={(e) => set(i, { activityCode: e.target.value })} aria-label={`Actividad, parte ${i + 1}`}>
                                                    <option value="">— no resta —</option>
                                                    {activities.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}
                                                </select>
                                                <input className="input" style={{ maxWidth: "10rem" }} inputMode="decimal" value={r.amount} onChange={(e) => set(i, { amount: e.target.value })} aria-label={`Importe neto, parte ${i + 1}`} />
                                                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Quitar</button>
                                            </div>
                                        ))}
                                        <small style={{ color: "var(--secondary)" }}>Importes netos de IVA, positivos; deben sumar $ {inv.netAbs}.</small>
                                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => [...rs, { activityCode: "", amount: "" }])}>Agregar parte</button>
                                            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save(inv.id, rows.filter((r) => r.amount.trim() !== ""))}>{busy ? "Guardando…" : "Guardar reparto"}</button>
                                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(null)}>Cancelar</button>
                                        </div>
                                    </div>
                                )}
                            </td>
                            {canEdit && (
                                <td style={{ whiteSpace: "nowrap" }}>
                                    {open !== inv.id && <button type="button" className="btn btn-secondary btn-sm" onClick={() => edit(inv)}>{inv.manual ? "Editar reparto" : "Repartir"}</button>}{" "}
                                    {inv.manual && open !== inv.id && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void save(inv.id, [])}>Quitar reparto</button>}
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
            {msg && <p role={msg.tone}>{msg.text}</p>}
        </div>
    );
}
