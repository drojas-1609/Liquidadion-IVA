"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Row = { pointOfSale: string; activityCode: string };

export function IibbActivityForm({ clientId, activities, principalCode, pos, seenPos }: {
    clientId: string;
    activities: { code: string; label: string }[];
    principalCode: string | null;
    pos: { pointOfSale: number; activityCode: string }[];
    seenPos: number[];
}) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [busy, setBusy] = useState(false);
    const [principal, setPrincipal] = useState(principalCode ?? "");
    const [rows, setRows] = useState<Row[]>(pos.map((p) => ({ pointOfSale: String(p.pointOfSale), activityCode: p.activityCode })));
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const unassigned = seenPos.filter((p) => !rows.some((r) => r.pointOfSale === String(p)));

    const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    const add = (p = "") => setRows((rs) => [...rs, { pointOfSale: p, activityCode: principal || activities[0]?.code || "" }]);

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setMsg(null);
        try {
            const body = { principalCode: principal || null, pos: rows.filter((r) => r.pointOfSale.trim() !== "").map((r) => ({ pointOfSale: Number(r.pointOfSale), activityCode: r.activityCode })) };
            const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/iibb-activities`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const json = await res.json().catch(() => null);
            if (!res.ok) { setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo guardar." }); return; }
            setMsg({ tone: "status", text: "Configuración guardada. Las liquidaciones abiertas se recalculan al abrirlas." });
            router.refresh();
        } finally { inFlight.current = false; setBusy(false); }
    }

    return (
        <form className="card stack" onSubmit={save} aria-labelledby="cfg-title">
            <h2 id="cfg-title" style={{ fontSize: "1.25rem", fontWeight: "bold" }}>Asignación por defecto</h2>
            <label className="field">
                <span>Actividad principal (se aplica a todas las ventas sin otra asignación)</span>
                <select value={principal} onChange={(e) => setPrincipal(e.target.value)}>
                    <option value="">— Sin definir —</option>
                    {activities.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}
                </select>
            </label>
            <fieldset className="stack">
                <legend>Puntos de venta vinculados a una actividad (opcional)</legend>
                {rows.length === 0 && <p style={{ color: "var(--secondary)" }}>Ningún punto de venta asignado: todas las ventas van a la actividad principal.</p>}
                {rows.map((r, i) => (
                    <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "end", flexWrap: "wrap" }}>
                        <label className="field" style={{ width: "8rem" }}>
                            <span>Punto de venta</span>
                            <input inputMode="numeric" value={r.pointOfSale} onChange={(e) => set(i, { pointOfSale: e.target.value.replace(/\D/g, "").slice(0, 5) })} aria-label={`Punto de venta, fila ${i + 1}`} />
                        </label>
                        <label className="field" style={{ flex: 1, minWidth: "16rem" }}>
                            <span>Actividad</span>
                            <select value={r.activityCode} onChange={(e) => set(i, { activityCode: e.target.value })} aria-label={`Actividad, fila ${i + 1}`}>
                                {activities.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}
                            </select>
                        </label>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Quitar</button>
                    </div>
                ))}
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => add()}>Agregar punto de venta</button>
                    {unassigned.map((p) => <button key={p} type="button" className="btn btn-secondary btn-sm" onClick={() => add(String(p))}>+ PDV {p} (con ventas)</button>)}
                </div>
            </fieldset>
            <div><button className="btn btn-primary" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button></div>
            {msg && <p role={msg.tone}>{msg.text}</p>}
        </form>
    );
}
