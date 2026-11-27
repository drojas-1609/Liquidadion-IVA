"use client";

import { useRef, useState } from "react";
import type { Constancia } from "@/lib/arca-constancia/parse";
import { isEmptyProposal, proposeFromConstancia, type ConstanciaProposal, type FormIibbState } from "@/lib/arca-constancia/apply";
import { jurisdictionLabel } from "@/lib/iibb/jurisdictions";

/** Consulta pública de ARCA (constancia de inscripción); pide captcha, lo resuelve el usuario. */
export const ARCA_CONSTANCIA_URL = "https://seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do";

const fmtMonth = (m: string | null) => (m ? `${m.slice(5, 7)}/${m.slice(0, 4)}` : "");
const fmtDay = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");

function toBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

type State =
    | { phase: "idle" }
    | { phase: "reading" }
    | { phase: "error"; text: string }
    | { phase: "ready"; constancia: Constancia; proposal: ConstanciaProposal; drive: string | null };

/**
 * «Cargar constancia de inscripción»: el usuario la descarga de ARCA (captcha)
 * y la sube acá. Se lee, se muestra qué cambiaría en la ficha IIBB y sólo se
 * aplica al confirmar. Con el cliente ya creado, el PDF queda en Drive
 * (CONSTANCIAS), reemplazando la anterior; en el alta se guarda al crear.
 */
export function ConstanciaPanel({
    clientId,
    cuit,
    current,
    onApply,
    onFileForCreate,
}: {
    clientId: string | null;
    cuit: string;
    current: FormIibbState;
    onApply: (c: Constancia, p: ConstanciaProposal) => void;
    onFileForCreate: (base64: string | null) => void;
}) {
    const [state, setState] = useState<State>({ phase: "idle" });
    const input = useRef<HTMLInputElement>(null);

    async function load(file: File) {
        setState({ phase: "reading" });
        try {
            const b64 = toBase64(await file.arrayBuffer());
            const res = await fetch("/api/arca-constancia", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: b64, clientId }) });
            const json = await res.json().catch(() => null);
            if (!res.ok) return setState({ phase: "error", text: json?.error?.message ?? "No se pudo leer la constancia." });
            const constancia = json.constancia as Constancia;
            const typed = cuit.replace(/\D/g, "");
            if (typed && typed !== constancia.cuit.replace(/\D/g, "")) {
                return setState({ phase: "error", text: `La constancia es del CUIT ${constancia.cuit} y en la ficha figura otro CUIT.` });
            }
            if (!clientId) onFileForCreate(b64);
            const r = json.backup?.result as { status?: string; uploaded?: number } | undefined;
            const drive = !clientId
                ? "Se guardará en Drive (carpeta CONSTANCIAS del cliente) al crear el cliente."
                : json.backup?.queued === false
                  ? "Esta misma constancia ya estaba guardada en Drive."
                  : r?.status === "ok"
                    ? "Guardada en Drive (carpeta CONSTANCIAS del cliente); reemplaza a la anterior."
                    : r?.status === "not_connected" || r?.status === "not_configured"
                      ? "Drive no está conectado: la constancia quedó pendiente de respaldo."
                      : "Quedó pendiente de respaldo en Drive (se reintenta sola).";
            setState({ phase: "ready", constancia, proposal: proposeFromConstancia(constancia, current), drive });
        } catch {
            setState({ phase: "error", text: "No se pudo leer la constancia." });
        } finally {
            if (input.current) input.current.value = "";
        }
    }

    return (
        <div className="constancia-box">
            <div className="constancia-actions">
                <a className="btn btn-secondary" href={ARCA_CONSTANCIA_URL} target="_blank" rel="noopener noreferrer">
                    Abrir constancia en ARCA
                </a>
                <label className="btn btn-secondary">
                    {state.phase === "reading" ? "Leyendo…" : "Cargar constancia de inscripción (PDF)"}
                    <input
                        ref={input}
                        type="file"
                        accept="application/pdf,.pdf"
                        hidden
                        disabled={state.phase === "reading"}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void load(f);
                        }}
                    />
                </label>
            </div>
            <p className="constancia-hint">
                En ARCA ingresá el CUIT, resolvé el captcha y descargá el PDF; después cargalo acá. Se lee el régimen de Ingresos Brutos, las jurisdicciones (con la sede) y las actividades NAES.
            </p>
            {state.phase === "error" && <p role="alert" className="text-error">{state.text}</p>}
            {state.phase === "ready" && (
                <ConstanciaSummary
                    state={state}
                    onApply={() => {
                        onApply(state.constancia, state.proposal);
                        setState({ ...state, proposal: { ...state.proposal, registration: null, headquarters: null, addJurisdictions: [], addActivities: [], name: null, cuit: null, address: null, principalCode: null } });
                    }}
                    onClose={() => setState({ phase: "idle" })}
                />
            )}
        </div>
    );
}

function ConstanciaSummary({ state, onApply, onClose }: { state: Extract<State, { phase: "ready" }>; onApply: () => void; onClose: () => void }) {
    const { constancia: c, proposal: p } = state;
    const empty = isEmptyProposal(p);
    return (
        <div role="region" aria-label="Constancia de inscripción" className="constancia-summary">
            <p>
                <strong>{c.name}</strong> · CUIT {c.cuit} · emitida el {fmtDay(c.issuedOn)}
                {c.verifier ? ` · verificador ${c.verifier}` : ""}
            </p>
            <p className="constancia-hint">
                Ingresos Brutos: {c.iibb ? `${c.iibb.raw}${c.iibb.since ? ` desde ${fmtMonth(c.iibb.since)}` : ""}` : "la constancia no informa inscripción"}
                {c.jurisdictions.length > 0 && <> · Jurisdicciones: {c.jurisdictions.map((j) => `${j.code} ${j.name}`).join(", ")}</>}
            </p>
            {state.drive && <p className="constancia-hint">{state.drive}</p>}
            {empty ? (
                <p role="status">La ficha ya coincide con la constancia.</p>
            ) : (
                <>
                    <p>Cambios propuestos en la ficha (revisalos y después guardá el cliente):</p>
                    <ul>
                        {p.name && <li>Nombre / Razón Social: {p.name.current ? `${p.name.current} → ` : ""}{p.name.proposed}</li>}
                        {p.cuit && <li>CUIT: {p.cuit}</li>}
                        {p.address && <li>Dirección: {p.address.current ? `${p.address.current} → ` : ""}{p.address.proposed}</li>}
                        {p.registration && <li>Régimen: {p.registration === "CONVENIO_MULTILATERAL" ? "Convenio Multilateral" : "Local"}</li>}
                        {p.addJurisdictions.map((j) => (
                            <li key={j.code}>Agregar jurisdicción {jurisdictionLabel(j.code)}{j.since ? ` (desde ${fmtMonth(j.since)})` : ""}</li>
                        ))}
                        {p.headquarters && <li>Sede: {jurisdictionLabel(p.headquarters)}</li>}
                        {p.addActivities.map((a) => (
                            <li key={a.code}>
                                Agregar actividad NAES {a.code} · {a.description}
                                {a.article ? ` (art. ${a.article})` : ""}
                                {a.principal ? " · principal" : ""}
                            </li>
                        ))}
                        {p.principalCode && <li>Actividad principal: {p.principalCode}</li>}
                    </ul>
                </>
            )}
            {(p.onlyInFormJurisdictions.length > 0 || p.onlyInFormActivities.length > 0) && (
                <p className="constancia-hint">
                    Están en la ficha y no en la constancia (no se quitan solos, revisalos):{" "}
                    {[...p.onlyInFormJurisdictions.map((j) => jurisdictionLabel(j)), ...p.onlyInFormActivities.map((a) => `NAES ${a}`)].join(", ")}
                </p>
            )}
            <div className="constancia-actions">
                {!empty && (
                    <button type="button" className="btn btn-primary" onClick={onApply}>
                        Aplicar a la ficha
                    </button>
                )}
                <button type="button" className="btn btn-secondary" onClick={onClose}>
                    Cerrar
                </button>
            </div>
        </div>
    );
}
