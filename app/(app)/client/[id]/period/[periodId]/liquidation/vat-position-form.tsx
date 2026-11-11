"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./vat-position-form.module.css";

/**
 * Datos de la posición de IVA que carga el estudio, con los nombres del F.2051 y
 * del Portal IVA (Ajustes al Crédito Fiscal). La API vuelve a exigir rol,
 * módulo IVA, alcance de clientes y período abierto. La app no calcula el
 * crédito computable: muestra el porcentaje que resulta, como control.
 */

export interface VatPositionFormRow {
    regime: "LEY_27541_ANEXO_I" | "LEY_27467_ART_91";
    label: string;
    contributionsAmount: string;
    computableAmount: string;
    reference: string;
}

interface Props {
    periodId: string;
    canEdit: boolean;
    previousTechnicalBalance: string;
    previousTechnicalBalanceReference: string;
    previousFreeBalance: string;
    previousFreeBalanceReference: string;
    rows: VatPositionFormRow[];
}

const GENERIC_ERROR = "No se pudo guardar. Probá de nuevo.";

function ratio(contributions: string, computable: string): string {
    const c = Number(contributions.replace(",", "."));
    const k = Number(computable.replace(",", "."));
    if (!Number.isFinite(c) || !Number.isFinite(k) || c <= 0 || k <= 0) return "";
    // Sólo informativo (no entra en ningún cálculo).
    return `${((k / c) * 100).toFixed(2).replace(".", ",")} %`;
}


export function VatPositionForm({ periodId, canEdit, previousTechnicalBalance, previousTechnicalBalanceReference, previousFreeBalance, previousFreeBalanceReference, rows }: Props) {
    const router = useRouter();
    const [prev, setPrev] = useState(previousTechnicalBalance);
    const [prevRef, setPrevRef] = useState(previousTechnicalBalanceReference);
    const [free, setFree] = useState(previousFreeBalance);
    const [freeRef, setFreeRef] = useState(previousFreeBalanceReference);
    const [values, setValues] = useState(rows);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    const inFlight = useRef(false);

    const update = (i: number, patch: Partial<VatPositionFormRow>) =>
        setValues((v) => v.map((r, j) => (j === i ? { ...r, ...patch } : r)));

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true;
        setLoading(true);
        setError("");
        setSaved(false);
        const toAmount = (s: string) => (s.trim() === "" ? "0" : s.trim().replace(",", "."));
        const body = {
            previousTechnicalBalance: toAmount(prev),
            previousTechnicalBalanceReference: prevRef.trim() === "" ? null : prevRef.trim(),
            previousFreeBalance: toAmount(free),
            previousFreeBalanceReference: freeRef.trim() === "" ? null : freeRef.trim(),
            adjustments: values
                .filter((r) => toAmount(r.contributionsAmount) !== "0" || toAmount(r.computableAmount) !== "0")
                .map((r) => ({
                    regime: r.regime,
                    contributionsAmount: toAmount(r.contributionsAmount),
                    computableAmount: toAmount(r.computableAmount),
                    reference: r.reference.trim() === "" ? null : r.reference.trim(),
                })),
        };
        try {
            const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/vat-position`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json: unknown = await res.json().catch(() => null);
            if (!res.ok) {
                const err = (json as { error?: unknown } | null)?.error;
                const msg = typeof err === "string" ? err : (err as { message?: unknown } | undefined)?.message;
                setError(typeof msg === "string" && msg.length > 0 && msg.length < 300 ? msg : GENERIC_ERROR);
            } else {
                setSaved(true);
                router.refresh();
            }
        } catch {
            setError(GENERIC_ERROR);
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }

    return (
        <form className="card" onSubmit={save} aria-busy={loading} aria-labelledby="vat-position-title" style={{ marginBottom: "var(--spacing-xl)" }}>
            <h2 id="vat-position-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                Ajustes y saldos de la posición de IVA
            </h2>
            <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-md)" }}>
                Se cargan desde la DJ anterior (F.2051) y el F.931 del período. El crédito computable lo informa el estudio
                según el régimen que corresponda; el porcentaje se muestra sólo como control.
            </p>

            <fieldset disabled={!canEdit || loading} className={styles.fields}>
                <section aria-labelledby="vp-balances" className={styles.section}>
                    <h3 id="vp-balances">Saldos del período anterior</h3>
                    <div className={styles.balance}>
                        <label htmlFor="vp-prev">Saldo técnico a favor del contribuyente</label>
                        <input id="vp-prev" className="input" inputMode="decimal" value={prev} onChange={(e) => setPrev(e.target.value)} />
                        <input className="input" aria-label="Referencia del saldo anterior" placeholder="Referencia (DJ anterior)" value={prevRef} maxLength={120} onChange={(e) => setPrevRef(e.target.value)} />
                    </div>
                    <div className={styles.balance}>
                        <label htmlFor="vp-free">Saldo a favor de libre disponibilidad (neto de usos)</label>
                        <input id="vp-free" className="input" inputMode="decimal" value={free} onChange={(e) => setFree(e.target.value)} />
                        <input className="input" aria-label="Referencia del saldo de libre disponibilidad" placeholder="Referencia (DJ anterior)" value={freeRef} maxLength={120} onChange={(e) => setFreeRef(e.target.value)} />
                    </div>
                </section>

                <section aria-labelledby="vp-adjustments" className={styles.section}>
                    <h3 id="vp-adjustments">Ajustes al crédito fiscal</h3>
                    {values.map((r, i) => (
                        <fieldset key={r.regime} className={styles.adjustment}>
                            <legend>{r.label}</legend>
                            <div className={styles.amounts}>
                                <label>
                                    Crédito fiscal
                                    <input className="input" inputMode="decimal" value={r.contributionsAmount} onChange={(e) => update(i, { contributionsAmount: e.target.value })} />
                                </label>
                                <label>
                                    Crédito fiscal computable
                                    <input className="input" inputMode="decimal" value={r.computableAmount} onChange={(e) => update(i, { computableAmount: e.target.value })} />
                                </label>
                                <div>
                                    <span>Porcentaje de control</span>
                                    <output>{ratio(r.contributionsAmount, r.computableAmount) || "—"}</output>
                                </div>
                            </div>
                            <label className={styles.reference}>
                                Referencia (F.931)
                                <input className="input" value={r.reference} maxLength={120} onChange={(e) => update(i, { reference: e.target.value })} />
                            </label>
                        </fieldset>
                    ))}
                </section>
                <p style={{ color: "var(--secondary)", fontSize: "0.8125rem", marginTop: "var(--spacing-sm)" }}>
                    Art. 91 Ley 27.467 (radiodifusión, señales y editoras): se computa antes que los demás créditos y hasta el
                    débito fiscal del período, sin generar saldo a favor. Anexo I Ley 27.541: se suma al crédito fiscal.
                </p>

                {canEdit && (
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                        {loading && <span role="status">Guardando...</span>}
                        <button type="submit" className="btn btn-primary">Guardar</button>
                    </div>
                )}
            </fieldset>

            {error && (
                <div role="alert" style={{ marginTop: "var(--spacing-sm)", padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                    {error}
                </div>
            )}
            {saved && !error && (
                <p role="status" style={{ marginTop: "var(--spacing-sm)", color: "var(--success)" }}>Guardado.</p>
            )}
        </form>
    );
}
