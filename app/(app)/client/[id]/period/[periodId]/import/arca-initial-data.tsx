"use client";

import { useState } from "react";
import {
    CREDIT_COMPUTATIONS, CREDIT_COMPUTATION_LABELS, NO_OPERATIONS_LABEL, OPERATION_FIELDS, OPERATION_LABELS,
    type ArcaInitialData, type CreditComputation,
} from "@/lib/arca-sync/initial-data";

export interface InitialDataStatus {
    required: boolean;
    period: ArcaInitialData | null;
    client: ArcaInitialData | null;
    vatSettings: { turivaIncluded: boolean; creditProrationMode: string };
}

const EMPTY: ArcaInitialData = { nonTaxedOrExempt: false, creditComputation: null, definitiveImports: false, serviceImports: false, turiva: false, usedGoods: false };

/** Punto de partida: lo elegido para el período, o lo predeterminado del cliente, o la configuración de IVA del período. */
function initialChoice(status: InitialDataStatus): ArcaInitialData {
    if (status.period) return status.period;
    if (status.client) return status.client;
    const proration = status.vatSettings.creditProrationMode;
    const credit = (CREDIT_COMPUTATIONS as readonly string[]).includes(proration) ? proration as CreditComputation : null;
    return { ...EMPTY, turiva: status.vatSettings.turivaIncluded, nonTaxedOrExempt: credit !== null, creditComputation: credit };
}

function describe(data: ArcaInitialData) {
    const chosen = OPERATION_FIELDS.filter((field) => data[field]).map((field) => field === "nonTaxedOrExempt" && data.creditComputation
        ? `${OPERATION_LABELS[field]} (${CREDIT_COMPUTATION_LABELS[data.creditComputation]})` : OPERATION_LABELS[field]);
    return `Con movimientos · ${chosen.length ? chosen.join(" · ") : NO_OPERATIONS_LABEL}`;
}

/**
 * Datos iniciales que IVA Simple pide al abrir el borrador del período. En la
 * primera importación del mes la persona los confirma o los cambia (TurIVA, por
 * ejemplo, puede variar); se pueden guardar como predeterminados del cliente.
 */
export function ArcaInitialDataSection({ url, status, canSaveDefault, busy, onSaved, onMessage }: {
    url: string; status: InitialDataStatus; canSaveDefault: boolean; busy: boolean;
    onSaved: (value: unknown) => void; onMessage: (message: string) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<ArcaInitialData>(() => initialChoice(status));
    const [saveDefault, setSaveDefault] = useState(false);
    const [saving, setSaving] = useState(false);
    if (!status.required) return null;

    const open = editing || !status.period;
    const vat = status.vatSettings;
    const warnings: string[] = [];
    if (draft.turiva !== vat.turivaIncluded) {
        warnings.push(`La configuración de IVA del período en la app indica TurIVA ${vat.turivaIncluded ? "incluido" : "no incluido"}.`);
    }
    const appCredit = (CREDIT_COMPUTATIONS as readonly string[]).includes(vat.creditProrationMode) ? vat.creditProrationMode as CreditComputation : null;
    if ((draft.nonTaxedOrExempt ? draft.creditComputation : null) !== appCredit) {
        warnings.push(`La configuración de IVA del período en la app usa ${appCredit ? CREDIT_COMPUTATION_LABELS[appCredit].toLowerCase() : "sin prorrateo del crédito"}.`);
    }

    async function save() {
        setSaving(true);
        onMessage("");
        try {
            const response = await fetch(`${url}/initial-data`, {
                method: "PUT", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initialData: draft, saveAsClientDefault: saveDefault }),
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) { onMessage(result?.error?.message ?? "No se pudieron guardar los datos iniciales."); return; }
            setEditing(false);
            onSaved(result);
            onMessage(saveDefault ? "Datos iniciales del período guardados, también como predeterminados del cliente." : "Datos iniciales del período guardados.");
        } catch {
            onMessage("No se pudo conectar. Volvé a intentar.");
        } finally {
            setSaving(false);
        }
    }

    if (!open && status.period) {
        return (
            <section aria-label="Datos iniciales de IVA Simple" className="initial-data">
                <div>
                    <h3>Datos iniciales de IVA Simple <span className="badge badge-success">Confirmados</span></h3>
                    <p className="muted">{describe(status.period)}</p>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy || saving} onClick={() => { setDraft(status.period!); setEditing(true); }}>Cambiar</button>
            </section>
        );
    }

    const toggle = (field: (typeof OPERATION_FIELDS)[number], value: boolean) => setDraft({
        ...draft, [field]: value,
        ...(field === "nonTaxedOrExempt" ? { creditComputation: value ? draft.creditComputation ?? appCredit ?? "DIRECT" : null } : {}),
    });
    return (
        <section aria-label="Datos iniciales de IVA Simple" className="initial-data is-open stack">
            <h3>Datos iniciales de IVA Simple {!status.period && <span className="badge badge-warning">Pendientes</span>}</h3>
            <p className="muted">
                Al abrir el borrador del período, IVA Simple pide estas respuestas antes de mostrar los libros. Confirmalas para la
                primera importación del mes; el conector las completa tal cual. La registración es siempre «Con movimientos».
            </p>
            {!status.period && status.client && <p className="muted">Se propone lo predeterminado del cliente.</p>}
            <fieldset disabled={busy || saving} className="stack">
                <legend>Operaciones que realiza en el período</legend>
                {OPERATION_FIELDS.map((field) => (
                    <label key={field} className="check">
                        <input type="checkbox" checked={draft[field]} onChange={(event) => toggle(field, event.target.checked)} /> {OPERATION_LABELS[field]}
                    </label>
                ))}
                {draft.nonTaxedOrExempt && (
                    <label className="field" style={{ maxWidth: 420 }}>
                        Forma de cómputo del crédito fiscal
                        <select value={draft.creditComputation ?? "DIRECT"} onChange={(event) => setDraft({ ...draft, creditComputation: event.target.value as CreditComputation })}>
                            {CREDIT_COMPUTATIONS.map((value) => <option key={value} value={value}>{CREDIT_COMPUTATION_LABELS[value]}</option>)}
                        </select>
                    </label>
                )}
                {OPERATION_FIELDS.every((field) => !draft[field]) && <p>Se informará «{NO_OPERATIONS_LABEL}».</p>}
                {warnings.map((warning) => <p key={warning} role="note" className="callout callout-warning">{warning} Revisá si corresponde; esta elección no la cambia.</p>)}
                {canSaveDefault && (
                    <label className="check">
                        <input type="checkbox" checked={saveDefault} onChange={(event) => setSaveDefault(event.target.checked)} /> Guardar también como predeterminado del cliente
                    </label>
                )}
                <div className="toolbar">
                    <button type="button" className="btn btn-primary" onClick={() => void save()}>{saving ? "Guardando…" : "Confirmar datos iniciales del período"}</button>
                    {editing && <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancelar</button>}
                </div>
            </fieldset>
        </section>
    );
}
