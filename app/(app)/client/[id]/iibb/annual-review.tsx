"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export type ReviewRowView = {
    rateId: string;
    jurisdictionCode: string;
    activity: string;
    prior: string;
    current: string;
    suggestion: string | null;
    norm: string | null;
    ruleRef: string | null;
    status: "CONFIRMADA" | "IGUAL" | "CAMBIA" | "COINCIDE_ALTERNATIVA" | "REQUIERE_DECISION" | "SIN_REGLA";
    message: string | null;
    /** dd/mm/aaaa en que quedó registrada para el año con el valor actual; null si no. */
    yearConfirmedAt: string | null;
    canApply: boolean;
    canKeep: boolean;
};

type Item = { rateId: string; action: "APPLY_RULE"; ruleRef: string } | { rateId: string; action: "KEEP" };

const STATUS_LABEL: Record<ReviewRowView["status"], string> = {
    CONFIRMADA: "Coincide con la norma (confirmada)",
    IGUAL: "Igual a la norma, sin confirmar",
    CAMBIA: "La norma fija otro valor",
    COINCIDE_ALTERNATIVA: "Coincide con una alternativa",
    REQUIERE_DECISION: "Requiere decisión",
    SIN_REGLA: "Sin regla aprobada",
};

export function AnnualReview({ clientId, year, incomeLoaded, rows, canEdit }: { clientId: string; year: number; incomeLoaded: boolean; rows: ReviewRowView[]; canEdit: boolean }) {
    const router = useRouter();
    const inFlight = useRef(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [msg, setMsg] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    // En bloque: sólo lo que ya coincide con la norma (nunca un cambio de valor).
    const bulk: Item[] = rows.flatMap((r): Item[] =>
        r.status === "IGUAL" && r.canApply && r.ruleRef ? [{ rateId: r.rateId, action: "APPLY_RULE", ruleRef: r.ruleRef }]
            : (r.status === "CONFIRMADA" || r.status === "COINCIDE_ALTERNATIVA") && r.canKeep ? [{ rateId: r.rateId, action: "KEEP" }]
                : [],
    );

    async function confirm(items: Item[], key: string) {
        if (inFlight.current || items.length === 0) return;
        inFlight.current = true; setBusy(key); setMsg(null);
        try {
            const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/iibb-annual-review`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ items }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) { setMsg({ tone: "alert", text: json?.error?.message ?? "No se pudo confirmar." }); return; }
            setMsg({ tone: "status", text: `${items.length} alícuota(s) registrada(s) para ${year}.` });
            router.refresh();
        } finally { inFlight.current = false; setBusy(null); }
    }

    if (rows.length === 0) return <p>El cliente no tiene alícuotas asociadas en la ficha.</p>;
    return (
        <div className="stack">
            {!incomeLoaded && (
                <p role="note" style={{ color: "var(--secondary)" }}>
                    Faltan los ingresos brutos de {year - 1}: las alícuotas por tramo quedan como «requiere decisión» hasta cargarlos arriba.
                </p>
            )}
            <table className="table" style={{ width: "100%" }}>
                <thead>
                    <tr>
                        <th>Jur.</th><th>Actividad</th><th>{year - 1}</th><th>Actual (ficha)</th><th>Norma {year}</th><th>Estado</th><th>Registrada {year}</th>{canEdit && <th />}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r) => (
                        <tr key={r.rateId}>
                            <td>{r.jurisdictionCode}</td>
                            <td>{r.activity}</td>
                            <td>{r.prior}</td>
                            <td>{r.current}</td>
                            <td>
                                {r.suggestion ?? "—"}
                                {r.norm && <div style={{ color: "var(--secondary)", fontSize: "0.8125rem" }}>{r.norm}</div>}
                            </td>
                            <td>
                                {STATUS_LABEL[r.status]}
                                {r.message && <div style={{ color: "var(--secondary)", fontSize: "0.8125rem" }}>{r.message}</div>}
                            </td>
                            <td>{r.yearConfirmedAt ?? "no"}</td>
                            {canEdit && (
                                <td style={{ whiteSpace: "nowrap" }}>
                                    {r.canApply && r.ruleRef && (
                                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void confirm([{ rateId: r.rateId, action: "APPLY_RULE", ruleRef: r.ruleRef! }], `a-${r.rateId}`)}>
                                            {busy === `a-${r.rateId}` ? "Aplicando…" : r.status === "CAMBIA" ? "Aplicar norma" : "Confirmar con la norma"}
                                        </button>
                                    )}{" "}
                                    {r.canKeep && r.status !== "IGUAL" && (
                                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void confirm([{ rateId: r.rateId, action: "KEEP" }], `k-${r.rateId}`)}>
                                            {busy === `k-${r.rateId}` ? "Registrando…" : "Mantener la actual"}
                                        </button>
                                    )}{" "}
                                    {(r.status === "REQUIERE_DECISION" || r.status === "SIN_REGLA" || r.status === "CAMBIA") && <Link href={`/client/${clientId}/edit`}>Revisar en la ficha</Link>}
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
            {canEdit && bulk.length > 0 && (
                <div>
                    <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void confirm(bulk, "bulk")}>
                        {busy === "bulk" ? "Registrando…" : `Registrar para ${year} las ${bulk.length} que coinciden con la norma`}
                    </button>
                </div>
            )}
            {msg && <p role={msg.tone}>{msg.text}</p>}
        </div>
    );
}
