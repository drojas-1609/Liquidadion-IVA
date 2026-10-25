"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { submitNewClient } from "@/lib/new-client-submit";
import { submitClientUpdate } from "@/lib/client-mutations";
import { CLIENT_CONDITIONS } from "@/lib/client-condition";
import { JURISDICTIONS, jurisdictionLabel } from "@/lib/iibb/jurisdictions";
import {
    IIBB_INFORMATIVE_NOTICE,
    IIBB_JURISDICTION_KIND_LABEL,
    IIBB_JURISDICTION_RULES,
    IIBB_REGISTRATION_LABEL,
    IIBB_REGISTRATIONS,
    IIBB_UNCLASSIFIED_NOTICE,
    isIibbRegistration,
} from "@/lib/iibb/registration";
import {
    ACTIVITY_NOMENCLATOR_LABEL,
    ACTIVITY_NOMENCLATORS,
    CONTACT_PENDING_NOTICE,
    activityKey,
    normalizeContactEmail,
    normalizeContactPhone,
    summarizeStoredProfile,
    unconfirmedRemovals,
    validateIibbProfile,
    type ActivityNomenclator,
} from "@/lib/client-profile";
import {
    activityLabel,
    activityRemovalLoss,
    confirmationsPayload,
    jurisdictionRemovalLoss,
    storedActivityIndex,
} from "@/lib/client-profile-removal";
import {
    applyArcaProposal,
    buildArcaProposal,
    createLookupSequencer,
    requestCuitLookup,
    type ArcaProposal,
    type ProposableFields,
} from "@/lib/arca-lookup-client";

/**
 * Formulario de alta y edición de clientes (ficha completa).
 *
 * - Contactos confirmados por el estudio (obligatorios en altas).
 * - Inscripción en Ingresos Brutos SIN opción preseleccionada; jurisdicciones,
 *   actividades y alícuotas informativas (no se usan en el cálculo).
 * - "Alícuota usada por el cálculo actual" (defaultIibbRate) en una sección
 *   aparte: nunca se modifica al editar la ficha IIBB.
 * - Consulta de CUIT en ARCA: propuesta revisable; nada se aplica sin elegirlo.
 *
 * Nada se elimina en silencio: quitar una jurisdicción con actividades o
 * alícuotas asociadas, o una actividad ya guardada, pide confirmación. El aviso
 * enumera exactamente lo que se pierde, calculado sobre lo GUARDADO al abrir el
 * formulario además de lo visible (lib/client-profile-removal).
 *
 * Edición: envía `expectedUpdatedAt` (versión que se vio al abrir). Si otra
 * persona guardó antes, el servidor responde 409: el borrador queda en
 * pantalla, el envío se bloquea y se ofrece abrir la versión actual o
 * descartar y recargar. El token nunca se renueva solo.
 */

export interface ClientProfileActivity {
    nomenclator: ActivityNomenclator;
    nomenclatorJurisdiction: string;
    nomenclatorReference: string | null;
    code: string;
    description: string;
    rates: Array<{ jurisdiction: string; rate: string | null }>;
}

export interface ClientProfileInitial {
    id?: string;
    /** Edición: `Client.updatedAt` ISO leído ANTES que la ficha IIBB (token de versión). */
    expectedUpdatedAt?: string;
    name: string;
    cuit: string;
    condition: string;
    address: string;
    defaultIibbRate: string;
    phone: string;
    contactEmail: string;
    iibbRegistration: string | null;
    jurisdictions: Array<{ code: string; headquarters: boolean }>;
    activities: ClientProfileActivity[];
}

interface ActivityRow {
    uid: number;
    /** activityKey de la actividad guardada; null si es nueva. */
    storedKey: string | null;
    nomenclator: ActivityNomenclator;
    nomenclatorJurisdiction: string;
    nomenclatorReference: string;
    code: string;
    description: string;
    /** jurisdicción -> asociada y alícuota ("" = sin informar). */
    rates: Record<string, { associated: boolean; rate: string }>;
}

/** Quita pendiente de confirmar: `stored` es el conjunto exacto que se confirma; `lines`, el detalle. */
type PendingRemoval =
    | { kind: "jurisdiction"; code: string; replacement: string | null; stored: string[]; lines: string[] }
    | { kind: "activity"; uid: number | null; storedKey: string | null; label: string; stored: string[]; lines: string[] };

type LookupState =
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "message"; tone: "info" | "error"; text: string }
    | { phase: "proposal"; proposal: ArcaProposal };

const LABEL = { display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 } as const;
const HINT = { color: "var(--secondary)", fontSize: "0.875rem", marginTop: "var(--spacing-xs)" } as const;
const NOTICE = { padding: "var(--spacing-sm)", borderRadius: "var(--radius-sm)", backgroundColor: "rgba(234, 179, 8, 0.12)" } as const;
const ERROR_BOX = { padding: "var(--spacing-sm)", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "var(--error)", borderRadius: "var(--radius-sm)" } as const;
const SECTION = { display: "flex", flexDirection: "column", gap: "var(--spacing-md)", borderTop: "1px solid var(--border, rgba(127,127,127,0.25))", paddingTop: "var(--spacing-md)" } as const;

function rowFromActivity(a: ClientProfileActivity, uid: number): ActivityRow {
    return {
        uid,
        storedKey: activityKey(a),
        nomenclator: a.nomenclator,
        nomenclatorJurisdiction: a.nomenclatorJurisdiction,
        nomenclatorReference: a.nomenclatorReference ?? "",
        code: a.code,
        description: a.description,
        rates: Object.fromEntries(a.rates.map((r) => [r.jurisdiction, { associated: true, rate: r.rate ?? "" }])),
    };
}

export function ClientProfileForm({ mode, initial }: { mode: "create" | "edit"; initial: ClientProfileInitial }) {
    const router = useRouter();
    const baseId = useId();
    const nextUid = useRef(initial.activities.length + 1);
    const sequencer = useRef(createLookupSequencer());

    const [fields, setFields] = useState({
        name: initial.name,
        cuit: initial.cuit,
        condition: initial.condition,
        address: initial.address,
        defaultIibbRate: initial.defaultIibbRate,
        phone: initial.phone,
        contactEmail: initial.contactEmail,
    });
    const [registration, setRegistration] = useState<string>(initial.iibbRegistration ?? "");
    const [jurisdictions, setJurisdictions] = useState(initial.jurisdictions);
    const [activities, setActivities] = useState<ActivityRow[]>(() => initial.activities.map((a, i) => rowFromActivity(a, i + 1)));
    // Lo guardado al abrir el formulario: base fija de las confirmaciones.
    const storedSummary = useMemo(() => summarizeStoredProfile(initial), [initial]);
    const storedIndex = useMemo(() => storedActivityIndex(initial.activities), [initial]);
    // Confirmaciones dadas: jurisdicción -> activityKey guardadas; actividad -> jurisdicciones guardadas.
    const [confirmedJurisdictions, setConfirmedJurisdictions] = useState<Record<string, string[]>>({});
    const [confirmedActivities, setConfirmedActivities] = useState<Record<string, string[]>>({});
    const [stale, setStale] = useState(false);
    const [pending, setPending] = useState<PendingRemoval | null>(null);
    const [lookup, setLookup] = useState<LookupState>({ phase: "idle" });
    const [selection, setSelection] = useState<{ fields: Array<keyof ProposableFields>; confirmOverwrite: boolean; activityCodes: string[] }>({
        fields: [],
        confirmOverwrite: false,
        activityCodes: [],
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Valores vigentes al resolver la consulta a ARCA (la respuesta llega
    // después de varios renders): se sincronizan tras cada commit.
    const fieldsRef = useRef(fields);
    const activitiesRef = useRef(activities);
    useEffect(() => {
        fieldsRef.current = fields;
        activitiesRef.current = activities;
    }, [fields, activities]);

    const conditions = (CLIENT_CONDITIONS as readonly string[]).includes(fields.condition)
        ? [...CLIENT_CONDITIONS]
        : [fields.condition, ...CLIENT_CONDITIONS];
    const reg = isIibbRegistration(registration) ? registration : null;
    const rule = reg ? IIBB_JURISDICTION_RULES[reg] : null;
    const selectedCodes = jurisdictions.map((j) => j.code);
    const backHref = mode === "edit" && initial.id ? `/client/${initial.id}/dashboard` : "/clients";

    const set = (k: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const value = e.target.value;
        setFields((f) => ({ ...f, [k]: value }));
        if (k === "cuit") {
            // Cambiar el CUIT descarta cualquier consulta en curso o propuesta anterior.
            sequencer.current.cancel();
            setLookup({ phase: "idle" });
        }
    };

    // ── Jurisdicciones ──────────────────────────────────────────────────────
    /** Volver a agregar una jurisdicción invalida su confirmación de quita. */
    function forgetJurisdictionConfirmation(code: string) {
        setConfirmedJurisdictions((c) => {
            if (!(code in c)) return c;
            const next = { ...c };
            delete next[code];
            return next;
        });
    }

    function addJurisdiction(code: string) {
        setJurisdictions((js) => (js.some((j) => j.code === code) ? js : [...js, { code, headquarters: false }]));
        forgetJurisdictionConfirmation(code);
    }

    function removeJurisdiction(code: string, replacement: string | null) {
        setJurisdictions((js) => {
            const rest = js.filter((j) => j.code !== code);
            return replacement && !rest.some((j) => j.code === replacement) ? [...rest, { code: replacement, headquarters: false }] : rest;
        });
        if (replacement) forgetJurisdictionConfirmation(replacement);
        setActivities((rows) =>
            rows.map((a) => {
                const rates = { ...a.rates };
                delete rates[code];
                return { ...a, rates };
            }),
        );
    }

    function requestRemoveJurisdiction(code: string, replacement: string | null = null) {
        const loss = jurisdictionRemovalLoss(code, storedSummary, storedIndex, activities);
        if (loss.lines.length > 0) setPending({ kind: "jurisdiction", code, replacement, ...loss });
        else removeJurisdiction(code, replacement);
    }

    function toggleJurisdiction(code: string, checked: boolean) {
        if (checked) addJurisdiction(code);
        else requestRemoveJurisdiction(code);
    }

    function setSingleJurisdiction(code: string) {
        const current = jurisdictions.map((j) => j.code);
        if (code === "") {
            current.forEach((c) => requestRemoveJurisdiction(c));
            return;
        }
        if (current.length === 0) {
            addJurisdiction(code);
            return;
        }
        // Reemplazo: cada jurisdicción anterior se quita (con confirmación si tiene asociaciones).
        for (const c of current) if (c !== code) requestRemoveJurisdiction(c, code);
    }

    function setHeadquarters(code: string) {
        setJurisdictions((js) => js.map((j) => ({ ...j, headquarters: j.code === code })));
    }

    function changeRegistration(value: string) {
        setRegistration(value);
        // La sede sólo existe en Convenio Multilateral; nada más se modifica: si la
        // cantidad de jurisdicciones no corresponde, la validación lo indica.
        if (value !== "CONVENIO_MULTILATERAL") setJurisdictions((js) => js.map((j) => ({ ...j, headquarters: false })));
    }

    // ── Actividades ─────────────────────────────────────────────────────────
    function addActivity(seed?: Partial<ActivityRow>) {
        const uid = nextUid.current++;
        setActivities((rows) => [
            ...rows,
            {
                uid,
                storedKey: null,
                nomenclator: "ARCA",
                nomenclatorJurisdiction: "",
                nomenclatorReference: "",
                code: "",
                description: "",
                rates: {},
                ...seed,
            },
        ]);
    }

    function updateActivity(uid: number, patch: Partial<ActivityRow>) {
        setActivities((rows) => rows.map((a) => (a.uid === uid ? { ...a, ...patch } : a)));
    }

    function setRate(uid: number, code: string, patch: Partial<{ associated: boolean; rate: string }>) {
        setActivities((rows) =>
            rows.map((a) => {
                if (a.uid !== uid) return a;
                const prev = a.rates[code] ?? { associated: false, rate: "" };
                return { ...a, rates: { ...a.rates, [code]: { ...prev, ...patch } } };
            }),
        );
    }

    function requestRemoveActivity(row: ActivityRow) {
        const loss = activityRemovalLoss(row, storedSummary, storedIndex);
        if (row.storedKey || loss.lines.length > 0) {
            setPending({ kind: "activity", uid: row.uid, storedKey: row.storedKey, label: activityLabel(row), ...loss });
        } else {
            setActivities((rows) => rows.filter((a) => a.uid !== row.uid));
        }
    }

    /** Registra EXACTAMENTE el conjunto guardado que mostró el aviso. */
    function confirmPending() {
        const p = pending;
        if (!p) return;
        if (p.kind === "jurisdiction") {
            if (p.stored.length > 0) setConfirmedJurisdictions((c) => ({ ...c, [p.code]: p.stored }));
            removeJurisdiction(p.code, p.replacement);
        } else {
            const key = p.storedKey;
            if (key) setConfirmedActivities((c) => ({ ...c, [key]: p.stored }));
            if (p.uid !== null) setActivities((rows) => rows.filter((a) => a.uid !== p.uid));
        }
        setPending(null);
    }

    // ── ARCA ────────────────────────────────────────────────────────────────
    async function consultArca() {
        const queried = fields.cuit;
        const ticket = sequencer.current.start();
        setLookup({ phase: "loading" });
        const outcome = await requestCuitLookup(queried);
        // Respuesta vieja o de otro CUIT: se descarta.
        if (!sequencer.current.accepts(ticket, queried, fieldsRef.current.cuit)) return;
        if (outcome.status === "FOUND") {
            const existing = activitiesRef.current.filter((a) => a.nomenclator === "ARCA").map((a) => a.code);
            const proposal = buildArcaProposal(outcome, { name: fieldsRef.current.name, address: fieldsRef.current.address }, existing);
            setSelection({ fields: proposal.fields.filter((f) => f.selected).map((f) => f.field), confirmOverwrite: false, activityCodes: [] });
            setLookup({ phase: "proposal", proposal });
        } else if (outcome.status === "NOT_FOUND") {
            setLookup({ phase: "message", tone: "info", text: "ARCA no informa una persona con ese CUIT. Podés completar los datos manualmente." });
        } else if (outcome.status === "NOT_CONFIGURED") {
            setLookup({ phase: "message", tone: "info", text: `${outcome.message}. Completá los datos manualmente.` });
        } else {
            setLookup({ phase: "message", tone: "error", text: outcome.message });
        }
    }
    function applyProposal(proposal: ArcaProposal) {
        const applied = applyArcaProposal(proposal, selection);
        setFields((f) => ({ ...f, ...applied.fields }));
        for (const a of applied.activities) {
            addActivity({ nomenclator: "ARCA", code: a.code, description: a.description, nomenclatorReference: a.nomenclatorReference ?? "" });
        }
        setLookup({ phase: "idle" });
    }

    // ── Envío ───────────────────────────────────────────────────────────────
    function buildIibbDraft() {
        return {
            registration: reg,
            jurisdictions,
            activities: activities.map((a) => ({
                nomenclator: a.nomenclator,
                nomenclatorJurisdiction: a.nomenclator === "PROVINCIAL" ? a.nomenclatorJurisdiction : null,
                nomenclatorReference: a.nomenclatorReference.trim() === "" ? null : a.nomenclatorReference,
                code: a.code,
                description: a.description,
                rates: Object.entries(a.rates)
                    .filter(([code, r]) => r.associated && selectedCodes.includes(code))
                    .map(([jurisdiction, r]) => ({ jurisdiction, rate: r.rate.trim() === "" ? null : r.rate.trim() })),
            })),
        };
    }

    /** Vuelve a pedir la primera quita sin confirmación exacta (misma regla que el servidor). */
    function askPendingRemoval(pendingRemovals: { jurisdictions: string[]; activities: string[] }) {
        const code = pendingRemovals.jurisdictions[0];
        if (code) {
            setPending({ kind: "jurisdiction", code, replacement: null, ...jurisdictionRemovalLoss(code, storedSummary, storedIndex, activities) });
            return;
        }
        const key = pendingRemovals.activities[0];
        const row = activities.find((a) => a.storedKey === key);
        const loss = row
            ? activityRemovalLoss(row, storedSummary, storedIndex)
            : { stored: storedSummary.activities[key] ?? [], lines: [`Actividad guardada ${storedIndex[key]?.label ?? key}`] };
        setPending({ kind: "activity", uid: row?.uid ?? null, storedKey: key, label: storedIndex[key]?.label ?? key, ...loss });
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        setError("");
        if (stale) return; // formulario obsoleto: nunca se reenvía
        const check = validateIibbProfile(buildIibbDraft());
        if (!check.ok) {
            setError(`Ingresos Brutos: ${check.error}`);
            return;
        }
        const iibb = { ...check.value, ...confirmationsPayload(confirmedJurisdictions, confirmedActivities, check.value) };
        const unconfirmed = unconfirmedRemovals(storedSummary, iibb);
        if (unconfirmed.jurisdictions.length > 0 || unconfirmed.activities.length > 0) {
            askPendingRemoval(unconfirmed);
            setError("Confirmá las quitas pendientes antes de guardar.");
            return;
        }
        for (const [k, normalize, label] of [
            ["phone", normalizeContactPhone, "Teléfono"],
            ["contactEmail", normalizeContactEmail, "Email de contacto"],
        ] as const) {
            const value = fields[k];
            // Edición de un cliente histórico sin contacto: puede seguir pendiente.
            if (mode === "edit" && value.trim() === "" && initial[k].trim() === "") continue;
            const r = normalize(value);
            if (!r.ok) {
                setError(`${label}: ${r.error}`);
                return;
            }
        }
        setLoading(true);
        try {
            const result =
                mode === "create"
                    ? await submitNewClient({ ...fields, iibb })
                    : await submitClientUpdate(initial.id!, { ...fields, iibb, expectedUpdatedAt: initial.expectedUpdatedAt });
            if (!result.ok) {
                // Conflicto de versión: se conserva el borrador y se bloquea el reenvío.
                if ("stale" in result && result.stale) setStale(true);
                setError(result.message);
                return;
            }
            router.push(mode === "create" ? "/clients" : backHref);
            router.refresh();
        } catch {
            setError("Ocurrió un error al guardar el cliente.");
        } finally {
            setLoading(false);
        }
    }

    const id = (s: string) => `${baseId}-${s}`;
    const contactPending = mode === "edit" && (initial.phone.trim() === "" || initial.contactEmail.trim() === "");

    return (
        <div className="container" style={{ maxWidth: "760px" }}>
            {mode === "edit" && (
                <Link href={backHref} style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
                    &larr; Volver al cliente
                </Link>
            )}
            <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "var(--spacing-lg)" }}>
                {mode === "create" ? "Nuevo Cliente" : "Editar Cliente"}
            </h1>

            <form onSubmit={handleSubmit} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                {error && !stale && (
                    <div role="alert" style={ERROR_BOX}>
                        {error}
                    </div>
                )}
                {stale && (
                    <div role="alert" style={{ ...ERROR_BOX, display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                        <span>{error}</span>
                        <span>
                            Para no sobrescribir lo que guardó la otra persona, este formulario ya no se puede enviar. Abrí la versión actual,
                            compará y volvé a aplicar tus cambios sobre ella.
                        </span>
                        <div style={{ display: "flex", gap: "var(--spacing-sm)", flexWrap: "wrap" }}>
                            {initial.id && (
                                <a href={`/client/${initial.id}/edit`} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                                    Abrir la versión actual en otra pestaña
                                </a>
                            )}
                            <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
                                Descartar mis cambios y recargar
                            </button>
                        </div>
                    </div>
                )}

                <div>
                    <label htmlFor={id("name")} style={LABEL}>Nombre / Razón Social</label>
                    <input id={id("name")} name="name" type="text" required className="input" placeholder="Ej. Empresa S.A." value={fields.name} onChange={set("name")} />
                </div>

                <div>
                    <label htmlFor={id("cuit")} style={LABEL}>CUIT</label>
                    <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                        <input id={id("cuit")} name="cuit" type="text" required className="input" placeholder="20-12345678-9" value={fields.cuit} onChange={set("cuit")} />
                        <button type="button" className="btn btn-secondary" onClick={consultArca} disabled={lookup.phase === "loading" || fields.cuit.trim() === ""}>
                            {lookup.phase === "loading" ? "Consultando..." : "Consultar CUIT en ARCA"}
                        </button>
                    </div>
                    {lookup.phase === "message" && (
                        <p role={lookup.tone === "error" ? "alert" : "status"} style={{ ...HINT, color: lookup.tone === "error" ? "var(--error)" : "var(--secondary)" }}>
                            {lookup.text}
                        </p>
                    )}
                </div>

                {lookup.phase === "proposal" && (
                    <ArcaProposalPanel
                        proposal={lookup.proposal}
                        selection={selection}
                        onSelection={setSelection}
                        onApply={() => applyProposal(lookup.proposal)}
                        onDiscard={() => setLookup({ phase: "idle" })}
                    />
                )}

                <div>
                    <label htmlFor={id("condition")} style={LABEL}>Condición Fiscal (IVA)</label>
                    <select id={id("condition")} name="condition" className="input" required value={fields.condition} onChange={set("condition")}>
                        {conditions.map((c) => (
                            <option key={c} value={c}>{c}</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label htmlFor={id("address")} style={LABEL}>Dirección</label>
                    <input id={id("address")} name="address" type="text" className="input" placeholder="Calle Falsa 123" value={fields.address} onChange={set("address")} />
                </div>

                {/* Contactos */}
                <div style={SECTION}>
                    <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Contacto</h2>
                    {contactPending && (
                        <p role="status" style={NOTICE}>{CONTACT_PENDING_NOTICE}</p>
                    )}
                    <div>
                        <label htmlFor={id("phone")} style={LABEL}>Teléfono</label>
                        <input
                            id={id("phone")}
                            name="phone"
                            type="tel"
                            className="input"
                            placeholder="+54 11 5555-0000"
                            required={mode === "create" || initial.phone.trim() !== ""}
                            value={fields.phone}
                            onChange={set("phone")}
                        />
                    </div>
                    <div>
                        <label htmlFor={id("contactEmail")} style={LABEL}>Email de contacto</label>
                        <input
                            id={id("contactEmail")}
                            name="contactEmail"
                            type="email"
                            className="input"
                            placeholder="contacto@ejemplo.com"
                            required={mode === "create" || initial.contactEmail.trim() !== ""}
                            value={fields.contactEmail}
                            onChange={set("contactEmail")}
                        />
                        <p style={HINT}>Dato de contacto confirmado por el estudio. No es el domicilio fiscal electrónico.</p>
                    </div>
                </div>

                {/* Ingresos Brutos */}
                <div style={SECTION}>
                    <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Ingresos Brutos</h2>
                    <p style={HINT}>{IIBB_INFORMATIVE_NOTICE}</p>
                    <div>
                        <label htmlFor={id("iibbRegistration")} style={LABEL}>Inscripción en Ingresos Brutos</label>
                        <select id={id("iibbRegistration")} className="input" value={registration} onChange={(e) => changeRegistration(e.target.value)}>
                            <option value="">Sin clasificar</option>
                            {IIBB_REGISTRATIONS.map((r) => (
                                <option key={r} value={r}>{IIBB_REGISTRATION_LABEL[r]}</option>
                            ))}
                        </select>
                        {reg === null && <p role="status" style={{ ...NOTICE, marginTop: "var(--spacing-xs)" }}>{IIBB_UNCLASSIFIED_NOTICE}</p>}
                    </div>

                    {rule && (
                        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
                            <legend style={LABEL}>{IIBB_JURISDICTION_KIND_LABEL[rule.kind]}</legend>
                            {/* Con más jurisdicciones que las admitidas se muestra la lista para poder quitarlas (con confirmación). */}
                            {rule.max === 1 && selectedCodes.length <= 1 ? (
                                <select className="input" aria-label="Jurisdicción" value={selectedCodes[0] ?? ""} onChange={(e) => setSingleJurisdiction(e.target.value)}>
                                    <option value="">Seleccionar jurisdicción</option>
                                    {JURISDICTIONS.map((j) => (
                                        <option key={j.code} value={j.code}>{jurisdictionLabel(j.code)}</option>
                                    ))}
                                </select>
                            ) : (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "var(--spacing-xs)" }}>
                                    {JURISDICTIONS.map((j) => {
                                        const checked = selectedCodes.includes(j.code);
                                        return (
                                            <label key={j.code} style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "center" }}>
                                                <input type="checkbox" checked={checked} onChange={(e) => toggleJurisdiction(j.code, e.target.checked)} />
                                                <span>{jurisdictionLabel(j.code)}</span>
                                                {rule.headquarters === "required" && checked && (
                                                    <span style={{ marginLeft: "auto", fontSize: "0.8rem" }}>
                                                        <input
                                                            type="radio"
                                                            name={id("headquarters")}
                                                            aria-label={`Sede: ${j.name}`}
                                                            checked={jurisdictions.find((x) => x.code === j.code)?.headquarters ?? false}
                                                            onChange={() => setHeadquarters(j.code)}
                                                        />{" "}
                                                        sede
                                                    </span>
                                                )}
                                            </label>
                                        );
                                    })}
                                </div>
                            )}
                            {rule.headquarters === "required" && (
                                <p style={HINT}>Marcá una jurisdicción sede entre las seleccionadas. Se admite una sola jurisdicción en situaciones de transición.</p>
                            )}
                            {rule.kind === "ACTIVIDAD" && (
                                <p style={HINT}>Para No Inscripto, las jurisdicciones registradas son de actividad: no indican una inscripción vigente.</p>
                            )}
                        </fieldset>
                    )}

                    {pending && (
                        <div role="alertdialog" aria-live="polite" style={{ ...NOTICE, display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                            <span>
                                {pending.kind === "jurisdiction"
                                    ? `Quitar ${jurisdictionLabel(pending.code)} elimina al guardar:`
                                    : `Quitar la actividad ${pending.label} elimina al guardar:`}
                            </span>
                            <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                                {pending.lines.map((line) => (
                                    <li key={line}>{line}</li>
                                ))}
                            </ul>
                            <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                                <button type="button" className="btn btn-primary" onClick={confirmPending}>Confirmar</button>
                                <button type="button" className="btn btn-secondary" onClick={() => setPending(null)}>Cancelar</button>
                            </div>
                        </div>
                    )}

                    {/* Actividades */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                        <h3 style={{ fontSize: "1rem", fontWeight: 600 }}>Actividades y alícuotas por jurisdicción</h3>
                        <p style={HINT}>
                            Las alícuotas por actividad y jurisdicción son informativas: todavía no se usan en la liquidación. Dejá la alícuota vacía si no está informada (distinto de 0 %).
                            Los códigos de nomencladores distintos no son equivalentes entre sí.
                        </p>
                        {activities.length === 0 && <p style={HINT}>Sin actividades registradas.</p>}
                        {activities.map((a, idx) => (
                            <div key={a.uid} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--spacing-sm)" }}>
                                    <label>
                                        <span style={LABEL}>Nomenclador</span>
                                        <select
                                            className="input"
                                            value={a.nomenclator}
                                            disabled={a.storedKey !== null}
                                            onChange={(e) => updateActivity(a.uid, { nomenclator: e.target.value as ActivityNomenclator })}
                                        >
                                            {ACTIVITY_NOMENCLATORS.map((n) => (
                                                <option key={n} value={n}>{ACTIVITY_NOMENCLATOR_LABEL[n]}</option>
                                            ))}
                                        </select>
                                    </label>
                                    {a.nomenclator === "PROVINCIAL" && (
                                        <label>
                                            <span style={LABEL}>Jurisdicción del nomenclador</span>
                                            <select
                                                className="input"
                                                value={a.nomenclatorJurisdiction}
                                                disabled={a.storedKey !== null}
                                                onChange={(e) => updateActivity(a.uid, { nomenclatorJurisdiction: e.target.value })}
                                            >
                                                <option value="">Seleccionar</option>
                                                {JURISDICTIONS.map((j) => (
                                                    <option key={j.code} value={j.code}>{jurisdictionLabel(j.code)}</option>
                                                ))}
                                            </select>
                                        </label>
                                    )}
                                    <label>
                                        <span style={LABEL}>Código</span>
                                        <input className="input" value={a.code} disabled={a.storedKey !== null} onChange={(e) => updateActivity(a.uid, { code: e.target.value })} />
                                    </label>
                                    <label>
                                        <span style={LABEL}>Referencia del nomenclador{a.nomenclator === "OTRO" ? "" : " (opcional)"}</span>
                                        <input className="input" value={a.nomenclatorReference} onChange={(e) => updateActivity(a.uid, { nomenclatorReference: e.target.value })} />
                                    </label>
                                </div>
                                <label>
                                    <span style={LABEL}>Descripción</span>
                                    <input className="input" value={a.description} onChange={(e) => updateActivity(a.uid, { description: e.target.value })} />
                                </label>
                                {selectedCodes.length > 0 ? (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
                                        {selectedCodes.map((code) => {
                                            const r = a.rates[code] ?? { associated: false, rate: "" };
                                            return (
                                                <div key={code} style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center", flexWrap: "wrap" }}>
                                                    <label style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "center", minWidth: "260px" }}>
                                                        <input type="checkbox" checked={r.associated} onChange={(e) => setRate(a.uid, code, { associated: e.target.checked })} />
                                                        {jurisdictionLabel(code)}
                                                    </label>
                                                    {r.associated && (
                                                        <input
                                                            className="input"
                                                            style={{ maxWidth: "160px" }}
                                                            inputMode="decimal"
                                                            aria-label={`Alícuota ${a.code || `actividad ${idx + 1}`} en ${jurisdictionLabel(code)} (%)`}
                                                            placeholder="sin informar"
                                                            value={r.rate}
                                                            onChange={(e) => setRate(a.uid, code, { rate: e.target.value })}
                                                        />
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <p style={HINT}>Registrá jurisdicciones para asociar alícuotas a esta actividad.</p>
                                )}
                                <div>
                                    <button type="button" className="btn btn-secondary" onClick={() => requestRemoveActivity(a)}>Quitar actividad</button>
                                </div>
                            </div>
                        ))}
                        <div>
                            <button type="button" className="btn btn-secondary" onClick={() => addActivity()}>Agregar actividad</button>
                        </div>
                    </div>

                    {/* Alícuota heredada */}
                    <details className="card" open={mode === "create"}>
                        <summary style={{ fontWeight: 600, cursor: "pointer" }}>Alícuota usada por el cálculo actual</summary>
                        <div style={{ marginTop: "var(--spacing-sm)" }}>
                            <label htmlFor={id("defaultIibbRate")} style={LABEL}>Alícuota IIBB del cálculo actual (%)</label>
                            <input
                                id={id("defaultIibbRate")}
                                name="defaultIibbRate"
                                type="text"
                                inputMode="decimal"
                                required={mode === "edit"}
                                className="input"
                                placeholder="3.0"
                                value={fields.defaultIibbRate}
                                onChange={set("defaultIibbRate")}
                            />
                            <p style={HINT}>
                                Es la única alícuota que usa hoy la liquidación y la exportación. No cambia al editar la inscripción, las jurisdicciones ni las actividades.
                            </p>
                        </div>
                    </details>
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
                    <Link href={backHref} className="btn btn-secondary">Cancelar</Link>
                    <button type="submit" className="btn btn-primary" disabled={loading || pending !== null || stale}>
                        {loading ? "Guardando..." : mode === "create" ? "Guardar Cliente" : "Guardar Cambios"}
                    </button>
                </div>
            </form>
        </div>
    );
}

function ArcaProposalPanel({
    proposal,
    selection,
    onSelection,
    onApply,
    onDiscard,
}: {
    proposal: ArcaProposal;
    selection: { fields: Array<keyof ProposableFields>; confirmOverwrite: boolean; activityCodes: string[] };
    onSelection: (s: { fields: Array<keyof ProposableFields>; confirmOverwrite: boolean; activityCodes: string[] }) => void;
    onApply: () => void;
    onDiscard: () => void;
}) {
    const consulted = new Date(proposal.consultedAt).toLocaleString("es-AR");
    const needsOverwrite = proposal.fields.some((f) => f.overwrites && selection.fields.includes(f.field));
    const toggleField = (field: keyof ProposableFields, on: boolean) =>
        onSelection({ ...selection, fields: on ? [...selection.fields, field] : selection.fields.filter((f) => f !== field) });
    const toggleActivity = (code: string, on: boolean) =>
        onSelection({ ...selection, activityCodes: on ? [...selection.activityCodes, code] : selection.activityCodes.filter((c) => c !== code) });

    return (
        <div className="card" role="region" aria-label="Propuesta de datos de ARCA" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
            <strong>Propuesta de datos de ARCA para {proposal.cuit}</strong>
            <span style={HINT}>
                Fuente: {proposal.source}. Consulta: {consulted}. Revisá antes de aplicar: nada se guarda hasta que guardes el cliente.
            </span>
            {proposal.notices.length > 0 && (
                <ul style={{ ...NOTICE, margin: 0, paddingLeft: "var(--spacing-lg)" }}>
                    {proposal.notices.map((n) => (
                        <li key={n}>{n}</li>
                    ))}
                </ul>
            )}
            {proposal.fields.length === 0 && <span style={HINT}>Sin cambios propuestos para nombre ni dirección.</span>}
            {proposal.fields.map((f) => (
                <label key={f.field} style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "flex-start" }}>
                    <input type="checkbox" checked={selection.fields.includes(f.field)} onChange={(e) => toggleField(f.field, e.target.checked)} />
                    <span>
                        <strong>{f.label}:</strong> {f.proposed}
                        {f.overwrites && <span style={{ display: "block", ...HINT }}>Reemplaza el valor actual: {f.current}</span>}
                    </span>
                </label>
            ))}
            {needsOverwrite && (
                <label style={{ display: "flex", gap: "var(--spacing-xs)" }}>
                    <input type="checkbox" checked={selection.confirmOverwrite} onChange={(e) => onSelection({ ...selection, confirmOverwrite: e.target.checked })} />
                    Confirmo reemplazar los valores ya cargados.
                </label>
            )}
            {proposal.registrationInfo.length > 0 && (
                <div>
                    <span style={LABEL}>Inscripciones informadas por ARCA (sólo referencia, no se aplican a la ficha IIBB)</span>
                    <ul style={{ margin: 0, paddingLeft: "var(--spacing-lg)" }}>
                        {proposal.registrationInfo.map((r) => (
                            <li key={r}>{r}</li>
                        ))}
                    </ul>
                </div>
            )}
            {proposal.activities.length > 0 && (
                <div>
                    <span style={LABEL}>Actividades informadas por ARCA (nomenclador ARCA; sin equivalencia con NAES ni nomencladores provinciales)</span>
                    {proposal.activities.map((a) => (
                        <label key={a.code} style={{ display: "flex", gap: "var(--spacing-xs)" }}>
                            <input
                                type="checkbox"
                                disabled={a.alreadyPresent}
                                checked={selection.activityCodes.includes(a.code)}
                                onChange={(e) => toggleActivity(a.code, e.target.checked)}
                            />
                            <span>
                                {a.code} — {a.description}
                                {a.alreadyPresent ? " (ya registrada)" : ""}
                            </span>
                        </label>
                    ))}
                </div>
            )}
            <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                <button type="button" className="btn btn-primary" onClick={onApply} disabled={needsOverwrite && !selection.confirmOverwrite}>
                    Aplicar seleccionados
                </button>
                <button type="button" className="btn btn-secondary" onClick={onDiscard}>Descartar</button>
            </div>
            <span style={HINT}>ARCA no informa teléfono ni email de contacto.</span>
        </div>
    );
}
