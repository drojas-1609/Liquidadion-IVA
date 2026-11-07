"use client";

import { useEffect, useRef, useState } from "react";
import { createLookupSequencer, requestCuitLookup } from "@/lib/arca-lookup-client";
import { applyCounterpartyName, buildCounterpartyProposal, lookupCuitFrom, type CounterpartyProposal } from "@/lib/invoice-counterparty-lookup";

/**
 * «Consultar CUIT en ARCA» para la contraparte de un comprobante. Sólo con
 * documento 80 y CUIT válido (si no, no se muestra). Usa el servicio de la
 * ficha de clientes (permisos, cupos y auditoría del servidor). Propone la
 * denominación; reemplazar una distinta exige confirmación. La condición
 * frente al IVA no se deduce. No toca la ficha del cliente del estudio.
 */
type Lookup =
    | { phase: "idle" }
    | { phase: "loading"; forCuit: string }
    | { phase: "proposal"; forCuit: string; proposal: CounterpartyProposal }
    | { phase: "message"; forCuit: string; tone: "info" | "error"; text: string };

const BOX = { gridColumn: "1 / -1", padding: "var(--spacing-sm)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" } as const;

export function CounterpartyArcaLookup(props: { docType: number | null; docNumber: string; currentName: string; disabled?: boolean; onApplyName: (name: string) => void }) {
    const { docType, docNumber, currentName, disabled = false, onApplyName } = props;
    const cuit = lookupCuitFrom(docType, docNumber);
    const [state, setLookup] = useState<Lookup>({ phase: "idle" });
    const [confirmOverwrite, setConfirmOverwrite] = useState(false);
    const sequencer = useRef(createLookupSequencer());
    const latest = useRef({ docNumber, currentName });
    // Valores vigentes para la respuesta asíncrona (se actualizan después de cada render).
    useEffect(() => {
        latest.current = { docNumber, currentName };
    }, [docNumber, currentName]);

    // Cambió el documento: se descarta la consulta en curso (la respuesta vieja no se acepta).
    useEffect(() => {
        sequencer.current.cancel();
    }, [cuit]);

    if (cuit === null) return null;
    // Sólo se muestra lo que corresponde al CUIT vigente del formulario.
    const lookup: Lookup = state.phase !== "idle" && state.forCuit === cuit ? state : { phase: "idle" };

    async function consult() {
        const queried = docNumber;
        const forCuit = cuit as string;
        const ticket = sequencer.current.start();
        setLookup({ phase: "loading", forCuit });
        setConfirmOverwrite(false);
        const outcome = await requestCuitLookup(queried);
        if (!sequencer.current.accepts(ticket, queried, latest.current.docNumber)) return;
        if (outcome.status === "FOUND") setLookup({ phase: "proposal", forCuit, proposal: buildCounterpartyProposal(outcome, latest.current.currentName) });
        else if (outcome.status === "NOT_FOUND") setLookup({ phase: "message", forCuit, tone: "info", text: "ARCA no informa una persona con ese CUIT. Completá los datos manualmente." });
        else if (outcome.status === "NOT_CONFIGURED") setLookup({ phase: "message", forCuit, tone: "info", text: `${outcome.message}. Completá los datos manualmente.` });
        else setLookup({ phase: "message", forCuit, tone: "error", text: outcome.message });
    }

    function apply(p: CounterpartyProposal) {
        const name = applyCounterpartyName(p, confirmOverwrite);
        if (name !== null) onApplyName(name);
        setLookup({ phase: "idle" });
    }

    return (
        <div style={BOX} aria-live="polite">
            <button type="button" className="btn btn-secondary" disabled={disabled || lookup.phase === "loading"} onClick={consult}>
                {lookup.phase === "loading" ? "Consultando ARCA…" : "Consultar CUIT en ARCA"}
            </button>
            <span style={{ marginLeft: "var(--spacing-sm)", fontSize: "0.8rem", color: "var(--secondary)" }}>
                Propone la denominación de la contraparte; no cambia la ficha del cliente del estudio.
            </span>
            {lookup.phase === "message" && <p role={lookup.tone === "error" ? "alert" : "status"} style={{ marginTop: "var(--spacing-xs)", color: lookup.tone === "error" ? "var(--error)" : undefined }}>{lookup.text}</p>}
            {lookup.phase === "proposal" && (
                <div role="group" aria-label="Propuesta de ARCA" style={{ marginTop: "var(--spacing-sm)" }}>
                    <p>
                        <strong>Denominación según ARCA:</strong> {lookup.proposal.proposedName ?? "ARCA no la informa"}
                        {lookup.proposal.sameAsCurrent && " (coincide con la cargada)"}
                    </p>
                    {lookup.proposal.overwrites && (
                        <label style={{ display: "block" }}>
                            <input type="checkbox" checked={confirmOverwrite} onChange={(e) => setConfirmOverwrite(e.target.checked)} />{" "}
                            Reemplazar «{currentName.trim()}» por la denominación de ARCA
                        </label>
                    )}
                    {lookup.proposal.registrationInfo.length > 0 && (
                        <p style={{ fontSize: "0.85rem" }}>Inscripción informada: {lookup.proposal.registrationInfo.join(" · ")}</p>
                    )}
                    <p style={{ fontSize: "0.85rem", color: "var(--secondary)" }}>{lookup.proposal.conditionNote}</p>
                    {lookup.proposal.notices.map((n) => <p key={n} style={{ fontSize: "0.85rem" }}>ARCA: {n}</p>)}
                    <div style={{ display: "flex", gap: "var(--spacing-xs)" }}>
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={lookup.proposal.proposedName === null || lookup.proposal.sameAsCurrent || (lookup.proposal.overwrites && !confirmOverwrite)}
                            onClick={() => apply(lookup.proposal)}
                        >
                            Aplicar la denominación
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setLookup({ phase: "idle" })}>Descartar</button>
                    </div>
                </div>
            )}
        </div>
    );
}
