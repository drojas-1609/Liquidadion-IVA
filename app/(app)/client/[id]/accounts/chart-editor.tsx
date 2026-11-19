"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACCOUNT_ROLES, ACCOUNT_ROLE_LABEL } from "@/lib/accounting/chart-models";

interface Account { id: string; code: string; name: string; imputable: boolean; active: boolean; role: string | null }

/** Plan del cliente: ver, renombrar, activar/desactivar, asignar usos automáticos y agregar cuentas. */
export function ChartEditor({ clientId, canEdit, accounts }: { clientId: string; canEdit: boolean; accounts: Account[] }) {
    const router = useRouter();
    const [filter, setFilter] = useState("");
    const [editing, setEditing] = useState<string | null>(null);
    const [draftName, setDraftName] = useState("");
    const [newCode, setNewCode] = useState("");
    const [newName, setNewName] = useState("");
    const [newRole, setNewRole] = useState("");
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const inFlight = useRef(false);

    const shown = useMemo(() => {
        const f = filter.trim().toLowerCase();
        return f ? accounts.filter((a) => a.code.startsWith(f) || a.name.toLowerCase().includes(f) || (a.role && ACCOUNT_ROLE_LABEL[a.role as keyof typeof ACCOUNT_ROLE_LABEL]?.toLowerCase().includes(f))) : accounts;
    }, [accounts, filter]);

    async function send(url: string, method: string, body: unknown, ok: string) {
        if (inFlight.current) return;
        inFlight.current = true; setMsg(null);
        try {
            const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const json = await res.json().catch(() => null);
            if (!res.ok) setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo guardar." });
            else { setMsg({ tone: "status", text: ok }); setEditing(null); router.refresh(); }
        } catch { setMsg({ tone: "alert", text: "No se pudo guardar." }); }
        finally { inFlight.current = false; }
    }
    const base = `/api/clients/${encodeURIComponent(clientId)}/accounts`;
    const patch = (a: Account, body: Record<string, unknown>, ok: string) => send(`${base}/${encodeURIComponent(a.id)}`, "PATCH", body, ok);
    const indent = (code: string) => (code.length === 1 ? 0 : code.length === 4 ? 1 : 2);

    return (
        <section className="card" aria-labelledby="chart-title">
            <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--spacing-md)", flexWrap: "wrap", alignItems: "center" }}>
                <h2 id="chart-title" style={{ fontSize: "1.25rem", fontWeight: "bold" }}>Cuentas ({accounts.length})</h2>
                <input className="input" placeholder="Buscar por código, nombre o uso" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: "20rem" }} />
            </div>
            {msg && <p role={msg.tone} style={{ color: msg.tone === "alert" ? "var(--error)" : "var(--success)" }}>{msg.text}</p>}
            <table style={{ width: "100%", fontSize: "0.875rem", borderCollapse: "collapse", marginTop: "var(--spacing-sm)" }}>
                <thead><tr><th style={{ textAlign: "left" }}>Código</th><th style={{ textAlign: "left" }}>Cuenta</th><th style={{ textAlign: "left" }}>Uso automático</th><th style={{ textAlign: "left" }}>Estado</th></tr></thead>
                <tbody>
                    {shown.map((a) => (
                        <tr key={a.id} style={{ borderTop: "1px solid var(--border)", opacity: a.active ? 1 : 0.5, fontWeight: a.imputable ? 400 : 600 }}>
                            <td style={{ whiteSpace: "nowrap" }}>{a.code}</td>
                            <td style={{ paddingLeft: `${indent(a.code) * 1.25}rem` }}>
                                {editing === a.id ? (
                                    <span style={{ display: "flex", gap: "var(--spacing-xs)" }}>
                                        <input className="input" value={draftName} maxLength={120} onChange={(e) => setDraftName(e.target.value)} />
                                        <button type="button" className="btn btn-primary" onClick={() => patch(a, { name: draftName }, "Cuenta renombrada.")}>Guardar</button>
                                        <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancelar</button>
                                    </span>
                                ) : (
                                    <span>{a.name}{canEdit && <button type="button" className="btn btn-link" onClick={() => { setEditing(a.id); setDraftName(a.name); }} style={{ marginLeft: "var(--spacing-xs)" }}>Editar</button>}</span>
                                )}
                            </td>
                            <td>
                                {a.imputable && canEdit ? (
                                    <select className="input" value={a.role ?? ""} onChange={(e) => patch(a, { role: e.target.value || null }, "Uso automático actualizado.")}>
                                        <option value="">—</option>
                                        {ACCOUNT_ROLES.map((r) => <option key={r} value={r}>{ACCOUNT_ROLE_LABEL[r]}</option>)}
                                    </select>
                                ) : a.role ? ACCOUNT_ROLE_LABEL[a.role as keyof typeof ACCOUNT_ROLE_LABEL] : ""}
                            </td>
                            <td>
                                {canEdit ? (
                                    <button type="button" className="btn btn-link" onClick={() => patch(a, { active: !a.active }, a.active ? "Cuenta desactivada." : "Cuenta activada.")}>
                                        {a.active ? "Activa · desactivar" : "Inactiva · activar"}
                                    </button>
                                ) : a.active ? "Activa" : "Inactiva"}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {canEdit && (
                <form onSubmit={(e) => { e.preventDefault(); void send(base, "POST", { code: newCode.trim(), name: newName, role: newRole || null }, "Cuenta agregada."); }}
                    style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap", alignItems: "end", marginTop: "var(--spacing-md)" }}>
                    <label>Código<br /><input className="input" placeholder="1.01.05.02" value={newCode} onChange={(e) => setNewCode(e.target.value)} style={{ width: "9rem" }} /></label>
                    <label>Nombre<br /><input className="input" value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} style={{ width: "20rem" }} /></label>
                    <label>Uso automático<br />
                        <select className="input" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                            <option value="">—</option>
                            {ACCOUNT_ROLES.map((r) => <option key={r} value={r}>{ACCOUNT_ROLE_LABEL[r]}</option>)}
                        </select>
                    </label>
                    <button type="submit" className="btn btn-primary">Agregar cuenta</button>
                </form>
            )}
        </section>
    );
}
