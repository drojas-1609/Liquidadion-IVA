"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACCOUNT_ROLES, ACCOUNT_ROLE_LABEL } from "@/lib/accounting/chart-models";
import { buildChartTree, type ChartNode } from "@/lib/accounting/chart-tree";

export interface EditorAccount { id: string; code: string; name: string; imputable: boolean; active: boolean; role: string | null; movements: number }

const roleLabel = (r: string | null) => (r ? ACCOUNT_ROLE_LABEL[r as keyof typeof ACCOUNT_ROLE_LABEL] ?? r : "");

/**
 * Plan del cliente en árbol: capítulos y rubros plegables, cuentas con su uso
 * automático y subcuentas (p. ej. un banco por cuenta corriente). Editar abre
 * el panel de la cuenta: nombre, uso automático y estado.
 */
export function ChartEditor({ clientId, canEdit, accounts }: { clientId: string; canEdit: boolean; accounts: EditorAccount[] }) {
    const router = useRouter();
    const [filter, setFilter] = useState("");
    const [showInactive, setShowInactive] = useState(true);
    const [open, setOpen] = useState<Set<string>>(() => new Set(["1", "1.01"]));
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState<{ name: string; role: string }>({ name: "", role: "" });
    const [subFor, setSubFor] = useState<string | null>(null);
    const [subName, setSubName] = useState("");
    const [subMove, setSubMove] = useState(false);
    const [adding, setAdding] = useState(false);
    const [newCode, setNewCode] = useState("");
    const [newName, setNewName] = useState("");
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const inFlight = useRef(false);

    const tree = useMemo(() => buildChartTree(accounts, { query: filter, includeInactive: showInactive }), [accounts, filter, showInactive]);
    const searching = filter.trim() !== "";
    const isOpen = (code: string) => searching || open.has(code);
    const toggle = (code: string) =>
        setOpen((s) => {
            const n = new Set(s);
            if (n.has(code)) n.delete(code);
            else n.add(code);
            return n;
        });

    async function send(url: string, method: string, body: unknown, ok: string, after?: () => void) {
        if (inFlight.current) return;
        inFlight.current = true;
        setMsg(null);
        try {
            const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const json = await res.json().catch(() => null);
            if (!res.ok) setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo guardar." });
            else {
                setMsg({ tone: "status", text: ok });
                after?.();
                router.refresh();
            }
        } catch {
            setMsg({ tone: "alert", text: "No se pudo guardar." });
        } finally {
            inFlight.current = false;
        }
    }
    const base = `/api/clients/${encodeURIComponent(clientId)}/accounts`;

    function saveEdit(a: EditorAccount) {
        const body: Record<string, unknown> = {};
        if (draft.name.trim() !== a.name) body.name = draft.name;
        if (a.imputable && (draft.role || null) !== a.role) body.role = draft.role || null;
        if (Object.keys(body).length === 0) return setEditing(null);
        void send(`${base}/${encodeURIComponent(a.id)}`, "PATCH", body, "Cuenta actualizada.", () => setEditing(null));
    }

    function addSub(a: EditorAccount) {
        void send(`${base}/${encodeURIComponent(a.id)}/subaccounts`, "POST", { name: subName, moveLines: subMove }, "Subcuenta agregada.", () => {
            setSubFor(null);
            setSubName("");
            setSubMove(false);
            setOpen((s) => new Set(s).add(a.code));
        });
    }

    function row(node: ChartNode<EditorAccount>, depth: number): React.ReactNode {
        const a = node.account;
        const level = node.level;
        const hasKids = node.children.length > 0;
        const folder = level === "chapter" || level === "rubro" || hasKids;
        const expanded = isOpen(a.code);
        const canSub = canEdit && level === "account" && a.active;
        const firstSub = canSub && !hasKids && a.imputable;
        return (
            <li key={a.id} className={`chart-node is-${level}${a.active ? "" : " is-inactive"}`}>
                <div className="chart-row" style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}>
                    {folder ? (
                        <button type="button" className="chart-twisty" aria-expanded={expanded} aria-label={expanded ? `Contraer ${a.name}` : `Expandir ${a.name}`} onClick={() => toggle(a.code)}>
                            {expanded ? "▾" : "▸"}
                        </button>
                    ) : (
                        <span className="chart-twisty" aria-hidden="true" />
                    )}
                    <code className="chart-code">{a.code}</code>
                    <span className="chart-name">
                        {a.name}
                        {folder && level !== "account" && <small> · {node.count}</small>}
                    </span>
                    {a.role && <span className="chart-badge">{roleLabel(a.role)}</span>}
                    {!a.imputable && level === "account" && <span className="chart-badge is-group">agrupa subcuentas</span>}
                    {!a.active && <span className="chart-badge is-off">inactiva</span>}
                    {canEdit && (
                        <span className="chart-actions">
                            {canSub && (
                                <button type="button" className="btn btn-link" onClick={() => { setSubFor(a.id); setSubName(""); setSubMove(false); setEditing(null); }}>
                                    + Subcuenta
                                </button>
                            )}
                            <button type="button" className="btn btn-link" onClick={() => { setEditing(a.id); setDraft({ name: a.name, role: a.role ?? "" }); setSubFor(null); }}>
                                Editar
                            </button>
                        </span>
                    )}
                </div>
                {editing === a.id && (
                    <form className="chart-panel" style={{ marginLeft: `${depth * 1.1 + 2}rem` }} onSubmit={(e) => { e.preventDefault(); saveEdit(a); }}>
                        <label>
                            Nombre
                            <input className="input" value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                        </label>
                        {a.imputable && (
                            <label>
                                Uso automático
                                <select className="input" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                                    <option value="">—</option>
                                    {ACCOUNT_ROLES.map((r) => (
                                        <option key={r} value={r}>{ACCOUNT_ROLE_LABEL[r]}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <div className="chart-panel-actions">
                            <button type="submit" className="btn btn-primary btn-sm">Guardar</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(null)}>Cancelar</button>
                            <button
                                type="button"
                                className="btn btn-link"
                                onClick={() => send(`${base}/${encodeURIComponent(a.id)}`, "PATCH", { active: !a.active }, a.active ? "Cuenta desactivada." : "Cuenta activada.", () => setEditing(null))}
                            >
                                {a.active ? "Desactivar cuenta" : "Activar cuenta"}
                            </button>
                        </div>
                    </form>
                )}
                {subFor === a.id && (
                    <form className="chart-panel" style={{ marginLeft: `${depth * 1.1 + 2}rem` }} onSubmit={(e) => { e.preventDefault(); addSub(a); }}>
                        <label>
                            Nueva subcuenta de «{a.name}»
                            <input className="input" placeholder="p. ej. Banco Galicia c/c 1234/5" value={subName} maxLength={120} onChange={(e) => setSubName(e.target.value)} autoFocus />
                        </label>
                        {firstSub && (
                            <p className="chart-hint">
                                Es la primera subcuenta: «{a.name}» pasa a agrupar las subcuentas (deja de recibir asientos)
                                {a.role ? <> y su uso automático «{roleLabel(a.role)}» pasa a esta subcuenta</> : null}.
                            </p>
                        )}
                        {firstSub && a.movements > 0 && (
                            <label className="chart-check">
                                <input type="checkbox" checked={subMove} onChange={(e) => setSubMove(e.target.checked)} />
                                Pasar los {a.movements} movimiento(s) del libro diario de «{a.name}» a esta subcuenta
                            </label>
                        )}
                        <div className="chart-panel-actions">
                            <button type="submit" className="btn btn-primary btn-sm" disabled={!subName.trim() || (firstSub && a.movements > 0 && !subMove)}>
                                Agregar subcuenta
                            </button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSubFor(null)}>Cancelar</button>
                        </div>
                    </form>
                )}
                {hasKids && expanded && <ul className="chart-children">{node.children.map((c) => row(c, depth + 1))}</ul>}
            </li>
        );
    }

    const total = accounts.length;
    const inactive = accounts.filter((a) => !a.active).length;

    return (
        <section className="card chart-card" aria-labelledby="chart-title">
            <div className="chart-toolbar">
                <h2 id="chart-title">
                    Cuentas <small>{total} · {inactive} inactiva(s)</small>
                </h2>
                <input className="input" type="search" placeholder="Buscar por código, nombre o uso" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <label className="chart-check">
                    <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Mostrar inactivas
                </label>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(new Set(accounts.filter((a) => a.code.length < 13).map((a) => a.code)))}>
                    Expandir todo
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(new Set())}>
                    Contraer todo
                </button>
                {canEdit && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding((v) => !v)}>
                        Nueva cuenta
                    </button>
                )}
            </div>
            {msg && <p role={msg.tone} className={msg.tone === "alert" ? "text-error" : "text-success"}>{msg.text}</p>}
            {canEdit && adding && (
                <form
                    className="chart-panel"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void send(base, "POST", { code: newCode.trim(), name: newName }, "Cuenta agregada.", () => { setNewCode(""); setNewName(""); setAdding(false); });
                    }}
                >
                    <label>
                        Código
                        <input className="input" placeholder="1.01.05.02" value={newCode} onChange={(e) => setNewCode(e.target.value)} style={{ width: "9rem" }} />
                    </label>
                    <label>
                        Nombre
                        <input className="input" value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} style={{ width: "20rem" }} />
                    </label>
                    <div className="chart-panel-actions">
                        <button type="submit" className="btn btn-primary btn-sm">Agregar cuenta</button>
                    </div>
                    <p className="chart-hint">Capítulo «1», rubro «1.01» o cuenta «1.01.05.02». Para varios bancos usá «+ Subcuenta» en la cuenta del banco.</p>
                </form>
            )}
            {tree.length === 0 ? <p className="dash-empty">Sin cuentas que coincidan.</p> : <ul className="chart-tree">{tree.map((n) => row(n, 0))}</ul>}
        </section>
    );
}
