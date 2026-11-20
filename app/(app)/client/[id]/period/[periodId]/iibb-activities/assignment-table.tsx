"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Row = { id: string; date: string; voucher: string; name: string; amount: string; code: string | null; source: string; manual: boolean };

export function ActivityAssignmentTable({ periodId, rows, activities, canEdit }: {
    periodId: string; rows: Row[]; activities: { code: string; label: string }[]; canEdit: boolean;
}) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [busy, setBusy] = useState(false);
    const [sel, setSel] = useState<Set<string>>(new Set());
    const [code, setCode] = useState(activities[0]?.code ?? "");
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const all = rows.length > 0 && rows.every((r) => sel.has(r.id));

    async function apply(value: string | null) {
        if (inFlight.current || sel.size === 0) return;
        inFlight.current = true; setBusy(true); setMsg(null);
        try {
            const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/iibb-activities`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ assignments: [...sel].map((invoiceId) => ({ invoiceId, code: value })) }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) { setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo guardar." }); return; }
            setMsg({ tone: "status", text: value ? `${json.updated} comprobante(s) asignados a ${value}.` : `Se quitó la corrección manual de ${json.updated} comprobante(s).` });
            setSel(new Set());
            router.refresh();
        } finally { inFlight.current = false; setBusy(false); }
    }

    return (
        <div className="stack">
            {canEdit && (
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "end", flexWrap: "wrap" }}>
                    <label className="field" style={{ minWidth: "18rem" }}>
                        <span>Asignar seleccionados a</span>
                        <select value={code} onChange={(e) => setCode(e.target.value)}>
                            {activities.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}
                        </select>
                    </label>
                    <button type="button" className="btn btn-primary" disabled={busy || sel.size === 0} onClick={() => void apply(code)}>Asignar ({sel.size})</button>
                    <button type="button" className="btn btn-secondary" disabled={busy || sel.size === 0} onClick={() => void apply(null)}>Quitar corrección</button>
                </div>
            )}
            {msg && <p role={msg.tone}>{msg.text}</p>}
            <table className="table" style={{ width: "100%" }}>
                <thead>
                    <tr>
                        {canEdit && <th><input type="checkbox" aria-label="Seleccionar todos" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} /></th>}
                        <th>Fecha</th><th>Comprobante</th><th>Cliente</th><th style={{ textAlign: "right" }}>Base IIBB</th><th>Actividad</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => (
                        <tr key={r.id}>
                            {canEdit && <td><input type="checkbox" aria-label={`Seleccionar ${r.voucher}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                            <td>{r.date}</td>
                            <td>{r.voucher}</td>
                            <td>{r.name}</td>
                            <td style={{ textAlign: "right" }}>{r.amount}</td>
                            <td>{r.code ?? "—"} <small style={{ color: r.manual ? "var(--primary)" : "var(--secondary)" }}>({r.source})</small></td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
