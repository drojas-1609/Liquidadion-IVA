"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMoney } from "@/lib/format";

type Kind = "IIBB_PERCEPTION" | "INTERNAL_TAXES" | "OTHER";
export interface OtherTaxesRow {
    supplierCuit: string;
    name: string;
    invoices: number;
    otherTaxes: string;
    taxedNet: string;
    percent: string;
    rule: Kind | null;
}

const LABELS: Record<Kind, string> = {
    IIBB_PERCEPTION: "Percepción de IIBB",
    INTERNAL_TAXES: "Impuestos internos",
    OTHER: "Dejar como otros tributos",
};

/**
 * «Otros tributos» sin imputar, por proveedor. La percepción de IVA informada
 * por ARCA ya se separó sola; acá se define a qué va el resto. La regla vale
 * para este y los próximos períodos del cliente.
 */
export function OtherTaxesRules({ periodId, rows, canEdit }: { periodId: string; rows: OtherTaxesRow[]; canEdit: boolean }) {
    const router = useRouter();
    const [choice, setChoice] = useState<Record<string, Kind | "">>(Object.fromEntries(rows.map((r) => [r.supplierCuit, r.rule ?? ""])));
    const [busy, setBusy] = useState<string | null>(null);
    const [message, setMessage] = useState("");

    async function save(cuit: string) {
        const kind = choice[cuit];
        if (!kind) return;
        setBusy(cuit);
        setMessage("");
        try {
            const response = await fetch(`/api/periods/${encodeURIComponent(periodId)}/other-taxes-rule`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ supplierCuit: cuit, kind }),
            });
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error(body?.error?.message ?? "No se pudo guardar la regla.");
            setMessage(`Regla guardada: ${body.changes} cambios en el período.`);
            router.refresh();
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "No se pudo guardar la regla.");
        } finally {
            setBusy(null);
        }
    }

    if (rows.length === 0) return null;
    return (
        <section className="card stack" style={{ marginBottom: "var(--spacing-lg)" }} aria-label="Otros tributos sin imputar">
            <div className="section-head" style={{ marginBottom: 0 }}>
                <div>
                    <h2>«Otros tributos» sin imputar</h2>
                    <p>
                        Portal IVA informa percepciones e impuestos juntos. La percepción de IVA que informó ARCA ya se separó sola;
                        definí a qué corresponde el resto de cada proveedor. La regla se aplica a este y a los próximos períodos.
                        Controlá contra los comprobantes físicos.
                    </p>
                </div>
            </div>
            <div className="table-wrap">
                <table className="data-table">
                    <thead>
                        <tr><th>Proveedor</th><th className="num">Comprobantes</th><th className="num">Otros tributos</th><th className="num">% del neto</th><th>Imputar el resto a</th>{canEdit && <th />}</tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.supplierCuit}>
                                <td>{r.name}<div className="muted text-sm">{r.supplierCuit}</div></td>
                                <td className="num">{r.invoices}</td>
                                <td className="num">${formatMoney(r.otherTaxes)}</td>
                                <td className="num">{r.percent ? `${r.percent.replace(".", ",")} %` : "—"}</td>
                                <td>
                                    <select aria-label={`Imputación de otros tributos de ${r.name}`} value={choice[r.supplierCuit] ?? ""} disabled={!canEdit || busy !== null}
                                        onChange={(e) => setChoice({ ...choice, [r.supplierCuit]: e.target.value as Kind | "" })}>
                                        <option value="">Sin regla</option>
                                        {(Object.keys(LABELS) as Kind[]).map((k) => <option key={k} value={k}>{LABELS[k]}</option>)}
                                    </select>
                                </td>
                                {canEdit && (
                                    <td>
                                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null || !choice[r.supplierCuit] || choice[r.supplierCuit] === r.rule}
                                            onClick={() => void save(r.supplierCuit)}>
                                            {busy === r.supplierCuit ? "Aplicando…" : "Guardar regla"}
                                        </button>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {message && <p role="status" className="callout callout-info">{message}</p>}
        </section>
    );
}
