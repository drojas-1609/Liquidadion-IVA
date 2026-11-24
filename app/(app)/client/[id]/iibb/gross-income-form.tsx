"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Row = { year: number; amount: string; note: string; reference: string };

export function GrossIncomeForm({ clientId, canEdit, rows }: { clientId: string; canEdit: boolean; rows: Row[] }) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [busy, setBusy] = useState<number | null>(null);
    const [draft, setDraft] = useState<Record<number, { amount: string; note: string }>>(Object.fromEntries(rows.map((r) => [r.year, { amount: r.amount, note: r.note }])));
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);

    async function save(year: number) {
        if (inFlight.current) return;
        inFlight.current = true; setBusy(year); setMsg(null);
        try {
            const d = draft[year];
            const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/gross-income`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ incomeYear: year, amount: d.amount.trim() === "" ? null : d.amount, note: d.note }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) { setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo guardar." }); return; }
            setMsg({ tone: "status", text: d.amount.trim() === "" ? `Se borraron los ingresos de ${year}.` : `Ingresos de ${year} guardados.` });
            router.refresh();
        } finally { inFlight.current = false; setBusy(null); }
    }

    return (
        <div className="stack">
            <table className="table" style={{ width: "100%" }}>
                <thead><tr><th>Año</th><th>Ingresos brutos ($)</th><th>Nota</th><th>Referencia de la app</th>{canEdit && <th />}</tr></thead>
                <tbody>
                    {rows.map((r) => (
                        <tr key={r.year}>
                            <td>{r.year}</td>
                            <td>
                                {canEdit ? (
                                    <input inputMode="decimal" value={draft[r.year].amount} placeholder="sin cargar" aria-label={`Ingresos brutos ${r.year}`}
                                        onChange={(e) => setDraft((d) => ({ ...d, [r.year]: { ...d[r.year], amount: e.target.value } }))} />
                                ) : (r.amount || "sin cargar")}
                            </td>
                            <td>
                                {canEdit ? (
                                    <input value={draft[r.year].note} maxLength={300} placeholder="p. ej. según DDJJ anual" aria-label={`Nota ${r.year}`}
                                        onChange={(e) => setDraft((d) => ({ ...d, [r.year]: { ...d[r.year], note: e.target.value } }))} />
                                ) : r.note}
                            </td>
                            <td style={{ color: "var(--secondary)", fontSize: "0.875rem" }}>{r.reference}</td>
                            {canEdit && <td><button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void save(r.year)}>{busy === r.year ? "Guardando…" : "Guardar"}</button></td>}
                        </tr>
                    ))}
                </tbody>
            </table>
            {msg && <p role={msg.tone}>{msg.text}</p>}
        </div>
    );
}
