"use client";

import { forwardRef } from "react";
import { domIdFor, type FormError, type FormErrorKind } from "@/lib/client-form-errors";

/**
 * Presentación accesible de errores del formulario de clientes:
 * - resumen en el encabezado con enlaces a cada campo (mueve el foco);
 * - mensaje junto al campo con texto e ícono (no sólo color);
 * - atributos `aria-invalid` y `aria-describedby` por campo.
 */

export const INVALID_STYLE = { borderColor: "var(--error)", borderWidth: "2px", borderStyle: "solid" } as const;

/** Props ARIA de un control: siempre con el id estable de la clave. */
export function fieldA11y(baseId: string, key: string, errors: ReadonlyMap<string, FormError>, describedBy?: string) {
    const err = errors.get(key);
    const ids = [describedBy, err ? `${domIdFor(baseId, key)}-error` : undefined].filter(Boolean).join(" ");
    return {
        id: domIdFor(baseId, key),
        "aria-invalid": err ? (true as const) : undefined,
        "aria-describedby": ids === "" ? undefined : ids,
    };
}

/** Estilo del control: el propio más el borde de error si corresponde. */
export function fieldStyle(key: string, errors: ReadonlyMap<string, FormError>, base?: React.CSSProperties): React.CSSProperties | undefined {
    return errors.has(key) ? { ...base, ...INVALID_STYLE } : base;
}

export function FieldError({ baseId, fieldKey, errors }: { baseId: string; fieldKey: string; errors: ReadonlyMap<string, FormError> }) {
    const err = errors.get(fieldKey);
    if (!err) return null;
    return (
        <p id={`${domIdFor(baseId, fieldKey)}-error`} style={{ color: "var(--error)", fontSize: "0.875rem", marginTop: "var(--spacing-xs)", fontWeight: 500 }}>
            <span aria-hidden="true">⚠ </span>
            Error: {err.message}
        </p>
    );
}

const BOX = { padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)", border: "1px solid var(--error)" } as const;

/** Resumen de errores. `tabIndex=-1` permite llevarle el foco si no hay un campo al que ir. */
export const ErrorSummary = forwardRef<HTMLDivElement, { baseId: string; kind: FormErrorKind | null; errors: FormError[]; message: string }>(
    function ErrorSummary({ baseId, kind, errors, message }, ref) {
        if (kind === null || kind === "conflict") return null;
        const focusField = (key: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
            const el = document.getElementById(domIdFor(baseId, key));
            if (!el) return; // la fila ya no existe: el enlace no hace nada
            e.preventDefault();
            el.focus();
            el.scrollIntoView({ block: "center" });
        };
        return (
            <div ref={ref} role="alert" tabIndex={-1} style={BOX} aria-labelledby={`${baseId}-error-summary-title`}>
                {kind === "validation" ? (
                    <>
                        <p id={`${baseId}-error-summary-title`} style={{ fontWeight: 600 }}>
                            <span aria-hidden="true">⚠ </span>
                            {errors.length === 1 ? "Hay 1 campo para revisar" : `Hay ${errors.length} campos para revisar`}
                        </p>
                        <ul style={{ margin: "var(--spacing-xs) 0 0", paddingLeft: "1.25rem" }}>
                            {errors.map((e) => (
                                <li key={e.key}>
                                    <a href={`#${domIdFor(baseId, e.key)}`} onClick={focusField(e.key)} style={{ color: "inherit", textDecoration: "underline" }}>
                                        {e.label}
                                    </a>
                                    : {e.message}
                                </li>
                            ))}
                        </ul>
                    </>
                ) : (
                    <p id={`${baseId}-error-summary-title`}>
                        <span aria-hidden="true">⚠ </span>
                        Error: {message}
                    </p>
                )}
            </div>
        );
    },
);
