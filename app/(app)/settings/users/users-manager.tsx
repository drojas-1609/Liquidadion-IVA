"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppModule, ClientScope, Role } from "@prisma/client";
import { APP_MODULES, MODULE_LABELS, ROLE_LABELS, SCOPE_LABELS, STATUS_LABELS } from "@/lib/auth/permissions";
import type { InvitationView, MemberView, UsersOverview } from "@/lib/users/views";

/**
 * Gestión de usuarios del estudio (sólo se renderiza para el propietario; cada
 * API vuelve a exigirlo). Confirmaciones visibles en la página, nunca
 * `window.confirm`. Tras cada acción se recarga la vista del servidor.
 */

const ASSIGNABLE: Role[] = ["ADMIN", "ACCOUNTANT", "VIEWER"];

interface Permissions {
    role: Role;
    clientScope: ClientScope;
    clientIds: string[];
    modules: AppModule[];
}

const DEFAULT_PERMISSIONS: Permissions = { role: "ACCOUNTANT", clientScope: "ALL", clientIds: [], modules: [...APP_MODULES] };

const DELIVERY_MESSAGES: Record<string, string> = {
    SENT: "Invitación enviada por correo.",
    FAILED: "La invitación quedó pendiente, pero el correo no se pudo enviar. Probá reenviarla.",
    NOT_CONFIGURED: "La invitación quedó pendiente, pero el envío de correos no está configurado en este entorno.",
    BLOCKED_RECIPIENT: "La invitación quedó pendiente sin enviar: este entorno sólo envía a direcciones de prueba autorizadas.",
};

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; message: string; data: Record<string, unknown> | null }> {
    try {
        const res = await fetch(url, {
            method,
            headers: body === undefined ? undefined : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = res.status === 204 ? null : ((await res.json().catch(() => null)) as Record<string, unknown> | null);
        if (res.ok) return { ok: true, message: "", data };
        const err = data?.error as { message?: unknown } | undefined;
        return { ok: false, message: typeof err?.message === "string" ? err.message : "No se pudo completar la operación.", data };
    } catch {
        return { ok: false, message: "No se pudo conectar con el servidor.", data: null };
    }
}

function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function scopeSummary(scope: ClientScope, count: number): string {
    return scope === "ALL" ? SCOPE_LABELS.ALL : `${count} cliente${count === 1 ? "" : "s"} seleccionado${count === 1 ? "" : "s"}`;
}

function modulesSummary(modules: AppModule[]): string {
    return modules.map((m) => MODULE_LABELS[m].label).join(" · ") || "Ninguno";
}

export function UsersManager({ overview }: { overview: UsersOverview }) {
    const router = useRouter();
    const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
    const { seats } = overview;

    function done(kind: "ok" | "error", text: string) {
        setNotice({ kind, text });
        if (kind === "ok") router.refresh();
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
            <div className="card" role="status" data-seats-used={seats.used} data-seats-limit={seats.limit}>
                <strong>
                    Plazas: {seats.used} de {seats.limit} ocupadas
                </strong>
                <span style={{ color: "var(--secondary)", marginLeft: "var(--spacing-sm)" }}>
                    ({seats.active} acceso{seats.active === 1 ? "" : "s"} activo{seats.active === 1 ? "" : "s"}, {seats.pending} invitaci
                    {seats.pending === 1 ? "ón pendiente" : "ones pendientes"})
                </span>
                <p style={{ color: "var(--secondary)", fontSize: "0.8rem", marginTop: "var(--spacing-xs)" }}>
                    Ocupan plaza los accesos activos (incluido el tuyo) y las invitaciones pendientes no vencidas. Desactivar un acceso o revocar una invitación libera su plaza.
                </p>
            </div>

            {notice && (
                <div
                    role={notice.kind === "error" ? "alert" : "status"}
                    className={notice.kind === "error" ? "text-error" : "text-success"}
                    style={{ padding: "var(--spacing-sm)", border: "1px solid currentColor", borderRadius: "var(--radius-sm)" }}
                >
                    {notice.text}
                </div>
            )}

            <InviteForm clients={overview.clients} disabled={seats.available <= 0} onDone={done} />

            <InvitationsTable invitations={overview.invitations} onDone={done} />

            <MembersTable members={overview.members} clients={overview.clients} onDone={done} />
        </div>
    );
}

// ── Permisos (compartido por invitar y editar) ───────────────────────────

function PermissionsFields({
    value,
    onChange,
    clients,
    idPrefix,
}: {
    value: Permissions;
    onChange: (p: Permissions) => void;
    clients: UsersOverview["clients"];
    idPrefix: string;
}) {
    const [filter, setFilter] = useState("");
    const visible = useMemo(() => {
        const f = filter.trim().toLowerCase();
        return f ? clients.filter((c) => c.name.toLowerCase().includes(f) || c.cuit.includes(f)) : clients;
    }, [clients, filter]);
    const selected = new Set(value.clientIds);

    return (
        <div style={{ display: "grid", gap: "var(--spacing-md)", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            <fieldset style={{ border: "none", padding: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: "var(--spacing-xs)" }}>Rol</legend>
                {ASSIGNABLE.map((r) => (
                    <label key={r} style={{ display: "block", marginBottom: "var(--spacing-xs)" }}>
                        <input type="radio" name={`${idPrefix}-role`} checked={value.role === r} onChange={() => onChange({ ...value, role: r })} />{" "}
                        {ROLE_LABELS[r].label}
                        <small style={{ display: "block", color: "var(--secondary)", marginLeft: "1.4rem" }}>{ROLE_LABELS[r].description}</small>
                    </label>
                ))}
            </fieldset>

            <fieldset style={{ border: "none", padding: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: "var(--spacing-xs)" }}>Clientes</legend>
                {(["ALL", "SELECTED"] as ClientScope[]).map((s) => (
                    <label key={s} style={{ display: "block", marginBottom: "var(--spacing-xs)" }}>
                        <input type="radio" name={`${idPrefix}-scope`} checked={value.clientScope === s} onChange={() => onChange({ ...value, clientScope: s })} />{" "}
                        {SCOPE_LABELS[s]}
                    </label>
                ))}
                {value.clientScope === "SELECTED" && (
                    <div>
                        <input
                            className="input"
                            placeholder="Buscar por nombre o CUIT"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            aria-label="Buscar clientes"
                            style={{ marginBottom: "var(--spacing-xs)" }}
                        />
                        <div style={{ maxHeight: "180px", overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--spacing-xs)" }}>
                            {visible.length === 0 && <small style={{ color: "var(--secondary)" }}>Sin clientes.</small>}
                            {visible.map((c) => (
                                <label key={c.id} style={{ display: "block" }}>
                                    <input
                                        type="checkbox"
                                        checked={selected.has(c.id)}
                                        onChange={(e) =>
                                            onChange({
                                                ...value,
                                                clientIds: e.target.checked ? [...value.clientIds, c.id] : value.clientIds.filter((x) => x !== c.id),
                                            })
                                        }
                                    />{" "}
                                    {c.name} <small style={{ color: "var(--secondary)" }}>{c.cuit}</small>
                                </label>
                            ))}
                        </div>
                        <small style={{ color: "var(--secondary)" }}>{value.clientIds.length} seleccionado(s)</small>
                    </div>
                )}
            </fieldset>

            <fieldset style={{ border: "none", padding: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: "var(--spacing-xs)" }}>Módulos</legend>
                {APP_MODULES.map((m) => (
                    <label key={m} style={{ display: "block", marginBottom: "var(--spacing-xs)" }}>
                        <input
                            type="checkbox"
                            checked={value.modules.includes(m)}
                            onChange={(e) =>
                                onChange({ ...value, modules: e.target.checked ? [...value.modules, m] : value.modules.filter((x) => x !== m) })
                            }
                        />{" "}
                        {MODULE_LABELS[m].label}
                        <small style={{ display: "block", color: "var(--secondary)", marginLeft: "1.4rem" }}>{MODULE_LABELS[m].description}</small>
                    </label>
                ))}
            </fieldset>
        </div>
    );
}

function permissionsBody(p: Permissions) {
    return { role: p.role, clientScope: p.clientScope, clientIds: p.clientScope === "SELECTED" ? p.clientIds : [], modules: p.modules };
}

// ── Invitar ───────────────────────────────────────────────────────────────

function InviteForm({
    clients,
    disabled,
    onDone,
}: {
    clients: UsersOverview["clients"];
    disabled: boolean;
    onDone: (kind: "ok" | "error", text: string) => void;
}) {
    const [email, setEmail] = useState("");
    const [perms, setPerms] = useState<Permissions>(DEFAULT_PERMISSIONS);
    const [busy, setBusy] = useState(false);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        const r = await call("/api/organization/invitations", "POST", { email, ...permissionsBody(perms) });
        setBusy(false);
        if (!r.ok) return onDone("error", r.message);
        setEmail("");
        setPerms(DEFAULT_PERMISSIONS);
        onDone("ok", DELIVERY_MESSAGES[String(r.data?.delivery)] ?? "Invitación creada.");
    }

    return (
        <form className="card" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Invitar a una persona</h2>
            {disabled && <p className="text-error">No hay plazas disponibles. Revocá una invitación o desactivá un acceso para invitar.</p>}
            <label>
                <span style={{ display: "block", fontWeight: 500, marginBottom: "var(--spacing-xs)" }}>Correo electrónico</span>
                <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            </label>
            <PermissionsFields value={perms} onChange={setPerms} clients={clients} idPrefix="invite" />
            <p style={{ color: "var(--secondary)", fontSize: "0.8rem" }}>
                La persona recibe un enlace por correo, activa su propia cuenta y define su contraseña. La invitación vence a los 7 días.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn btn-primary" disabled={busy || disabled}>
                    {busy ? "Enviando…" : "Enviar invitación"}
                </button>
            </div>
        </form>
    );
}

// ── Invitaciones pendientes ───────────────────────────────────────────────

function InvitationsTable({ invitations, onDone }: { invitations: InvitationView[]; onDone: (kind: "ok" | "error", text: string) => void }) {
    const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    async function resend(id: string) {
        setBusy(id);
        const r = await call(`/api/organization/invitations/${encodeURIComponent(id)}/resend`, "POST");
        setBusy(null);
        if (!r.ok) return onDone("error", r.message);
        onDone("ok", DELIVERY_MESSAGES[String(r.data?.delivery)] ?? "Invitación reenviada.");
    }
    async function revoke(id: string) {
        setBusy(id);
        const r = await call(`/api/organization/invitations/${encodeURIComponent(id)}/revoke`, "POST");
        setBusy(null);
        setConfirmRevoke(null);
        if (!r.ok) return onDone("error", r.message);
        onDone("ok", "Invitación revocada. La plaza quedó libre.");
    }

    return (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 600, padding: "var(--spacing-md)" }}>Invitaciones pendientes</h2>
            <table className="table">
                <thead>
                    <tr>
                        <th>Correo</th>
                        <th>Permisos</th>
                        <th>Estado</th>
                        <th>Acciones</th>
                    </tr>
                </thead>
                <tbody>
                    {invitations.length === 0 ? (
                        <tr>
                            <td colSpan={4} style={{ textAlign: "center", color: "var(--secondary)" }}>
                                No hay invitaciones pendientes.
                            </td>
                        </tr>
                    ) : (
                        invitations.map((i) => (
                            <tr key={i.id} data-invitation-id={i.id}>
                                <td style={{ wordBreak: "break-all" }}>{i.email}</td>
                                <td>
                                    <div>{ROLE_LABELS[i.role].label}</div>
                                    <small style={{ color: "var(--secondary)" }}>
                                        {scopeSummary(i.clientScope, i.clientCount)} — {modulesSummary(i.modules)}
                                    </small>
                                </td>
                                <td>
                                    {i.expired ? "Vencida (no ocupa plaza)" : `Vence el ${fmtDate(i.expiresAt)}`}
                                    <small style={{ display: "block", color: "var(--secondary)" }}>
                                        {i.lastSentAt ? `Último envío: ${fmtDate(i.lastSentAt)}` : "Correo sin enviar"}
                                    </small>
                                </td>
                                <td>
                                    {confirmRevoke === i.id ? (
                                        <div style={{ display: "flex", gap: "var(--spacing-xs)", flexWrap: "wrap" }}>
                                            <button type="button" className="btn btn-primary" disabled={busy === i.id} onClick={() => revoke(i.id)}>
                                                Confirmar revocación
                                            </button>
                                            <button type="button" className="btn btn-secondary" onClick={() => setConfirmRevoke(null)}>
                                                Cancelar
                                            </button>
                                        </div>
                                    ) : (
                                        <div style={{ display: "flex", gap: "var(--spacing-xs)", flexWrap: "wrap" }}>
                                            <button type="button" className="btn btn-secondary" disabled={busy === i.id} onClick={() => resend(i.id)}>
                                                Reenviar
                                            </button>
                                            <button type="button" className="btn btn-secondary" onClick={() => setConfirmRevoke(i.id)}>
                                                Revocar
                                            </button>
                                        </div>
                                    )}
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>
    );
}

// ── Personas con acceso ───────────────────────────────────────────────────

function MembersTable({
    members,
    clients,
    onDone,
}: {
    members: MemberView[];
    clients: UsersOverview["clients"];
    onDone: (kind: "ok" | "error", text: string) => void;
}) {
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState<Permissions>(DEFAULT_PERMISSIONS);
    const [confirmDisable, setConfirmDisable] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    function startEdit(m: MemberView) {
        setEditing(m.id);
        setDraft({ role: m.role, clientScope: m.clientScope, clientIds: m.clientIds, modules: m.modules });
    }
    async function save(id: string) {
        setBusy(id);
        const r = await call(`/api/organization/members/${encodeURIComponent(id)}`, "PATCH", permissionsBody(draft));
        setBusy(null);
        if (!r.ok) return onDone("error", r.message);
        setEditing(null);
        const changed = Array.isArray(r.data?.changed) ? (r.data?.changed as unknown[]) : [];
        onDone("ok", changed.length > 0 ? "Permisos actualizados. Rigen desde la próxima acción de esa persona." : "Sin cambios.");
    }
    async function setStatus(id: string, action: "disable" | "enable") {
        setBusy(id);
        const r = await call(`/api/organization/members/${encodeURIComponent(id)}/${action}`, "POST");
        setBusy(null);
        setConfirmDisable(null);
        if (!r.ok) return onDone("error", r.message);
        onDone("ok", action === "disable" ? "Acceso desactivado. La plaza quedó libre." : "Acceso reactivado.");
    }

    return (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 600, padding: "var(--spacing-md)" }}>Personas con acceso</h2>
            <table className="table">
                <thead>
                    <tr>
                        <th>Persona</th>
                        <th>Permisos</th>
                        <th>Estado</th>
                        <th>Acciones</th>
                    </tr>
                </thead>
                <tbody>
                    {members.map((m) => {
                        const protectedRow = m.role === "OWNER" || m.isSelf;
                        return (
                            <tr key={m.id} data-membership-id={m.id} data-status={m.status}>
                                <td style={{ wordBreak: "break-all" }}>
                                    {m.fullName && <div style={{ fontWeight: 500 }}>{m.fullName}</div>}
                                    <div>{m.email}</div>
                                    {m.isSelf && <small style={{ color: "var(--secondary)" }}>Vos</small>}
                                </td>
                                <td>
                                    {editing === m.id ? (
                                        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                                            <PermissionsFields value={draft} onChange={setDraft} clients={clients} idPrefix={`m-${m.id}`} />
                                            <div style={{ display: "flex", gap: "var(--spacing-xs)" }}>
                                                <button type="button" className="btn btn-primary" disabled={busy === m.id} onClick={() => save(m.id)}>
                                                    Guardar permisos
                                                </button>
                                                <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>
                                                    Cancelar
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div>{ROLE_LABELS[m.role].label}</div>
                                            <small style={{ color: "var(--secondary)" }}>
                                                {scopeSummary(m.clientScope, m.clientIds.length)} — {modulesSummary(m.modules)}
                                            </small>
                                        </>
                                    )}
                                </td>
                                <td>{STATUS_LABELS[m.status]}</td>
                                <td>
                                    {protectedRow ? (
                                        <small style={{ color: "var(--secondary)" }}>{m.role === "OWNER" ? "Propietario: acceso protegido" : "Tu acceso"}</small>
                                    ) : confirmDisable === m.id ? (
                                        <div style={{ display: "flex", gap: "var(--spacing-xs)", flexWrap: "wrap" }}>
                                            <button type="button" className="btn btn-primary" disabled={busy === m.id} onClick={() => setStatus(m.id, "disable")}>
                                                Confirmar desactivación
                                            </button>
                                            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDisable(null)}>
                                                Cancelar
                                            </button>
                                        </div>
                                    ) : (
                                        <div style={{ display: "flex", gap: "var(--spacing-xs)", flexWrap: "wrap" }}>
                                            {editing !== m.id && (
                                                <button type="button" className="btn btn-secondary" onClick={() => startEdit(m)}>
                                                    Editar permisos
                                                </button>
                                            )}
                                            {m.status === "ACTIVE" ? (
                                                <button type="button" className="btn btn-secondary" onClick={() => setConfirmDisable(m.id)}>
                                                    Desactivar
                                                </button>
                                            ) : (
                                                <button type="button" className="btn btn-secondary" disabled={busy === m.id} onClick={() => setStatus(m.id, "enable")}>
                                                    Reactivar
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
