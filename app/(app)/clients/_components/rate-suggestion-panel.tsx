"use client";

import { useState } from "react";
import { requestRateSuggestion } from "@/lib/activity-catalog/client";
import { isIsoDateString, todayInArgentina } from "@/lib/activity-catalog/date";
import type { RateAlternative, RateSuggestion } from "@/lib/iibb-rates/suggest";
import { RATE_PENDING_LABEL } from "@/lib/iibb-rates/types";
import { jurisdictionLabel } from "@/lib/iibb/jurisdictions";

const HINT = { color: "var(--secondary)", fontSize: "0.875rem" } as const;
const NOTICE = { padding: "var(--spacing-sm)", borderRadius: "var(--radius-sm)", backgroundColor: "rgba(234, 179, 8, 0.12)" } as const;

function valueLabel(a: Pick<RateAlternative, "treatment" | "rate">): string {
    return a.treatment === "EXEMPT" ? "Exento" : `${a.rate} %`;
}

/** Hechos declarables vistos en una respuesta (la pregunta se formula con la variante «se cumple»). */
function declarableFacts(s: RateSuggestion | null, known: Readonly<Record<string, string>>): Record<string, string> {
    const out = { ...known };
    const alts = s?.status === "UNICA" ? [s.alternative] : s?.status === "ALTERNATIVAS" ? s.alternatives : [];
    for (const c of alts.flatMap((a) => a.conditions)) {
        if (!c.factKey) continue;
        if (c.expected === true || out[c.factKey] === undefined) out[c.factKey] = c.expected === false ? `No se cumple: ${c.description}` : c.description;
    }
    return out;
}

/**
 * Asistencia de alícuota para UNA actividad en UNA jurisdicción. Consulta las
 * reglas verificadas y muestra fuente, vigencia y condiciones. Nunca completa
 * la ficha sola: cada alternativa se incorpora sólo con «Confirmar». Los
 * ingresos y los hechos que se declaren acá sirven sólo para esta consulta y
 * no se guardan.
 */
export function RateSuggestionPanel({
    jurisdiction,
    activity,
    registration,
    current,
    onConfirm,
    onRecordAsStudioDecision,
    onClose,
}: {
    jurisdiction: string;
    activity: { nomenclator: string; catalogId: string | null; code: string };
    registration: string | null;
    /** Alícuota que hoy tiene el borrador para esta actividad y jurisdicción (lo que se reemplazaría). */
    current: { description: string } | null;
    /** Sólo para reglas sin condiciones, con respuesta única: se guarda con su procedencia normativa. */
    onConfirm: (alt: RateAlternative) => void;
    /** Para todo lo demás: se guarda como decisión del estudio, SIN procedencia normativa. */
    onRecordAsStudioDecision: (alt: Pick<RateAlternative, "treatment" | "rate">) => void;
    onClose: () => void;
}) {
    const [income, setIncome] = useState("");
    // Las normas cambian dentro del año: la consulta es para una fecha del período, no siempre para hoy.
    const [date, setDate] = useState(() => todayInArgentina());
    // Hechos que la norma exige y el estudio puede declarar (se acumulan para poder cambiarlos).
    const [facts, setFacts] = useState<Record<string, string>>({});
    const [declared, setDeclared] = useState<Record<string, boolean>>({});
    // Constancia explícita (nunca preseleccionada) de que una alternativa no acreditada se guarda como decisión del estudio.
    const [accepted, setAccepted] = useState<Record<string, boolean>>({});
    const [state, setState] = useState<{ phase: "idle" | "loading" | "done" | "error"; suggestion: RateSuggestion | null; message: string }>({
        phase: "idle",
        suggestion: null,
        message: "",
    });

    async function consult() {
        setState({ phase: "loading", suggestion: null, message: "" });
        const out = await requestRateSuggestion({
            jurisdiction,
            nomenclator: activity.nomenclator,
            catalogId: activity.catalogId,
            code: activity.code.trim(),
            registration,
            date,
            facts: { priorYearGrossIncome: income.trim() === "" ? null : income.trim(), declared },
        });
        if (out.ok) setFacts((f) => declarableFacts(out.data.suggestion, f));
        setAccepted({});
        setState(out.ok ? { phase: "done", suggestion: out.data.suggestion, message: "" } : { phase: "error", suggestion: null, message: out.message });
    }

    const s = state.suggestion;
    return (
        <div role="region" aria-label={`Asistencia de alícuota en ${jurisdictionLabel(jurisdiction)}`} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
            <strong>Alícuota sugerida en {jurisdictionLabel(jurisdiction)}</strong>
            <p style={HINT}>
                {current
                    ? `Valor actual de esta actividad en ${jurisdictionLabel(jurisdiction)}: ${current.description}. Registrar una alternativa reemplaza sólo este valor en el borrador; nada cambia en la base hasta «Guardar» la ficha, y podés cerrar sin guardar.`
                    : `Esta actividad todavía no tiene alícuota en ${jurisdictionLabel(jurisdiction)}. Registrar una alternativa la agrega al borrador; nada cambia en la base hasta «Guardar» la ficha.`}
            </p>
            <p style={HINT}>
                Las sugerencias provienen sólo de normas oficiales cargadas y revisadas. No valen para todos los contribuyentes: verificá las condiciones antes de confirmar. Informativo: no cambia la
                liquidación.
            </p>
            <label>
                <span style={{ display: "block", fontWeight: 500 }}>Fecha de referencia (un día del período que se va a liquidar)</span>
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: "220px" }} />
            </label>
            <label>
                <span style={{ display: "block", fontWeight: 500 }}>Ingresos brutos anuales del ejercicio anterior (opcional, sólo para esta consulta; no se guarda)</span>
                <input className="input" inputMode="decimal" value={income} onChange={(e) => setIncome(e.target.value)} placeholder="Ej. 150000000" style={{ maxWidth: "220px" }} />
            </label>
            {Object.keys(facts).length > 0 && (
                <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
                    <legend style={{ fontWeight: 500 }}>Condiciones que declara el estudio (sólo para esta consulta; no se guardan)</legend>
                    {Object.entries(facts).map(([key, label]) => (
                        <label key={key} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <span style={HINT}>{label}</span>
                            <select
                                className="input"
                                style={{ maxWidth: "220px" }}
                                value={declared[key] === undefined ? "" : declared[key] ? "si" : "no"}
                                onChange={(e) =>
                                    setDeclared((d) => {
                                        const next = { ...d };
                                        if (e.target.value === "") delete next[key];
                                        else next[key] = e.target.value === "si";
                                        return next;
                                    })
                                }
                            >
                                <option value="">Sin indicar</option>
                                <option value="si">Sí</option>
                                <option value="no">No</option>
                            </select>
                        </label>
                    ))}
                    <span style={HINT}>Después de cambiar una condición, volvé a consultar.</span>
                </fieldset>
            )}
            <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                <button type="button" className="btn btn-secondary" onClick={consult} disabled={state.phase === "loading" || activity.code.trim() === "" || !isIsoDateString(date)}>
                    {state.phase === "loading" ? "Consultando..." : "Consultar"}
                </button>
                <button type="button" className="btn btn-secondary" onClick={onClose}>Cerrar</button>
            </div>
            <div role="status" aria-live="polite">
                {state.phase === "error" && <p style={{ color: "var(--error)" }}>Error: {state.message}</p>}
                {s && (s.status === "SIN_COBERTURA" || s.status === "SIN_REGLA" || s.status === "NO_APLICA") && (
                    <p style={NOTICE}>
                        <strong>{RATE_PENDING_LABEL}.</strong> {s.message}
                    </p>
                )}
                {s && s.status === "ALTERNATIVAS" && (s.missing.length > 0 || s.held.length > 0 || s.alternatives.length > 1) && (
                    <div style={NOTICE}>
                        <strong>{RATE_PENDING_LABEL}:</strong> hay más de una posibilidad o faltan datos para decidir.
                        {s.missing.length > 0 && <span style={{ display: "block" }}>Datos faltantes: {s.missing.join("; ")}.</span>}
                        {s.held.length > 0 && (
                            <span style={{ display: "block" }}>
                                Hay otras reglas posibles retenidas por interpretación pendiente (no se ofrecen): {s.held.join(" ")}
                            </span>
                        )}
                    </div>
                )}
            </div>
            {s && (s.status === "UNICA" || s.status === "ALTERNATIVAS") && (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
                    {(s.status === "UNICA" ? [s.alternative] : s.alternatives).map((a) => (
                        <li key={a.ruleRef} className="card" style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <span>
                                <strong>{valueLabel(a)}</strong> — {a.norm}, {a.legalReference}
                            </span>
                            <span style={HINT}>
                                Vigencia: {a.validFrom} a {a.validTo ?? "sin fecha de fin"} ·{" "}
                                <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer">fuente oficial</a>
                            </span>
                            {a.conditions.length > 0 && (
                                <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
                                    {a.conditions.map((c) => (
                                        <li key={c.description}>
                                            {c.status === "CUMPLE" ? "✓ Cumple" : "? Sin verificar"}: {c.description}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {s.status === "UNICA" && a.conditions.length === 0 ? (
                                <div>
                                    <button type="button" className="btn btn-primary" onClick={() => onConfirm(a)}>
                                        Confirmar sugerencia de la norma
                                    </button>
                                    <span style={{ ...HINT, display: "block" }}>Se incorpora al borrador con su referencia a la norma; se guarda al guardar la ficha.</span>
                                </div>
                            ) : (
                                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                    <span style={HINT}>
                                        Esta alternativa depende de condiciones que el sistema no puede acreditar al guardar (o hay otras posibles). No se guarda como «sugerencia de la norma».
                                    </span>
                                    <label style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "flex-start", fontSize: "0.875rem" }}>
                                        <input type="checkbox" checked={accepted[a.ruleRef] === true} onChange={(e) => setAccepted((m) => ({ ...m, [a.ruleRef]: e.target.checked }))} />
                                        <span>
                                            Entiendo que se registra {valueLabel(a)} como decisión del estudio («Tasa manual confirmada por el estudio»), sin referencia a la norma: las condiciones
                                            marcadas «Sin verificar» no quedan acreditadas.
                                        </span>
                                    </label>
                                    <div>
                                        <button type="button" className="btn btn-secondary" onClick={() => onRecordAsStudioDecision(a)} disabled={accepted[a.ruleRef] !== true}>
                                            Registrar como decisión del estudio
                                        </button>
                                    </div>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
