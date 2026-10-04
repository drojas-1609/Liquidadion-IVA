"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TAX_RECORD_TYPES } from "@/lib/tax-types";
import {
    TAX_DESCRIPTION_MAX_LENGTH,
    TAX_TYPE_REQUIRED_ERROR,
    nextTaxUpdateToken,
    runExclusive,
    submitTaxForm,
    taxListHref,
    type TaxErrorFeedback,
    type TaxFormField,
    type TaxFormValues,
} from "@/lib/tax-form-client";

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
}

export const TAX_FORM_TEXT = {
    create: { title: "Nueva Retención / Percepción", save: "Guardar" },
    edit: { title: "Editar Retención / Percepción", save: "Guardar cambios" },
} as const;

const LABEL_STYLE = { display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 } as const;
const FIELD_ERROR_STYLE = { color: "var(--error)", fontSize: "0.875rem", marginTop: "var(--spacing-xs)" } as const;

export function TaxForm({ clientId, periodId, periodLabel, dateMin, dateMax, initial, edit }: TaxFormProps) {
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

    const set = (field: keyof TaxFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setValues((v) => ({ ...v, [field]: e.target.value }));

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
