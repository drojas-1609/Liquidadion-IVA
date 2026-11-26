"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Adj = { activityCode: string; amount: string; note: string };

/** Ajustes manuales del costo de prestadores por actividad (base por diferencia). */
export function CostAdjustments({ periodId, activities, initial, canEdit }: {
    periodId: string;
    activities: { code: string; label: string }[];
    initial: Adj[];
    canEdit: boolean;
}) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [rows, setRows] = useState<Adj[]>(initial);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const set = (i: number, patch: Partial<Adj>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    const free = activities.filter((a) => !rows.some((r) => r.activityCode === a.code));

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setMsg(null);
        try {
            const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/iibb-cost-adjustments`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ adjustments: rows.filter((r) => r.amount.trim() !== "" || r.note.trim() !== "") }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) { setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo guardar." }); return; }
            setMsg({ tone: "status", text: "Ajustes guardados." });
            router.refresh();
        } finally { inFlight.current = false; setBusy(false); }
    }

    if (!canEdit && rows.length === 0) return <p style={{ color: "var(--secondary)" }}>Sin ajustes manuales.</p>;
    return (
        <form className="stack" onSubmit={save}>
            {rows.length === 0 && <p style={{ color: "var(--secondary)" }}>Sin ajustes manuales.</p>}
            {rows.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "end", flexWrap: "wrap" }}>
                    <label className="field" style={{ flex: 1, minWidth: "14rem" }}>
                        <span>Actividad</span>
                        <select value={r.activityCode} disabled={!canEdit} onChange={(e) => set(i, { activityCode: e.target.value })} aria-label={`Actividad del ajuste ${i + 1}`}>
                            {activities.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}
                        </select>
                    </label>
                    <label className="field" style={{ width: "11rem" }}>
                        <span>Ajuste del costo ($)</span>
                        <input inputMode="decimal" value={r.amount} disabled={!canEdit} placeholder="p. ej. -1.500,00" onChange={(e) => set(i, { amount: e.target.value })} aria-label={`Importe del ajuste ${i + 1}`} />
                    </label>
                    <label className="field" style={{ flex: 2, minWidth: "16rem" }}>
                        <span>Motivo (obligatorio)</span>
                        <input value={r.note} maxLength={300} disabled={!canEdit} onChange={(e) => set(i, { note: e.target.value })} aria-label={`Motivo del ajuste ${i + 1}`} />
                    </label>
                    {canEdit && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Quitar</button>}
                </div>
            ))}
            {canEdit && (
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {free.length > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => [...rs, { activityCode: free[0].code, amount: "", note: "" }])}>Agregar ajuste</button>}
                    <button className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Guardando…" : "Guardar ajustes"}</button>
                </div>
            )}
            {msg && <p role={msg.tone}>{msg.text}</p>}
        </form>
    );
}
