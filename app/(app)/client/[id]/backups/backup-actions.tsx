"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MANUAL_BACKUP_CATEGORIES, BACKUP_CATEGORY_LABEL, type BackupCategory } from "@/lib/drive/naming";

async function toBase64(f: File): Promise<string> {
    const u = new Uint8Array(await f.arrayBuffer());
    let s = "";
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
}

type Msg = { tone: "status" | "alert"; text: string } | null;

function resultText(r: { status?: string; uploaded?: number; remaining?: number; message?: string } | undefined): string {
    if (!r) return "";
    if (r.status === "not_connected") return " Quedó en cola: Drive no está conectado.";
    if (r.status === "not_configured") return " Quedó en cola: falta configurar Drive.";
    if (r.status === "error") return ` Quedó en cola: ${r.message ?? "error de Drive"}.`;
    return r.remaining ? ` Subidos ${r.uploaded}; quedan ${r.remaining} pendientes.` : " Subido a Drive.";
}

export function BackupActions({ clientId, periods, pendingCount }: { clientId: string; periods: { id: string; label: string }[]; pendingCount: number }) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<Msg>(null);
    const [file, setFile] = useState<File | null>(null);
    const [form, setForm] = useState({ category: "SUELDOS" as BackupCategory, periodId: periods[0]?.id ?? "", year: String(new Date().getFullYear()), bank: "", description: "" });
    const yearly = form.category === "BANCOS" || form.category === "CONTABILIDAD";
    const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

    async function run(fn: () => Promise<void>) {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true);
        try { await fn(); } finally { inFlight.current = false; setBusy(false); }
    }

    const upload = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
        setMsg(null);
        if (!file) { setMsg({ tone: "alert", text: "Elegí el archivo." }); return; }
        if (file.size > 20 * 1024 * 1024) { setMsg({ tone: "alert", text: "El archivo supera 20 MB." }); return; }
        try {
            const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/backups`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...form, fileName: file.name, file: await toBase64(file) }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo respaldar." });
            else { setMsg({ tone: "status", text: (json.duplicate ? "Ese archivo ya estaba respaldado." : "Archivo registrado.") + resultText(json.result) }); setFile(null); router.refresh(); }
        } catch { setMsg({ tone: "alert", text: "No se pudo respaldar." }); }
    }); };

    const retry = () => void run(async () => {
        setMsg(null);
        try {
            const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/backups/retry`, { method: "POST" });
            const json = await res.json().catch(() => null);
            setMsg({ tone: res.ok ? "status" : "alert", text: res.ok ? `Reintento:${resultText(json)}` : "No se pudo reintentar." });
            router.refresh();
        } catch { setMsg({ tone: "alert", text: "No se pudo reintentar." }); }
    });

    return (
        <form className="card" onSubmit={upload} aria-labelledby="up-title">
            <h2 id="up-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Subir comprobante al respaldo</h2>
            <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "var(--spacing-sm)", maxWidth: "36rem" }}>
                <label>Va en
                    <select className="input" value={form.category} onChange={set("category")}>
                        {MANUAL_BACKUP_CATEGORIES.map((c) => <option key={c} value={c}>{BACKUP_CATEGORY_LABEL[c]}</option>)}
                    </select>
                </label>
                {yearly ? (
                    <label>Año<input className="input" inputMode="numeric" value={form.year} onChange={set("year")} /></label>
                ) : (
                    <label>Período
                        <select className="input" value={form.periodId} onChange={set("periodId")}>
                            {periods.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                    </label>
                )}
                {form.category === "BANCOS" && <label>Banco o cuenta<input className="input" value={form.bank} onChange={set("bank")} placeholder="p. ej. BANCO SANTA CRUZ CC 123" maxLength={60} /></label>}
                <label>Descripción (va en el nombre del archivo)<input className="input" value={form.description} onChange={set("description")} placeholder="p. ej. F931 VEP" maxLength={120} required /></label>
                <label>Archivo<input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
                <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
                    <button type="submit" className="btn btn-primary">{busy ? "Procesando…" : "Respaldar"}</button>
                    {pendingCount > 0 && <button type="button" className="btn btn-secondary" onClick={retry}>Reintentar pendientes ({pendingCount})</button>}
                </div>
            </fieldset>
            {msg && <p role={msg.tone}>{msg.text}</p>}
        </form>
    );
}
