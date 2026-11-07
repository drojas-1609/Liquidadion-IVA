"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TAX_RECORD_TYPES } from "@/lib/tax-types";
import {
    EMPTY_TAX_DETAIL,
    TAX_DESCRIPTION_MAX_LENGTH,
    TAX_TYPE_REQUIRED_ERROR,
    nextTaxUpdateToken,
    runExclusive,
    submitTaxForm,
    taxListHref,
    type TaxErrorFeedback,
    type TaxFormField,
    type TaxDetailValues,
    type TaxFormValues,
} from "@/lib/tax-form-client";

/** Compra del período con percepción de IVA informada, para registrarla sin duplicar. */
export interface PerceptionSource {
    id: string;
    label: string;
    amount: string;
    date: string;
    agentCuit: string;
    voucherTypeCode: string;
    voucherNumber: string;
}

const NATURE_OPTIONS: Record<string, [string, string][]> = {
    "RETENCION IVA": [["RETENTION", "Retención"]],
    "PERCEPCION IVA": [["PERCEPTION", "Percepción"], ["CUSTOMS_PERCEPTION", "Percepción aduanera"]],
};

/**
 * Formulario compartido de alta y edición de retenciones/percepciones.
 *
 * Recibe del servidor sólo los valores iniciales, los límites de fecha del
 * período y, en edición, el id, el token de concurrencia (`updatedAt` ISO
 * exacto) y el tipo histórico fuera del catálogo, si lo hay. La API es la
 * autoridad: este formulario no decide permisos ni reglas fiscales.
 *
 * Sin diálogos del navegador. Un solo envío a la vez (guardia en vuelo + botón
 * deshabilitado). Tras guardar, vuelve al listado y pide la lista nueva.
 */
export interface TaxFormEdit {
    taxId: string;
    updatedAt: string;
    /** Tipo histórico fuera del catálogo (valor original), o null. */
    unknownType: string | null;
}

export interface TaxFormProps {
    clientId: string;
    periodId: string;
    /** `MM/AAAA`. */
    periodLabel: string;
    /** Primer y último día del período, `AAAA-MM-DD`. */
    dateMin: string;
    dateMax: string;
    initial: TaxFormValues;
    /** Ausente = alta. */
    edit?: TaxFormEdit;
    /** Compras con percepción de IVA sin registrar (y la vinculada, en edición). */
    perceptionSources?: PerceptionSource[];
}

export const TAX_FORM_TEXT = {
    create: { title: "Nueva Retención / Percepción", save: "Guardar" },
    edit: { title: "Editar Retención / Percepción", save: "Guardar cambios" },
} as const;

const LABEL_STYLE = { display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 } as const;
const FIELD_ERROR_STYLE = { color: "var(--error)", fontSize: "0.875rem", marginTop: "var(--spacing-xs)" } as const;

export function TaxForm({ clientId, periodId, periodLabel, dateMin, dateMax, initial, edit, perceptionSources = [] }: TaxFormProps) {
    const router = useRouter();
    const baseId = useId();
    const [values, setValues] = useState<TaxFormValues>(initial);
    const [token, setToken] = useState(edit?.updatedAt ?? "");
    const [feedback, setFeedback] = useState<TaxErrorFeedback | null>(null);
    // `saved`: tras el éxito el botón queda deshabilitado hasta que llega la navegación.
    const [phase, setPhase] = useState<"idle" | "submitting" | "saved">("idle");
    const inFlight = useRef(false);

    const text = edit ? TAX_FORM_TEXT.edit : TAX_FORM_TEXT.create;
    const busy = phase !== "idle";
    const unknownTypePending = edit?.unknownType != null && values.type === "";
    const fieldError = (field: TaxFormField) => (feedback?.field === field ? feedback.message : null);
    const generalError = feedback && feedback.field === null ? feedback : null;
    const errorId = (field: TaxFormField) => `${baseId}-${field}-error`;

    const set = (field: Exclude<keyof TaxFormValues, "detail">) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setValues((v) => ({ ...v, [field]: e.target.value }));
    const detail = values.detail ?? EMPTY_TAX_DETAIL;
    const setDetail = (patch: Partial<TaxDetailValues>) => setValues((v) => ({ ...v, detail: { ...(v.detail ?? EMPTY_TAX_DETAIL), ...patch } }));
    const setD = (field: keyof TaxDetailValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDetail({ [field]: e.target.value });
    const ivaType = values.type === "RETENCION IVA" || values.type === "PERCEPCION IVA";
    function pickSource(id: string) {
        const src = perceptionSources.find((x) => x.id === id);
        if (!src) {
            setDetail({ invoiceId: "" });
            return;
        }
        // Sugerencia editable con los datos del propio comprobante; el régimen lo completa el estudio.
        setValues((v) => ({
            ...v,
            amount: src.amount,
            date: src.date,
            detail: { ...(v.detail ?? EMPTY_TAX_DETAIL), invoiceId: id, agentCuit: src.agentCuit, voucherTypeCode: src.voucherTypeCode, voucherNumber: src.voucherNumber },
        }));
    }
    const detailInput = (field: keyof TaxDetailValues, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
        <div>
            <label htmlFor={`${baseId}-${field}`} style={LABEL_STYLE}>{label}</label>
            <input id={`${baseId}-${field}`} className="input" value={detail[field]} onChange={setD(field)} aria-invalid={fieldError(field) ? true : undefined} aria-describedby={describedBy(field)} {...extra} />
            {renderFieldError(field)}
        </div>
    );

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        await runExclusive(inFlight, async () => {
            setPhase("submitting");
            setFeedback(null);
            const target = edit ? { mode: "edit" as const, taxId: edit.taxId, expectedUpdatedAt: token } : { mode: "create" as const, periodId };
            const result = await submitTaxForm(target, values);
            if (!result.ok) {
                setFeedback(result.feedback);
                setPhase("idle");
                return;
            }
            if (edit) setToken((current) => nextTaxUpdateToken(current, result));
            setPhase("saved");
            router.push(taxListHref(clientId, periodId));
            router.refresh();
        });
    }

    const describedBy = (field: TaxFormField) => (fieldError(field) ? errorId(field) : undefined);
    const renderFieldError = (field: TaxFormField) =>
        fieldError(field) ? (
            <p id={errorId(field)} role="alert" style={FIELD_ERROR_STYLE}>
                {fieldError(field)}
            </p>
        ) : null;

    return (
        <div className="container" style={{ maxWidth: "600px" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-xs)" }}>{text.title}</h1>
            <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>Período {periodLabel}</p>

            <form onSubmit={handleSubmit} aria-busy={busy} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                {generalError && (
                    <div role="alert" style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" }}>
                        {generalError.message}
                        {generalError.stale && (
                            <>
                                {" "}
                                <button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>
                                    Recargar
                                </button>
                            </>
                        )}
                    </div>
                )}

                <div>
                    <label htmlFor={`${baseId}-date`} style={LABEL_STYLE}>Fecha</label>
                    <input
                        id={`${baseId}-date`}
                        name="date"
                        type="date"
                        required
                        className="input"
                        min={dateMin}
                        max={dateMax}
                        value={values.date}
                        onChange={set("date")}
                        aria-invalid={fieldError("date") ? true : undefined}
                        aria-describedby={describedBy("date")}
                    />
                    {renderFieldError("date")}
                </div>

                <div>
                    <label htmlFor={`${baseId}-type`} style={LABEL_STYLE}>Tipo</label>
                    <select
                        id={`${baseId}-type`}
                        name="type"
                        className="input"
                        required
                        value={values.type}
                        onChange={set("type")}
                        aria-invalid={fieldError("type") || unknownTypePending ? true : undefined}
                        aria-describedby={describedBy("type") ?? (unknownTypePending ? `${baseId}-type-unknown` : undefined)}
                    >
                        {edit?.unknownType != null && (
                            <option value="" disabled>
                                Tipo no reconocido: {edit.unknownType}
                            </option>
                        )}
                        {TAX_RECORD_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                    {unknownTypePending && !fieldError("type") && (
                        <p id={`${baseId}-type-unknown`} style={FIELD_ERROR_STYLE}>
                            Tipo no reconocido: «{edit?.unknownType}». {TAX_TYPE_REQUIRED_ERROR}
                        </p>
                    )}
                    {renderFieldError("type")}
                </div>

                <div>
                    <label htmlFor={`${baseId}-amount`} style={LABEL_STYLE}>Monto</label>
                    <input
                        id={`${baseId}-amount`}
                        name="amount"
                        type="text"
                        inputMode="decimal"
                        required
                        className="input"
                        placeholder="0.00"
                        value={values.amount}
                        onChange={set("amount")}
                        aria-invalid={fieldError("amount") ? true : undefined}
                        aria-describedby={describedBy("amount")}
                    />
                    {renderFieldError("amount")}
                </div>

                <div>
                    <label htmlFor={`${baseId}-description`} style={LABEL_STYLE}>Descripción (Opcional)</label>
                    <input
                        id={`${baseId}-description`}
                        name="description"
                        type="text"
                        className="input"
                        placeholder="Ej. Banco Galicia"
                        maxLength={TAX_DESCRIPTION_MAX_LENGTH}
                        value={values.description}
                        onChange={set("description")}
                        aria-invalid={fieldError("description") ? true : undefined}
                        aria-describedby={describedBy("description")}
                    />
                    {renderFieldError("description")}
                </div>

                {ivaType && (
                    <fieldset style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "var(--spacing-md)", display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                        <legend style={{ fontWeight: 600 }}>Detalle para el F.2051 (necesario para exportar)</legend>
                        <div>
                            <label htmlFor={`${baseId}-nature`} style={LABEL_STYLE}>Naturaleza</label>
                            <select id={`${baseId}-nature`} className="input" value={detail.nature} onChange={setD("nature")} aria-invalid={fieldError("nature") ? true : undefined} aria-describedby={describedBy("nature")}>
                                <option value="">Sin detalle (pendiente)</option>
                                {(NATURE_OPTIONS[values.type] ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                            {renderFieldError("nature")}
                        </div>
                        {detail.nature === "PERCEPTION" && perceptionSources.length > 0 && (
                            <div>
                                <label htmlFor={`${baseId}-invoiceId`} style={LABEL_STYLE}>Tomada de un comprobante de compra (opcional)</label>
                                <select id={`${baseId}-invoiceId`} className="input" value={detail.invoiceId} onChange={(e) => pickSource(e.target.value)} aria-describedby={describedBy("invoiceId")}>
                                    <option value="">No: percepción registrada por separado</option>
                                    {perceptionSources.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                                </select>
                                <p style={{ color: "var(--secondary)", fontSize: "0.8125rem", marginTop: "var(--spacing-xs)" }}>
                                    Vincularla evita contarla dos veces: el importe debe ser la percepción informada en el comprobante.
                                </p>
                                {renderFieldError("invoiceId")}
                            </div>
                        )}
                        {detail.nature === "RETENTION" && (
                            <div>
                                <label htmlFor={`${baseId}-taxCode`} style={LABEL_STYLE}>Impuesto</label>
                                <select id={`${baseId}-taxCode`} className="input" value={detail.taxCode} onChange={setD("taxCode")} aria-describedby={describedBy("taxCode")}>
                                    <option value="">Elegir</option>
                                    <option value="767">767</option>
                                    <option value="216">216</option>
                                </select>
                                {renderFieldError("taxCode")}
                            </div>
                        )}
                        {detail.nature !== "" && detailInput("regimeCode", "Código de régimen", { inputMode: "numeric", maxLength: 5 })}
                        {(detail.nature === "RETENTION" || detail.nature === "PERCEPTION") && (
                            <>
                                {detailInput("agentCuit", "CUIT del agente", { inputMode: "numeric", maxLength: 13 })}
                                {detailInput("intermediaryCuit", "CUIT intermediario (sólo cesionario)", { inputMode: "numeric", maxLength: 13 })}
                                {detailInput("voucherTypeCode", "Tipo de comprobante (tabla del F.2051: 1 factura, 2 recibo, 3 nota de crédito, 4 nota de débito, 6 orden de pago…)", { inputMode: "numeric", maxLength: 3 })}
                                {detailInput("voucherNumber", "Número de comprobante (p. ej. 00003-00000007)", { maxLength: 20 })}
                            </>
                        )}
                        {detail.nature === "RETENTION" && detailInput("certificateNumber", "Número de certificado", { maxLength: 40 })}
                        {detail.nature === "CUSTOMS_PERCEPTION" && detailInput("customsDocument", "Liquidación o despacho (99-999-XXXX-999999-X)", { maxLength: 24 })}
                    </fieldset>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    {edit ? (
                        <Link href={taxListHref(clientId, periodId)} className="btn btn-secondary">
                            Cancelar
                        </Link>
                    ) : (
                        <button type="button" onClick={() => router.back()} className="btn btn-secondary">
                            Cancelar
                        </button>
                    )}
                    <button type="submit" className="btn btn-primary" disabled={busy || unknownTypePending}>
                        {text.save}
                    </button>
                </div>
            </form>
        </div>
    );
}
