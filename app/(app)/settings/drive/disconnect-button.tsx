"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DisconnectDriveButton() {
    const router = useRouter();
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    async function go() {
        setBusy(true); setErr(null);
        try {
            const res = await fetch("/api/drive", { method: "DELETE" });
            if (!res.ok) setErr("No se pudo desconectar."); else router.refresh();
        } catch { setErr("No se pudo desconectar."); } finally { setBusy(false); setConfirm(false); }
    }
    if (!confirm) return <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>Desconectar</button>;
    return (
        <span style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <span>¿Desconectar? No se borra nada en Drive.</span>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void go()}>Sí, desconectar</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirm(false)}>No</button>
            {err && <span role="alert">{err}</span>}
        </span>
    );
}
