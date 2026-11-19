"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Datos de la DDJJ de IIBB que carga el estudio (renglones del F.5680 que la app
 * no calcula) y la DDJJ efectivamente presentada, para controlarla contra el
 * cálculo. La API vuelve a exigir rol, alcance y período abierto.
 */

export interface IibbPositionValues {
    previousBalance: string;
    paymentsOnAccount: string;
    otherCredits: string;
    otherDebits: string;
    reference: string;
    filedVerifier: string;
    filedDate: string;
    filedTaxAmount: string;
    filedDeductionsAmount: string;
    filedBalanceDgr: string;
    filedBalanceTaxpayer: string;
}

const GENERIC_ERROR = "No se pudo guardar. Probá de nuevo.";

const AMOUNTS: [keyof IibbPositionValues, string][] = [
    ["previousBalance", "Saldo a favor de períodos anteriores"],
    ["paymentsOnAccount", "Total de pagos a cuenta"],
    ["otherCredits", "Otros créditos"],
    ["otherDebits", "Otros débitos"],
];
const FILED: [keyof IibbPositionValues, string][] = [
    ["filedTaxAmount", "Total liquidación del impuesto"],
    ["filedDeductionsAmount", "Total deducciones"],
    ["filedBalanceDgr", "Saldo a favor de DGR"],
    ["filedBalanceTaxpayer", "Saldo a favor del contribuyente"],
];

export function IibbPositionForm({ periodId, canEdit, initial }: { periodId: string; canEdit: boolean; initial: IibbPositionValues }) {
    const router = useRouter();
    const [v, setV] = useState(initial);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    const inFlight = useRef(false);
    const set = (k: keyof IibbPositionValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));

    async function save(e: React.FormEvent) {
        e.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true;
        setLoading(true);
        setError("");
        setSaved(false);
        // «1.938.379,63» o «1938379.63».
        const amount = (s: string) => {
            const t = s.trim();
            if (t === "") return null;
            return t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
        };
        const txt = (s: string) => (s.trim() === "" ? null : s.trim());
        const body = {
            previousBalance: amount(v.previousBalance) ?? "0",
            paymentsOnAccount: amount(v.paymentsOnAccount) ?? "0",
            otherCredits: amount(v.otherCredits) ?? "0",
            otherDebits: amount(v.otherDebits) ?? "0",
            reference: txt(v.reference),
            filedVerifier: txt(v.filedVerifier),
            filedDate: txt(v.filedDate),
            filedTaxAmount: amount(v.filedTaxAmount),
            filedDeductionsAmount: amount(v.filedDeductionsAmount),
            filedBalanceDgr: amount(v.filedBalanceDgr),
            filedBalanceTaxpayer: amount(v.filedBalanceTaxpayer),
        };
        try {
            const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/iibb-position`, {
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

    const row = (k: keyof IibbPositionValues, label: string, type = "text") => (
        <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr 12rem", gap: "var(--spacing-sm)", alignItems: "center", marginBottom: "var(--spacing-xs)" }}>
            <label htmlFor={`iibbp-${k}`}>{label}</label>
            <input id={`iibbp-${k}`} className="input" type={type} inputMode={type === "text" && k !== "filedVerifier" ? "decimal" : undefined} value={v[k]} onChange={set(k)} maxLength={k === "filedVerifier" ? 20 : 30} />
        </div>
    );

    return (
        <form className="card" onSubmit={save} aria-busy={loading} aria-labelledby="iibbp-title" style={{ marginBottom: "var(--spacing-xl)" }}>
            <h2 id="iibbp-title" style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
                Datos de la DDJJ de IIBB
            </h2>
            <p style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-md)" }}>
                Renglones que la app no calcula (se toman de la DDJJ anterior y de los pagos del período) y, una vez
                presentada, los totales del formulario para controlarlos contra el cálculo.
            </p>
            <fieldset disabled={!canEdit || loading} style={{ border: 0, padding: 0, margin: 0 }}>
                {AMOUNTS.map(([k, label]) => row(k, label))}
                <div style={{ marginBottom: "var(--spacing-md)" }}>
                    <input className="input" aria-label="Referencia del saldo anterior" placeholder="Referencia (p. ej. DDJJ 09/2026, verificador)" value={v.reference} maxLength={120} onChange={set("reference")} style={{ width: "100%" }} />
                </div>
                <h3 style={{ fontSize: "1rem", fontWeight: 600, margin: "var(--spacing-md) 0 var(--spacing-sm)" }}>DDJJ presentada</h3>
                {row("filedVerifier", "N° verificador")}
                {row("filedDate", "Fecha de presentación", "date")}
                {FILED.map(([k, label]) => row(k, label))}
                {canEdit && (
                    <button type="submit" className="btn btn-primary" style={{ marginTop: "var(--spacing-md)" }}>
                        {loading ? "Guardando…" : "Guardar"}
                    </button>
                )}
            </fieldset>
            {error && <p role="alert" style={{ color: "var(--error)", marginTop: "var(--spacing-sm)" }}>{error}</p>}
            {saved && !error && <p role="status" style={{ color: "var(--success)", marginTop: "var(--spacing-sm)" }}>Guardado.</p>}
        </form>
    );
}
