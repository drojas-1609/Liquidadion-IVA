"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatPeriodLabel } from "@/lib/period";
import { TURIVA_SECTION_ID } from "@/lib/turiva-setting";
import { resolveInvoiceFormOptions, type InvoiceFormContext, type Option } from "@/lib/invoice-form-options";
import {
    INITIAL_FORM_STATE,
    INVOICE_EDIT_TEXT,
    INVOICE_FORM_TEXT,
    applyFieldChange,
    applySelectionChange,
    buildInvoiceUpdateBody,
    buildInvoiceV2Body,
    docNumberLabel,
    editPendingNotices,
    initialEditState,
    invoiceListHref,
    nextUpdateToken,
    submitInvoice,
    submitInvoiceUpdate,
    type FieldKey,
    type InvoiceEditFormProps,
    type InvoiceErrorFeedback,
    type InvoiceFormControl,
    type SelectionKey,
    feedbackText,
} from "@/lib/invoice-form-client";

export interface InvoiceFormProps {
    direction: "SALES" | "PURCHASES";
    /** Sólo para armar rutas (ya presentes en la URL). */
    clientId: string;
    periodId: string;
    clientName: string;
    period: { month: number; year: number };
    /** Código oficial de la condición del cliente (null = no admitida). */
    clientConditionCode: number | null;
    turivaIncluded: boolean;
    /** Presente sólo en la edición (PATCH); ausente = alta (POST). */
    edit?: InvoiceEditFormProps;
}

const LABEL_STYLE = { display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 } as const;
const HELP_STYLE = { display: "block", marginTop: "var(--spacing-xs)", fontSize: "0.8rem", color: "var(--secondary)" } as const;
const ERROR_STYLE = { display: "block", marginTop: "var(--spacing-xs)", fontSize: "0.8rem", color: "var(--error)" } as const;
const ALERT_STYLE = {
    gridColumn: "1 / -1",
    padding: "var(--spacing-sm)",
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    color: "var(--error)",
    borderRadius: "var(--radius-sm)",
} as const;
const INFO_STYLE = { gridColumn: "1 / -1", padding: "var(--spacing-sm)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" } as const;

const ID: Record<SelectionKey | FieldKey, string> = {
    date: "invoice-date",
    counterpartyCondition: "invoice-counterparty-condition",
    voucherCode: "invoice-voucher-code",
    docType: "invoice-doc-type",
    docNumber: "invoice-doc-number",
    voucherVariant: "invoice-voucher-variant",
    turivaRelationCode: "invoice-turiva-relation",
    counterpartyName: "invoice-counterparty-name",
    pointOfSale: "invoice-point-of-sale",
    number: "invoice-number",
    netAmount: "invoice-net-amount",
    vatRate: "invoice-vat-rate",
};

export function InvoiceForm(props: InvoiceFormProps) {
    const { direction, clientId, periodId, clientName, period, clientConditionCode, turivaIncluded, edit } = props;
    const router = useRouter();
    const text = edit ? { ...INVOICE_FORM_TEXT[direction], ...INVOICE_EDIT_TEXT[direction] } : INVOICE_FORM_TEXT[direction];
    const listHref = invoiceListHref(direction, clientId, periodId);
    const periodHref = `/client/${clientId}/period/${periodId}`;

    const ctx: InvoiceFormContext = useMemo(
        () => ({ direction, clientConditionCode, turivaIncluded, period: { month: period.month, year: period.year } }),
        [direction, clientConditionCode, turivaIncluded, period.month, period.year],
    );
    const [state, setState] = useState(() => (edit ? initialEditState(ctx, edit.initial) : INITIAL_FORM_STATE));
    const options = useMemo(() => resolveInvoiceFormOptions(ctx, state.selection), [ctx, state.selection]);
    const [loading, setLoading] = useState(false);
    const [feedback, setFeedback] = useState<InvoiceErrorFeedback | null>(null);
    // Evita dobles envíos aun antes de que React re-renderice el botón deshabilitado.
    const inFlight = useRef(false);
    // Edición: token de concurrencia vigente; se reemplaza por el updatedAt de cada PATCH exitoso.
    const token = useRef(edit?.updatedAt ?? "");

    const clientBlocked = clientConditionCode === null;
    const hasBlocking = options.notices.some((n) => n.level === "blocking");
    // Excepciones antiguas (condición / variante nulas) sin completar: envío bloqueado.
    const editPending = edit ? editPendingNotices(edit, options) : [];
    const canSubmit = !loading && !clientBlocked && !hasBlocking && options.derived !== null && editPending.length === 0;
    const sel = options.selection;

    function onSelect(key: SelectionKey, raw: string) {
        setState((prev) => applySelectionChange(ctx, prev, key, raw).state);
        setFeedback(null);
    }
    function onField(key: FieldKey, value: string) {
        setState((prev) => applyFieldChange(prev, key, value));
        setFeedback(null);
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (inFlight.current) return;
        if (editPending.length > 0) {
            setFeedback({ control: "form", message: editPending[0], pending: false });
            return;
        }
        const built = buildInvoiceV2Body({ ctx, periodId, state });
        if (!built.ok) {
            setFeedback({ control: built.control, message: built.message, pending: false });
            return;
        }
        inFlight.current = true;
        setLoading(true);
        setFeedback(null);
        try {
            if (edit) {
                // Edición: cuerpo v2 COMPLETO + token vigente. Sin actualización optimista.
                const result = await submitInvoiceUpdate(edit.invoiceId, buildInvoiceUpdateBody(built.body, token.current));
                if (!result.ok) {
                    setFeedback(result.feedback);
                    return;
                }
                token.current = nextUpdateToken(token.current, result);
            } else {
                const result = await submitInvoice(built.body);
                if (!result.ok) {
                    setFeedback(result.feedback);
                    return;
                }
            }
            router.push(listHref);
            router.refresh();
        } finally {
            inFlight.current = false;
            setLoading(false);
        }
    }

    const errorFor = (control: InvoiceFormControl) => (feedback && feedback.control === control ? feedback : null);
    const describedBy = (key: SelectionKey | FieldKey, help?: string | null) =>
        [help ? `${ID[key]}-help` : null, errorFor(key) ? `${ID[key]}-error` : null].filter(Boolean).join(" ") || undefined;
    const fieldError = (key: SelectionKey | FieldKey) => {
        const f = errorFor(key);
        return f ? (
            <span id={`${ID[key]}-error`} style={ERROR_STYLE}>
                {feedbackText(f)}
            </span>
        ) : null;
    };

    function selectField<T extends string | number>(
        key: SelectionKey,
        label: string,
        opts: Option<T>[],
        value: T | null,
        emptyHelp: string,
        extraDisabled = false,
    ) {
        const disabled = loading || clientBlocked || extraDisabled || opts.length === 0;
        const help = opts.length === 0 ? emptyHelp : null;
        return (
            <div>
                <label htmlFor={ID[key]} style={LABEL_STYLE}>{label}</label>
                <select
                    id={ID[key]}
                    name={key}
                    className="input"
                    required
                    disabled={disabled}
                    value={value === null ? "" : String(value)}
                    onChange={(e) => onSelect(key, e.target.value)}
                    aria-invalid={errorFor(key) ? true : undefined}
                    aria-describedby={describedBy(key, help)}
                >
                    <option value="">Seleccioná…</option>
                    {opts.map((o) => (
                        <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
                    ))}
                </select>
                {help && <span id={`${ID[key]}-help`} style={HELP_STYLE}>{help}</span>}
                {fieldError(key)}
            </div>
        );
    }

    function textField(key: FieldKey, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}, disabledReason?: string | null) {
        const disabled = loading || clientBlocked || Boolean(disabledReason);
        return (
            <div>
                <label htmlFor={ID[key]} style={LABEL_STYLE}>{label}</label>
                <input
                    id={ID[key]}
                    name={key}
                    type="text"
                    className="input"
                    required
                    disabled={disabled}
                    value={state.fields[key]}
                    onChange={(e) => onField(key, e.target.value)}
                    aria-invalid={errorFor(key) ? true : undefined}
                    aria-describedby={describedBy(key, disabledReason)}
                    {...extra}
                />
                {disabledReason && <span id={`${ID[key]}-help`} style={HELP_STYLE}>{disabledReason}</span>}
                {fieldError(key)}
            </div>
        );
    }

    const formError = errorFor("form");

    return (
        <div className="container" style={{ maxWidth: "800px" }}>
            <Link href={listHref} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                &larr; Volver
            </Link>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-xs)" }}>{text.title}</h1>
            <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>
                {clientName} · Período {formatPeriodLabel(period)}
            </p>

            <form
                onSubmit={handleSubmit}
                className="card"
                aria-busy={loading}
                noValidate
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--spacing-md)" }}
            >
                {clientBlocked && (
                    <div role="alert" style={ALERT_STYLE}>
                        No se pueden cargar comprobantes para este cliente: su condición fiscal no es una de las admitidas
                        (Responsable Inscripto, Monotributo, Exento). <Link href={`/client/${clientId}/edit`}>Editar el cliente</Link>
                    </div>
                )}

                {options.notices
                    .filter((n) => !(clientBlocked && n.code === "CLIENT_CONDITION_UNSUPPORTED"))
                    .map((n) => (
                        <div key={`${n.code}-${n.message}`} role={n.level === "blocking" ? "alert" : "status"} style={n.level === "blocking" ? ALERT_STYLE : INFO_STYLE}>
                            {n.message}
                            {n.code === "TURIVA_NOT_INCLUDED" && (
                                <>
                                    {" "}
                                    <Link href={`${periodHref}#${TURIVA_SECTION_ID}`}>Ir a la configuración TurIVA del período</Link>
                                </>
                            )}
                        </div>
                    ))}

                {editPending.map((message) => (
                    <div key={message} role="alert" style={ALERT_STYLE}>
                        {message}
                    </div>
                ))}

                {formError && (
                    <div role="alert" style={ALERT_STYLE}>
                        {feedbackText(formError)}
                        {formError.stale && (
                            <>
                                {" "}
                                {/* La página remonta el formulario con el updatedAt nuevo (key). */}
                                <button type="button" className="btn btn-secondary" onClick={() => router.refresh()}>
                                    Recargar datos
                                </button>
                            </>
                        )}
                    </div>
                )}

                {/* 1. Fecha */}
                <div>
                    <label htmlFor={ID.date} style={LABEL_STYLE}>Fecha</label>
                    <input
                        id={ID.date}
                        name="date"
                        type="date"
                        className="input"
                        required
                        disabled={loading || clientBlocked}
                        min={options.dateBounds.min ?? undefined}
                        max={options.dateBounds.max}
                        value={sel.date ?? ""}
                        onChange={(e) => onSelect("date", e.target.value)}
                        aria-invalid={errorFor("date") ? true : undefined}
                        aria-describedby={describedBy("date")}
                    />
                    {fieldError("date")}
                </div>

                {/* 2. Condición de la contraparte */}
                {selectField(
                    "counterpartyCondition",
                    `Condición frente al IVA del ${text.counterparty.toLowerCase()}`,
                    options.counterpartyConditions,
                    sel.counterpartyCondition,
                    "Elegí primero una fecha válida.",
                )}

                {/* 3. Comprobante */}
                {selectField("voucherCode", "Tipo de comprobante", options.voucherCodes, sel.voucherCode, "Elegí primero la condición de la contraparte.")}

                {/* 4. Documento y número */}
                {selectField("docType", "Tipo de documento", options.docTypes, sel.docType, "Elegí primero el comprobante.")}
                {textField("docNumber", docNumberLabel(sel.docType), { autoComplete: "off" }, sel.docType === null ? "Elegí primero el tipo de documento." : null)}

                {/* 5. Variante (001–003) o relación TurIVA (195–197) */}
                {options.variants.length > 0 &&
                    selectField("voucherVariant", "Variante del comprobante", options.variants, sel.voucherVariant, "")}
                {options.turivaRelations.length > 0 &&
                    selectField("turivaRelationCode", "Relación emisor-receptor TurIVA", options.turivaRelations, sel.turivaRelationCode, "")}

                {/* 6. Contraparte */}
                <div style={{ gridColumn: "1 / -1" }}>
                    {textField("counterpartyName", `${text.counterparty} (razón social)`, { autoComplete: "off" })}
                </div>

                {/* 7. Punto de venta y número */}
                {textField("pointOfSale", "Punto de venta", { inputMode: "numeric", pattern: "[0-9]*", placeholder: "1" })}
                {textField("number", "Número", { inputMode: "numeric", pattern: "[0-9]*", placeholder: "1234" })}

                {/* 8. Neto y alícuota */}
                {textField("netAmount", "Neto", { inputMode: "decimal", placeholder: "0.00" })}
                {selectField("vatRate", "Alícuota IVA", options.vatRates, sel.vatRate, "Elegí primero el comprobante.")}

                {options.derived && (
                    <div role="status" style={INFO_STYLE}>
                        Clase jurídica: {options.derived.legalClass ?? "—"}
                        {options.derived.mandatoryLegend && <> · Leyenda obligatoria: {options.derived.mandatoryLegend}</>}
                        {options.derived.requiresTurivaSection && <> · Se registra en la pestaña TURIVA</>}
                    </div>
                )}

                <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    <Link href={listHref} className="btn btn-secondary" aria-disabled={loading}>
                        Cancelar
                    </Link>
                    <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
                        {loading ? text.saving : text.save}
                    </button>
                </div>
            </form>
        </div>
    );
}

/**
 * Comprobante propio que no se puede corregir desde el formulario: aviso
 * estable (mensaje de la razón, resuelto en el servidor) y vuelta a la lista.
 * Sin formulario.
 */
export function InvoiceEditUnavailable(props: {
    direction: "SALES" | "PURCHASES";
    clientId: string;
    periodId: string;
    clientName: string;
    period: { month: number; year: number };
    message: string;
}) {
    const { direction, clientId, periodId, clientName, period, message } = props;
    const listHref = invoiceListHref(direction, clientId, periodId);
    return (
        <div className="container" style={{ maxWidth: "800px" }}>
            <Link href={listHref} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                &larr; Volver
            </Link>
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-xs)" }}>{INVOICE_EDIT_TEXT[direction].title}</h1>
            <p style={{ color: "var(--secondary)", marginBottom: "var(--spacing-lg)" }}>
                {clientName} · Período {formatPeriodLabel(period)}
            </p>
            <div className="card">
                <p role="status">{message}</p>
                <Link href={listHref} className="btn btn-secondary">
                    Volver a la lista
                </Link>
            </div>
        </div>
    );
}
