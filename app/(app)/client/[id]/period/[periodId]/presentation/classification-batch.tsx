"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    BUYER_TYPES,
    BUYER_TYPE_LABELS,
    CLASSIFIABLE_OPERATION_CODES,
    CLASSIFICATION_BATCH_MAX,
    PURCHASE_CREDIT_CONCEPTS,
    PURCHASE_CREDIT_CONCEPT_LABELS,
    SALE_OPERATION_TYPES,
    SALE_OPERATION_TYPE_LABELS,
} from "@/lib/vat-export/classification-input";

/**
 * Clasificación por lote de los comprobantes pendientes. Sólo se envían los
 * campos que la persona elige cambiar ("sin cambios" no toca nada); nada se
 * completa solo. La API vuelve a validar rol, alcance, período abierto,
 * categoría y que la actividad esté en la ficha del cliente. Se envía en tandas
 * de hasta 500 comprobantes.
 */

export interface ClassificationRow {
    id: string;
    category: "SALES" | "PURCHASES";
    label: string;
    counterparty: string;
    total: string;
    missing: string[];
    activityCode: string | null;
    saleOperationType: string | null;
    buyerType: string | null;
    derivedBuyerType: string | null;
    purchaseCreditConcept: string | null;
    operationCode: string | null;
    dationInPayment: boolean;
}

const OPERATION_CODE_LABELS: Record<string, string> = {
    A: "A · No alcanzado", C: "C · Operación de canje", D: "D · Devol. IVA turistas extranjeros", E: "E · Exenta",
    N: "N · No gravada", T: "T · Reintegro Decreto 1043/2016", X: "X · Exterior (exportación / importación)", Z: "Z · Zona franca",
};

const KEEP = "__keep__";
const CLEAR = "__clear__";
const GENERIC_ERROR = "No se pudo aplicar la clasificación. Probá de nuevo.";

export function ClassificationBatch({ periodId, canEdit, rows, activities }: { periodId: string; canEdit: boolean; rows: ClassificationRow[]; activities: { code: string; description: string }[] }) {
    const router = useRouter();
    const [tab, setTab] = useState<"SALES" | "PURCHASES">(rows.some((r) => r.category === "SALES") ? "SALES" : "PURCHASES");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [activity, setActivity] = useState(KEEP);
    const [opType, setOpType] = useState(KEEP);
    const [buyer, setBuyer] = useState(KEEP);
    const [concept, setConcept] = useState(KEEP);
    const [opCode, setOpCode] = useState(KEEP);
    const [dation, setDation] = useState(KEEP);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
    const inFlight = useRef(false);

    const visible = useMemo(() => rows.filter((r) => r.category === tab), [rows, tab]);
    const selectedVisible = visible.filter((r) => selected.has(r.id));
    const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const selectAll = (on: boolean) => setSelected((s) => { const n = new Set(s); for (const r of visible) { if (on) n.add(r.id); else n.delete(r.id); } return n; });

    function changes(): Record<string, unknown> {
        const c: Record<string, unknown> = {};
        const put = (key: string, v: string) => { if (v === KEEP) return; c[key] = v === CLEAR ? null : v; };
        if (tab === "SALES") {
            put("activityCode", activity);
            put("saleOperationType", opType);
            put("buyerType", buyer);
            if (dation !== KEEP) c.dationInPayment = dation === "yes";
        } else put("purchaseCreditConcept", concept);
        put("operationCode", opCode);
        return c;
    }

    async function apply() {
        if (inFlight.current) return;
        const ids = selectedVisible.map((r) => r.id);
        const c = changes();
        if (ids.length === 0 || Object.keys(c).length === 0) {
            setMessage({ tone: "alert", text: "Elegí comprobantes y al menos un dato para clasificar." });
            return;
        }
        inFlight.current = true;
        setBusy(true);
        setMessage(null);
        let done = 0;
        try {
            for (let i = 0; i < ids.length; i += CLASSIFICATION_BATCH_MAX) {
                const res = await fetch(`/api/periods/${encodeURIComponent(periodId)}/invoice-classification`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ invoiceIds: ids.slice(i, i + CLASSIFICATION_BATCH_MAX), changes: c }),
                });
                const json: unknown = await res.json().catch(() => null);
                if (!res.ok) {
                    const err = (json as { error?: { message?: unknown } } | null)?.error?.message;
                    setMessage({ tone: "alert", text: `${done > 0 ? `Se clasificaron ${done}. ` : ""}${typeof err === "string" && err.length < 300 ? err : GENERIC_ERROR}` });
                    return;
                }
                done += (json as { updated?: number } | null)?.updated ?? 0;
            }
            setMessage({ tone: "status", text: `Clasificados ${done} comprobantes.` });
            setSelected(new Set());
            router.refresh();
        } catch {
            setMessage({ tone: "alert", text: `${done > 0 ? `Se clasificaron ${done}. ` : ""}${GENERIC_ERROR}` });
        } finally {
            inFlight.current = false;
            setBusy(false);
            if (done > 0) router.refresh();
        }
    }

    const sel = (label: string, value: string, set: (v: string) => void, options: [string, string][]) => (
        <label style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", minWidth: "220px", flex: "1 1 220px" }}>
            <span style={{ fontSize: "0.875rem" }}>{label}</span>
            <select value={value} onChange={(e) => set(e.target.value)} disabled={!canEdit || busy}>
                <option value={KEEP}>Sin cambios</option>
                {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                <option value={CLEAR}>Quitar (dejar pendiente)</option>
            </select>
        </label>
    );

    const counts = { SALES: rows.filter((r) => r.category === "SALES").length, PURCHASES: rows.filter((r) => r.category === "PURCHASES").length };
    return (
        <div>
            <div role="tablist" style={{ display: "flex", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-md)" }}>
                {(["SALES", "PURCHASES"] as const).map((t) => (
                    <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "btn btn-primary" : "btn btn-secondary"} onClick={() => setTab(t)}>
                        {t === "SALES" ? "Ventas" : "Compras"} ({counts[t]})
                    </button>
                ))}
            </div>

            {canEdit ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--spacing-md)", alignItems: "flex-end", marginBottom: "var(--spacing-md)" }}>
                    {tab === "SALES" && (
                        <>
                            {activities.length === 0 ? (
                                <p role="note" style={{ flex: "1 1 100%", color: "var(--error)" }}>La ficha del cliente no tiene actividades con nomenclador ARCA: cargalas en la ficha para poder asignarlas.</p>
                            ) : sel("Actividad (ARCA)", activity, setActivity, activities.map((a) => [a.code, `${a.code} · ${a.description}`]))}
                            {sel("Tipo de operación (parte gravada)", opType, setOpType, SALE_OPERATION_TYPES.map((v) => [v, SALE_OPERATION_TYPE_LABELS[v]]))}
                            {sel("Tipo de sujeto comprador", buyer, setBuyer, BUYER_TYPES.map((v) => [v, BUYER_TYPE_LABELS[v]]))}
                            <label style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)", minWidth: "220px", flex: "1 1 220px" }}>
                                <span style={{ fontSize: "0.875rem" }}>Dación en pago (Decreto 1145/09)</span>
                                <select value={dation} onChange={(e) => setDation(e.target.value)} disabled={busy}>
                                    <option value={KEEP}>Sin cambios</option>
                                    <option value="no">No</option>
                                    <option value="yes">Sí (beneficiarios del régimen)</option>
                                </select>
                            </label>
                        </>
                    )}
                    {tab === "PURCHASES" && sel("Concepto del crédito fiscal", concept, setConcept, PURCHASE_CREDIT_CONCEPTS.map((v) => [v, PURCHASE_CREDIT_CONCEPT_LABELS[v]]))}
                    {sel("Código de operación (sólo al 0 % o sin IVA)", opCode, setOpCode, CLASSIFIABLE_OPERATION_CODES.map((v) => [v, OPERATION_CODE_LABELS[v]]))}
                    <button type="button" className="btn btn-primary" disabled={busy || selectedVisible.length === 0} aria-busy={busy} onClick={apply}>
                        {busy ? "Aplicando…" : `Aplicar a ${selectedVisible.length} seleccionados`}
                    </button>
                </div>
            ) : (
                <p role="note" style={{ marginBottom: "var(--spacing-md)", color: "var(--secondary)" }}>Sólo lectura: el período está cerrado o tu rol no permite editar.</p>
            )}

            {message && (
                <div role={message.tone} style={{ marginBottom: "var(--spacing-sm)", color: message.tone === "alert" ? "var(--error)" : "var(--success)" }}>{message.text}</div>
            )}

            <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                    <thead>
                        <tr>
                            <th style={{ textAlign: "left" }}>
                                {canEdit && <input type="checkbox" aria-label="Seleccionar todos los visibles" checked={visible.length > 0 && selectedVisible.length === visible.length} onChange={(e) => selectAll(e.target.checked)} />}
                            </th>
                            <th style={{ textAlign: "left" }}>Comprobante</th>
                            <th style={{ textAlign: "left" }}>Contraparte</th>
                            <th style={{ textAlign: "right" }}>Total</th>
                            <th style={{ textAlign: "left" }}>Pendiente</th>
                            <th style={{ textAlign: "left" }}>Clasificación actual</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((r) => (
                            <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                                <td>{canEdit && <input type="checkbox" aria-label={`Seleccionar ${r.label}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />}</td>
                                <td style={{ whiteSpace: "nowrap" }}>{r.label}</td>
                                <td>{r.counterparty}</td>
                                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>${r.total}</td>
                                <td style={{ color: "var(--error)" }}>{r.missing.join(" · ")}</td>
                                <td style={{ color: "var(--secondary)" }}>
                                    {r.category === "SALES"
                                        ? [r.activityCode ?? "sin actividad", r.saleOperationType ? SALE_OPERATION_TYPE_LABELS[r.saleOperationType as keyof typeof SALE_OPERATION_TYPE_LABELS] : "sin tipo", r.buyerType ? BUYER_TYPE_LABELS[r.buyerType as keyof typeof BUYER_TYPE_LABELS] : r.derivedBuyerType ? `${BUYER_TYPE_LABELS[r.derivedBuyerType as keyof typeof BUYER_TYPE_LABELS]} (por su condición frente al IVA)` : "sin sujeto", r.dationInPayment ? "dación en pago" : null].filter(Boolean).join(" · ")
                                        : r.purchaseCreditConcept ? PURCHASE_CREDIT_CONCEPT_LABELS[r.purchaseCreditConcept as keyof typeof PURCHASE_CREDIT_CONCEPT_LABELS] : "sin concepto"}
                                    {r.operationCode ? ` · operación ${r.operationCode}` : ""}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
