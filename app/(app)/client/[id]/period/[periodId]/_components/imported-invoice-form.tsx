"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatPeriodLabel } from "@/lib/period";
import { DOCUMENT_TYPES, VAT_CONDITIONS, VAT_RATES } from "@/lib/arca/catalogs";
import { BUYER_TYPE_LABELS, PURCHASE_CREDIT_CONCEPT_LABELS, SALE_OPERATION_TYPE_LABELS } from "@/lib/vat-export/classification-input";
import {
    DETAILED_AMOUNT_LABELS,
    buildDetailedBody,
    previewTotal,
    submitDetailedEdit,
    type DetailedAmountKey,
    type ImportedInvoiceEditData,
    type ImportedLineValues,
} from "@/lib/imported-invoice-form";
import { invoiceListHref } from "@/lib/invoice-form-client";
import { CounterpartyArcaLookup } from "./counterparty-arca-lookup";

/**
 * Corrección de un comprobante IMPORTADO con TODOS sus datos: varias
 * alícuotas, exento, no gravado, percepciones, tributos, código de operación y
 * crédito por línea. La identidad (tipo, punto de venta, número, documento de
 * la contraparte) es fija: con ella la importación lo reconoce como «ya
 * cargado» y no sobrescribe la corrección. Las clasificaciones de la
 * presentación se muestran y se conservan (se editan en «Presentación ARCA»).
 */

const OPERATION_CODES: Array<[string, string]> = [
    ["A", "A · No alcanzado"], ["C", "C · Operación de canje"], ["D", "D · Devol. IVA turistas extranjeros"], ["E", "E · Exenta"],
    ["N", "N · No gravada"], ["T", "T · Reintegro Decreto 1043/2016"], ["X", "X · Exterior (exportación / importación)"], ["Z", "Z · Zona franca"],
];
const ALLOCATION_LABELS: Record<string, string> = {
    DIRECT_COMPUTABLE: "Computable (asignación directa)",
    DIRECT_NON_COMPUTABLE: "No computable",
    GLOBAL_PRORATION: "Sujeto a prorrateo global",
};
const LABEL = { display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 } as const;
const HELP = { display: "block", marginTop: "var(--spacing-xs)", fontSize: "0.8rem", color: "var(--secondary)" } as const;
const INFO = { gridColumn: "1 / -1", padding: "var(--spacing-sm)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" } as const;
const ALERT = { gridColumn: "1 / -1", padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" } as const;

export function ImportedInvoiceForm(props: {
    clientId: string;
    periodId: string;
    clientName: string;
    period: { month: number; year: number };
    detail: ImportedInvoiceEditData;
}) {
    const { clientId, periodId, clientName, period, detail } = props;
    const router = useRouter();
    const { category, identity } = detail;
    const listHref = invoiceListHref(category, clientId, periodId);
    const [values, setValues] = useState(detail.values);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ field: string | null; message: string; stale: boolean } | null>(null);
    const inFlight = useRef(false);
    const purchases = category === "PURCHASES";
    const total = previewTotal(values);

    const setAmount = (k: DetailedAmountKey, v: string) => { setValues((p) => ({ ...p, amounts: { ...p.amounts, [k]: v } })); setError(null); };
    const setLine = (i: number, patch: Partial<ImportedLineValues>) => {
        setValues((p) => ({ ...p, vatLines: p.vatLines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
        setError(null);
    };
    const addLine = () => setValues((p) => ({
        ...p,
        vatLines: [...p.vatLines, { vatRateCode: 5, netAmount: "0.00", vatAmount: "0.00", creditAllocation: purchases ? "DIRECT_COMPUTABLE" : "NOT_APPLICABLE", computableVatAmount: purchases ? "0.00" : null }],
    }));
    const removeLine = (i: number) => setValues((p) => ({ ...p, vatLines: p.vatLines.filter((_, j) => j !== i) }));
    const fieldError = (f: string) => (error && error.field !== null && (error.field === f || error.field.startsWith(`${f}.`)) ? <span role="alert" style={{ ...HELP, color: "var(--error)" }}>{error.message}</span> : null);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        try {
            const result = await submitDetailedEdit(detail.invoiceId, buildDetailedBody(values, detail.updatedAt, category));
            if (!result.ok) {
                setError(result);
                return;
            }
            router.push(listHref);
            router.refresh();
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    }

    const docLabel = DOCUMENT_TYPES.find((d) => d.code === identity.docType)?.label ?? String(identity.docType);
    const amountKeys = (Object.keys(DETAILED_AMOUNT_LABELS) as DetailedAmountKey[]).filter((k) => k !== "turivaRefundAmount" || identity.lidSection === "TURIVA");
    const c = detail.classifications;

    return (
        <div className="container" style={{ maxWidth: "900px" }}>
            <Link href={listHref} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>&larr; Volver</Link>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-xs)" }}>Corregir {purchases ? "compra" : "venta"} importada</h1>
            <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>{clientName} · Período {formatPeriodLabel(period)}</p>

            <form onSubmit={onSubmit} className="card" aria-busy={busy} noValidate style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--spacing-md)" }}>
                <div role="note" style={INFO}>
                    <strong>Comprobante importado.</strong> Tipo, punto de venta, número y documento de la contraparte identifican el comprobante en ARCA y no se modifican acá:
                    si están mal, eliminalo y cargalo de nuevo. Si volvés a importar el archivo, este comprobante figura como «ya cargado» y la importación no sobrescribe esta corrección.
                </div>
                {error && error.field === null && (
                    <div role="alert" style={ALERT}>
                        {error.message}
                        {error.stale && <> <button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>Recargar datos</button></>}
                    </div>
                )}
                {error && error.field !== null && <div role="alert" style={ALERT}>{error.message}</div>}

                <dl style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "var(--spacing-sm)", margin: 0 }}>
                    <div><dt style={HELP}>Comprobante</dt><dd style={{ margin: 0 }}>{identity.voucherLabel}</dd></div>
                    <div><dt style={HELP}>Número</dt><dd style={{ margin: 0 }}>{String(identity.pointOfSale).padStart(5, "0")}-{String(identity.number).padStart(8, "0")}</dd></div>
                    <div><dt style={HELP}>Documento de la contraparte</dt><dd style={{ margin: 0 }}>{docLabel} {identity.docNumber}</dd></div>
                    <div><dt style={HELP}>Pestaña · moneda</dt><dd style={{ margin: 0 }}>{identity.lidSection} · {identity.currencyCode}</dd></div>
                    <div><dt style={HELP}>Procedencia</dt><dd style={{ margin: 0 }}>Importado</dd></div>
                </dl>

                <div>
                    <label htmlFor="imp-date" style={LABEL}>Fecha</label>
                    <input id="imp-date" type="date" className="input" value={values.voucherDate} disabled={busy} onChange={(e) => { setValues((p) => ({ ...p, voucherDate: e.target.value })); setError(null); }} />
                    {fieldError("voucherDate")}
                </div>
                <div>
                    <label htmlFor="imp-name" style={LABEL}>{purchases ? "Proveedor" : "Cliente"} (razón social)</label>
                    <input id="imp-name" type="text" className="input" value={values.counterpartyName} disabled={busy} maxLength={200} onChange={(e) => { setValues((p) => ({ ...p, counterpartyName: e.target.value })); setError(null); }} />
                    {fieldError("counterpartyName")}
                </div>
                <CounterpartyArcaLookup
                    docType={identity.docType}
                    docNumber={identity.docNumber}
                    currentName={values.counterpartyName}
                    disabled={busy}
                    onApplyName={(name) => { setValues((p) => ({ ...p, counterpartyName: name })); setError(null); }}
                />
                <div>
                    <label htmlFor="imp-cond" style={LABEL}>Condición frente al IVA de la contraparte</label>
                    <select id="imp-cond" className="input" disabled={busy} value={values.counterpartyVatConditionCode ?? ""} onChange={(e) => setValues((p) => ({ ...p, counterpartyVatConditionCode: e.target.value === "" ? null : Number(e.target.value) }))}>
                        <option value="">Sin informar (el archivo no la trae)</option>
                        {VAT_CONDITIONS.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
                    </select>
                </div>
                <div>
                    <label htmlFor="imp-op" style={LABEL}>Código de operación</label>
                    <select id="imp-op" className="input" disabled={busy} value={values.operationCode ?? ""} onChange={(e) => { setValues((p) => ({ ...p, operationCode: e.target.value === "" ? null : e.target.value })); setError(null); }}>
                        <option value="">Sin código</option>
                        {OPERATION_CODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {fieldError("operationCode")}
                </div>

                <fieldset style={{ gridColumn: "1 / -1", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--spacing-sm)" }}>
                    <legend>Alícuotas de IVA</legend>
                    {values.vatLines.length === 0 && <p style={HELP}>Sin líneas de alícuota.</p>}
                    {values.vatLines.map((l, i) => (
                        <div key={i} style={{ display: "grid", gridTemplateColumns: purchases ? "1fr 1fr 1fr 1.4fr 1fr auto" : "1fr 1fr 1fr auto", gap: "var(--spacing-xs)", alignItems: "end", marginBottom: "var(--spacing-xs)" }}>
                            <label>Alícuota
                                <select className="input" disabled={busy} value={l.vatRateCode} onChange={(e) => setLine(i, { vatRateCode: Number(e.target.value) })}>
                                    {VAT_RATES.map((r) => <option key={r.code} value={r.code}>{r.rate} %</option>)}
                                </select>
                            </label>
                            <label>Neto gravado<input className="input" inputMode="decimal" disabled={busy} value={l.netAmount} onChange={(e) => setLine(i, { netAmount: e.target.value })} /></label>
                            <label>IVA<input className="input" inputMode="decimal" disabled={busy} value={l.vatAmount} onChange={(e) => setLine(i, { vatAmount: e.target.value })} /></label>
                            {purchases && (
                                <label>Atribución del crédito
                                    <select className="input" disabled={busy} value={l.creditAllocation} onChange={(e) => setLine(i, { creditAllocation: e.target.value, computableVatAmount: e.target.value === "GLOBAL_PRORATION" ? null : e.target.value === "DIRECT_NON_COMPUTABLE" ? "0.00" : l.vatAmount })}>
                                        {Object.entries(ALLOCATION_LABELS).map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
                                    </select>
                                </label>
                            )}
                            {purchases && (
                                <label>Computable<input className="input" inputMode="decimal" disabled={busy || l.creditAllocation !== "DIRECT_COMPUTABLE"} value={l.computableVatAmount ?? ""} onChange={(e) => setLine(i, { computableVatAmount: e.target.value })} /></label>
                            )}
                            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => removeLine(i)} aria-label={`Quitar la alícuota ${i + 1}`}>Quitar</button>
                            <div style={{ gridColumn: "1 / -1" }}>{fieldError(`vatLines.${i}`)}</div>
                        </div>
                    ))}
                    {fieldError("vatLines")}
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={addLine}>Agregar alícuota</button>
                    <span style={HELP}>Prorrateo del crédito del período: {detail.prorationMode}. El IVA de cada línea debe corresponder a su alícuota (tolerancia 0,01).</span>
                </fieldset>

                {amountKeys.map((k) => (
                    <div key={k}>
                        <label htmlFor={`imp-${k}`} style={LABEL}>{DETAILED_AMOUNT_LABELS[k]}</label>
                        <input id={`imp-${k}`} className="input" inputMode="decimal" disabled={busy} value={values.amounts[k]} onChange={(e) => setAmount(k, e.target.value)} />
                        {fieldError(k)}
                    </div>
                ))}
                {purchases && (
                    <div>
                        <label htmlFor="imp-reported" style={LABEL}>Crédito fiscal computable informado (archivo)</label>
                        <input id="imp-reported" className="input" inputMode="decimal" disabled={busy} value={values.reportedComputableVatCreditAmount ?? ""} onChange={(e) => setValues((p) => ({ ...p, reportedComputableVatCreditAmount: e.target.value }))} />
                        <span style={HELP}>Lo informado por el Libro IVA Digital; el crédito que se computa es el de las líneas.</span>
                        {fieldError("reportedComputableVatCreditAmount")}
                    </div>
                )}

                <div role="status" style={INFO}>
                    Total del comprobante con estos importes: {total === null ? "revisá los importes (formato 1234.56)" : `$${total}`} · Antes de corregir: ${detail.totals.total}.
                    {" "}Las notas de crédito restan en la liquidación (el signo sale del tipo de comprobante; acá los importes van siempre positivos).
                </div>

                <div style={INFO}>
                    <strong>Clasificaciones para la presentación</strong> (se conservan; se cambian en «Presentación ARCA»):{" "}
                    {purchases
                        ? <>concepto del crédito: {c.purchaseCreditConcept ? PURCHASE_CREDIT_CONCEPT_LABELS[c.purchaseCreditConcept as keyof typeof PURCHASE_CREDIT_CONCEPT_LABELS] : "pendiente"}</>
                        : <>actividad: {c.activityCode ?? "pendiente"} · tipo de operación: {c.saleOperationType ? SALE_OPERATION_TYPE_LABELS[c.saleOperationType as keyof typeof SALE_OPERATION_TYPE_LABELS] : "pendiente"} · sujeto: {c.buyerType ? BUYER_TYPE_LABELS[c.buyerType as keyof typeof BUYER_TYPE_LABELS] : "pendiente"} · dación en pago: {c.dationInPayment ? "sí" : "no"}</>}
                </div>

                <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)" }}>
                    <Link href={listHref} className="btn btn-secondary" aria-disabled={busy}>Cancelar</Link>
                    <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Guardando…" : "Guardar corrección"}</button>
                </div>
            </form>
        </div>
    );
}
