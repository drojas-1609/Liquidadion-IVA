"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Certificado MiPyME y, si el cliente todavía no tiene plan, la elección del plan modelo. */
export function AccountingProfileForm({ clientId, canEdit, hasAccounts, suggested, initial }: {
    clientId: string; canEdit: boolean; hasAccounts: boolean; suggested: "COMMERCIAL" | "SERVICES" | null;
    initial: { mipymeCategory: string; mipymeManufacturing: boolean; mipymeValidUntil: string };
}) {
    const router = useRouter();
    const [cat, setCat] = useState(initial.mipymeCategory);
    const [manuf, setManuf] = useState(initial.mipymeManufacturing);
    const [until, setUntil] = useState(initial.mipymeValidUntil);
    const [model, setModel] = useState<string>(suggested ?? "");
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const inFlight = useRef(false);

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true; setBusy(true); setMsg(null);
        try {
            const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/accounting-profile`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mipymeCategory: cat || null, mipymeManufacturing: cat === "MEDIANA_T1" && manuf, mipymeValidUntil: cat ? until || null : null, chartModel: hasAccounts ? null : model || null }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo guardar." });
            else { setMsg({ tone: "status", text: json?.accountsCreated ? `Guardado. Se creó el plan con ${json.accountsCreated} cuentas.` : "Guardado." }); router.refresh(); }
        } catch { setMsg({ tone: "alert", text: "No se pudo guardar." }); }
        finally { inFlight.current = false; setBusy(false); }
    }

    return (
        <form className="card" onSubmit={save} aria-labelledby="acc-profile-title">
            <h2 id="acc-profile-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>Perfil contable</h2>
            <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "var(--spacing-sm)", maxWidth: "36rem" }}>
                <label>Certificado MiPyME
                    <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
                        <option value="">No tiene</option>
                        <option value="MICRO">Micro</option>
                        <option value="PEQUENA">Pequeña</option>
                        <option value="MEDIANA_T1">Mediana tramo 1</option>
                        <option value="MEDIANA_T2">Mediana tramo 2</option>
                    </select>
                </label>
                {cat === "MEDIANA_T1" && <label><input type="checkbox" checked={manuf} onChange={(e) => setManuf(e.target.checked)} /> Industria manufacturera</label>}
                {cat && <label>Vigencia del certificado (hasta)<input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>}
                {!hasAccounts && (
                    <label>Plan de cuentas modelo
                        <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                            <option value="">Sin plan por ahora</option>
                            <option value="COMMERCIAL">Empresa comercializadora{suggested === "COMMERCIAL" ? " (sugerido por la actividad)" : ""}</option>
                            <option value="SERVICES">Empresa de servicios{suggested === "SERVICES" ? " (sugerido por la actividad)" : ""}</option>
                        </select>
                    </label>
                )}
                {canEdit && <button type="submit" className="btn btn-primary" style={{ justifySelf: "start" }}>{busy ? "Guardando…" : "Guardar"}</button>}
            </fieldset>
            {msg && <p role={msg.tone} style={{ marginTop: "var(--spacing-sm)", color: msg.tone === "alert" ? "var(--error)" : "var(--success)" }}>{msg.text}</p>}
        </form>
    );
}
