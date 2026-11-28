"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Row = { pointOfSale: string; activityCode: string };
type Provider = { cuit: string; name: string; activityCode: string };

export function IibbActivityForm({ clientId, activities, principalCode, pos, seenPos, providers, suppliers }: {
    clientId: string;
    activities: { code: string; label: string }[];
    principalCode: string | null;
    pos: { pointOfSale: number; activityCode: string }[];
    seenPos: number[];
    /** Prestadores marcados (base por diferencia). */
    providers: Provider[];
    /** Proveedores con compras del año, para agregarlos con un clic. */
    suppliers: { cuit: string; name: string }[];
}) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [busy, setBusy] = useState(false);
    const [principal, setPrincipal] = useState(principalCode ?? "");
    const [rows, setRows] = useState<Row[]>(pos.map((p) => ({ pointOfSale: String(p.pointOfSale), activityCode: p.activityCode })));
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const [provs, setProvs] = useState<Provider[]>(providers);
    const setProv = (i: number, patch: Partial<Provider>) => setProvs((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    const addProv = (p: { cuit?: string; name?: string } = {}) => setProvs((ps) => [...ps, { cuit: p.cuit ?? "", name: p.name ?? "", activityCode: principal || activities[0]?.code || "" }]);
    const notMarked = suppliers.filter((s) => !provs.some((p) => p.cuit.replace(/\D/g, "") === s.cuit));
    const unassigned = seenPos.filter((p) => !rows.some((r) => r.pointOfSale === String(p)));

    const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    const add = (p = "") => setRows((rs) => [...rs, { pointOfSale: p, activityCode: principal || activities[0]?.code || "" }]);

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setMsg(null);
        try {
            const body = {
                principalCode: principal || null,
                pos: rows.filter((r) => r.pointOfSale.trim() !== "").map((r) => ({ pointOfSale: Number(r.pointOfSale), activityCode: r.activityCode })),
                providers: provs.filter((p) => p.cuit.trim() !== "" || p.name.trim() !== "").map((p) => ({ cuit: p.cuit.trim(), name: p.name.trim(), activityCode: p.activityCode })),
            };
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
            <fieldset className="stack">
                <legend>Prestadores: base por diferencia (opcional)</legend>
                <p style={{ color: "var(--secondary)", fontSize: "0.875rem" }}>
                    Criterio del estudio (p. ej. agencias de viajes): la base de la actividad es lo cobrado menos lo pagado a estos prestadores. Se restan sus compras del período netas de IVA (facturas C por el total); las notas de crédito restan. En cada período podés ajustar el costo a mano.
                </p>
                {provs.length === 0 && <p style={{ color: "var(--secondary)" }}>Sin prestadores: la base es el total de las ventas de cada actividad.</p>}
                {provs.map((p, i) => (
                    <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "end", flexWrap: "wrap" }}>
                        <label className="field" style={{ width: "10rem" }}>
                            <span>CUIT</span>
                            <input inputMode="numeric" value={p.cuit} onChange={(e) => setProv(i, { cuit: e.target.value.replace(/[^\d-]/g, "").slice(0, 13) })} aria-label={`CUIT del prestador, fila ${i + 1}`} />
                        </label>
                        <label className="field" style={{ flex: 1, minWidth: "12rem" }}>
                            <span>Nombre</span>
                            <input value={p.name} maxLength={200} onChange={(e) => setProv(i, { name: e.target.value })} aria-label={`Nombre del prestador, fila ${i + 1}`} />
                        </label>
                        <label className="field" style={{ flex: 1, minWidth: "14rem" }}>
                            <span>Actividad a la que resta</span>
                            <select value={p.activityCode} onChange={(e) => setProv(i, { activityCode: e.target.value })} aria-label={`Actividad del prestador, fila ${i + 1}`}>
                                {activities.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}
                            </select>
                        </label>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setProvs((ps) => ps.filter((_, j) => j !== i))}>Quitar</button>
                    </div>
                ))}
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => addProv()}>Agregar prestador</button>
                </div>
                {notMarked.length > 0 && (
                    <details>
                        <summary>Proveedores con compras este año ({notMarked.length})</summary>
                        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                            {notMarked.map((s) => <button key={s.cuit} type="button" className="btn btn-secondary btn-sm" onClick={() => addProv(s)}>+ {s.name || s.cuit}</button>)}
                        </div>
                    </details>
                )}
            </fieldset>
            <div><button className="btn btn-primary" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button></div>
            {msg && <p role={msg.tone}>{msg.text}</p>}
        </form>
    );
}
