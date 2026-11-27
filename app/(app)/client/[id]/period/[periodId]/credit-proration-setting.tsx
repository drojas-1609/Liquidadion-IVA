"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    COEFFICIENT_STATUSES, COEFFICIENT_STATUS_LABELS, PRORATION_MODES, PRORATION_MODE_LABELS, usesGlobalCoefficient,
    type CoefficientStatus, type ProrationMode,
} from "@/lib/credit-proration-input";

/**
 * Prorrateo del crédito fiscal del período (art. 13 Ley de IVA): modalidad y,
 * con prorrateo global, el coeficiente que carga el estudio (provisional o
 * definitivo). Con prorrateo global la liquidación aplica el coeficiente sobre
 * el IVA de compras sujeto a prorrateo; sin coeficiente no se puede calcular.
 */
export function CreditProrationSetting({ periodId, mode, coefficient, status, canEdit }: {
    periodId: string;
    mode: ProrationMode;
    coefficient: string | null;
    status: CoefficientStatus | null;
    canEdit: boolean;
}) {
    const router = useRouter();
    const [draftMode, setDraftMode] = useState<ProrationMode>(mode);
    const [draftCoefficient, setDraftCoefficient] = useState((coefficient ?? "").replace(".", ","));
    const [draftStatus, setDraftStatus] = useState<CoefficientStatus>(status ?? "PROVISIONAL");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    const global = usesGlobalCoefficient(draftMode);

    async function save() {
        setSaving(true);
        setError("");
        setSaved(false);
        try {
            const coef = global ? draftCoefficient.trim() : "";
            const res = await fetch(`/api/periods/${periodId}/credit-proration`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ creditProrationMode: draftMode, globalCoefficient: coef || null, ...(coef ? { globalCoefficientStatus: draftStatus } : {}) }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) { setError(json?.error?.message ?? json?.error ?? "No se pudo guardar el prorrateo."); return; }
            setSaved(true);
            router.refresh();
        } catch {
            setError("No se pudo conectar. Volvé a intentar.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <section className="card" aria-labelledby="proration-title" aria-busy={saving} style={{ marginTop: "var(--spacing-lg)" }}>
            <h3 id="proration-title" style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)" }}>Prorrateo del crédito fiscal</h3>
            <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-md)" }}>
                Igual que en los datos iniciales de IVA Simple. Con prorrateo global, las compras se importan con todo el IVA sujeto a prorrateo y la
                liquidación aplica el coeficiente del período (sin coeficiente no se puede calcular).
            </p>
            <p style={{ marginBottom: "var(--spacing-sm)" }}>
                Modalidad: <strong>{PRORATION_MODE_LABELS[mode]}</strong>
                {usesGlobalCoefficient(mode) && <> · Coeficiente: <strong>{coefficient ? `${coefficient.replace(".", ",")} (${COEFFICIENT_STATUS_LABELS[status ?? "PROVISIONAL"].toLowerCase()})` : "sin cargar"}</strong></>}
            </p>
            {canEdit && (
                <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap", alignItems: "flex-end" }}>
                    <label>
                        <span style={{ display: "block" }}>Modalidad</span>
                        <select className="input" value={draftMode} disabled={saving} onChange={(e) => setDraftMode(e.target.value as ProrationMode)}>
                            {PRORATION_MODES.map((m) => <option key={m} value={m}>{PRORATION_MODE_LABELS[m]}</option>)}
                        </select>
                    </label>
                    {global && (
                        <>
                            <label>
                                <span style={{ display: "block" }}>Coeficiente (0 a 1)</span>
                                <input className="input" inputMode="decimal" placeholder="0,5132" value={draftCoefficient} disabled={saving} onChange={(e) => setDraftCoefficient(e.target.value)} style={{ width: 140 }} />
                            </label>
                            <label>
                                <span style={{ display: "block" }}>Estado</span>
                                <select className="input" value={draftStatus} disabled={saving} onChange={(e) => setDraftStatus(e.target.value as CoefficientStatus)}>
                                    {COEFFICIENT_STATUSES.map((s) => <option key={s} value={s}>{COEFFICIENT_STATUS_LABELS[s]}</option>)}
                                </select>
                            </label>
                        </>
                    )}
                    <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Guardando..." : "Guardar"}</button>
                </div>
            )}
            {error && <p role="alert" style={{ marginTop: "var(--spacing-sm)", color: "var(--error)" }}>{error}</p>}
            {saved && !error && <p role="status" style={{ marginTop: "var(--spacing-sm)", color: "var(--success)" }}>Prorrateo guardado.</p>}
        </section>
    );
}
