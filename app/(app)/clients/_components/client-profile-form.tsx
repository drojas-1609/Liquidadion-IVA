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
    ACTIVITY_ORIGIN_LABEL,
    CONTACT_PENDING_NOTICE,
    activityKey,
    summarizeStoredProfile,
    unconfirmedRemovals,
    validateIibbProfile,
    type ActivityNomenclator,
    type ActivityOrigin,
} from "@/lib/client-profile";
import {
    activityLabel,
    activityRemovalLoss,
    confirmationsPayload,
    jurisdictionRemovalLoss,
    storedActivityIndex,
} from "@/lib/client-profile-removal";
import {
    activityFieldKey,
    activityPayload,
    collectFormErrors,
    domIdFor,
    rateFieldKey,
    serverErrorToForm,
    snapshotOf,
    type DraftActivity,
    type DraftRate,
    type FormError,
    type FormErrorKind,
} from "@/lib/client-form-errors";
import {
    applyArcaProposal,
    buildArcaProposal,
    createLookupSequencer,
    requestCuitLookup,
    type ArcaProposal,
    type ProposableFields,
} from "@/lib/arca-lookup-client";
import { fetchPublishedCatalogs, type PublishedCatalog } from "@/lib/activity-catalog/client";
import type { CatalogSelection } from "@/lib/activity-catalog/types";
import { RATE_ORIGIN_LABEL, type RateOrigin, type RateTreatment } from "@/lib/iibb-rates/types";
import type { RateAlternative } from "@/lib/iibb-rates/suggest";
import { ErrorSummary, FieldError, fieldA11y, fieldStyle } from "./form-errors";
import { ActivityCatalogSearch } from "./activity-catalog-search";
import { RateSuggestionPanel } from "./rate-suggestion-panel";

/**
 * Formulario de alta y edición de clientes (ficha completa).
 *
 * - Contactos confirmados por el estudio (obligatorios en altas).
 * - Inscripción en Ingresos Brutos SIN opción preseleccionada; jurisdicciones.
 * - Actividades: búsqueda en catálogos oficiales publicados (copia fija con
 *   versión y referencia) o carga manual/histórica identificada como tal. Nada
 *   ya guardado cambia en silencio.
 * - Alícuotas informativas por actividad y jurisdicción: tasa, exención o sin
 *   informar; tasa manual del estudio o sugerencia de norma confirmada. No se
 *   usan en el cálculo.
 * - "Alícuota del cálculo actual (%)" (defaultIibbRate): editable en la ficha y
 *   enviada SÓLO si cambió (el alta sin cambios usa el valor predeterminado del
 *   contrato, 3; la edición sin cambios conserva el guardado). Se rotula como
 *   predeterminada pendiente de confirmación (alta) o «Sin constancia de
 *   revisión» (edición): no se registra si el estudio la revisó.
 * - Errores: resumen con enlaces, mensaje junto a cada campo, aria-invalid y
 *   aria-describedby, foco en el primero. Claves estables por fila.
 *
 * Quitas confirmadas y concurrencia: sin cambios respecto del protocolo de la
 * ficha (lib/client-profile-removal, expectedUpdatedAt y 409 con borrador).
 */

export interface ClientProfileActivity {
    nomenclator: ActivityNomenclator;
    nomenclatorJurisdiction: string;
    nomenclatorReference: string | null;
    code: string;
    description: string;
    origin: ActivityOrigin;
    catalogId: string | null;
    catalogVersion: string | null;
    rates: Array<{ jurisdiction: string; rate: string | null; treatment: RateTreatment; origin: RateOrigin | null; ruleRef: string | null }>;
}

export interface ClientProfileInitial {
    id?: string;
    /** Edición: `Client.updatedAt` ISO leído ANTES que la ficha IIBB (token de versión). */
    expectedUpdatedAt?: string;
    name: string;
    cuit: string;
    condition: string;
    address: string;
    /** Sólo lectura: alícuota del cálculo heredado. */
    defaultIibbRate: string;
    phone: string;
    contactEmail: string;
    iibbRegistration: string | null;
    jurisdictions: Array<{ code: string; headquarters: boolean }>;
    activities: ClientProfileActivity[];
}

interface ActivityRow extends DraftActivity {
    /** activityKey de la actividad guardada; null si es nueva. */
    storedKey: string | null;
    /** Sólo filas nuevas: buscar en catálogo o cargar a mano. */
    entry: "search" | "manual";
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
const BADGE = { fontSize: "0.75rem", padding: "1px 6px", borderRadius: "999px", border: "1px solid currentColor", color: "var(--secondary)" } as const;

const EMPTY_RATE: DraftRate = { associated: false, rate: "", treatment: "RATE", origin: null, ruleRef: null };

function rowFromActivity(a: ClientProfileActivity, uid: number): ActivityRow {
    return {
        uid,
        storedKey: activityKey(a),
        entry: "manual",
        nomenclator: a.nomenclator,
        nomenclatorJurisdiction: a.nomenclatorJurisdiction,
        nomenclatorReference: a.nomenclatorReference ?? "",
        code: a.code,
        description: a.description,
        origin: a.origin,
        catalogId: a.catalogId,
        catalogVersion: a.catalogVersion,
        rates: Object.fromEntries(
            a.rates.map((r) => [r.jurisdiction, { associated: true, rate: r.rate ?? "", treatment: r.treatment, origin: r.origin, ruleRef: r.ruleRef }]),
        ),
    };
}

export function ClientProfileForm({ mode, initial }: { mode: "create" | "edit"; initial: ClientProfileInitial }) {
    const router = useRouter();
    const baseId = useId();
    const nextUid = useRef(initial.activities.length + 1);
    const sequencer = useRef(createLookupSequencer());
    const summaryRef = useRef<HTMLDivElement>(null);

    const [fields, setFields] = useState({
        name: initial.name,
        cuit: initial.cuit,
        condition: initial.condition,
        address: initial.address,
        phone: initial.phone,
        contactEmail: initial.contactEmail,
        defaultIibbRate: initial.defaultIibbRate,
    });
    const [registration, setRegistration] = useState<string>(initial.iibbRegistration ?? "");
    const [jurisdictions, setJurisdictions] = useState(initial.jurisdictions);
    const [activities, setActivities] = useState<ActivityRow[]>(() => initial.activities.map((a, i) => rowFromActivity(a, i + 1)));
    // Lo guardado al abrir el formulario: base fija de las confirmaciones.
    const storedSummary = useMemo(() => summarizeStoredProfile(initial), [initial]);
    const storedIndex = useMemo(() => storedActivityIndex(initial.activities), [initial]);
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
    // Errores: tipo (validación / conflicto / general), lista por campo y mensaje general.
    const [errorKind, setErrorKind] = useState<FormErrorKind | null>(null);
    const [formErrors, setFormErrors] = useState<FormError[]>([]);
    const [errorMessage, setErrorMessage] = useState("");
    const [focusRequest, setFocusRequest] = useState(0);
    const [catalogs, setCatalogs] = useState<PublishedCatalog[] | null>(null);
    const [catalogsError, setCatalogsError] = useState("");
    const [suggestFor, setSuggestFor] = useState<{ uid: number; code: string } | null>(null);

    const errorMap = useMemo(() => new Map(formErrors.map((e) => [e.key, e])), [formErrors]);

    // Catálogos publicados (revisados) para el buscador; sin ellos queda la carga manual.
    useEffect(() => {
        let active = true;
        fetchPublishedCatalogs().then((out) => {
            if (!active) return;
            if (out.ok) setCatalogs(out.data.catalogs);
            else {
                setCatalogs([]);
                setCatalogsError(out.message);
            }
        });
        return () => {
            active = false;
        };
    }, []);

    // Foco en el primer error (o en el resumen si el campo ya no existe) tras cada envío fallido.
    useEffect(() => {
        if (focusRequest === 0) return;
        const first = formErrors[0];
        const el = first ? document.getElementById(domIdFor(baseId, first.key)) : null;
        (el ?? summaryRef.current)?.focus();
    }, [focusRequest, formErrors, baseId]);

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

    /** Corregir un campo quita su marca de error (el resumen se recalcula al enviar). */
    function clearError(key: string) {
        setFormErrors((errs) => (errs.some((e) => e.key === key) ? errs.filter((e) => e.key !== key) : errs));
    }

    const set = (k: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const value = e.target.value;
        setFields((f) => ({ ...f, [k]: value }));
        clearError(k);
        if (k === "cuit") {
            sequencer.current.cancel();
            setLookup({ phase: "idle" });
        }
    };

    // ── Jurisdicciones ──────────────────────────────────────────────────────
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
        clearError("jurisdictions");
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
        clearError("jurisdictions");
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
        for (const c of current) if (c !== code) requestRemoveJurisdiction(c, code);
    }

    function setHeadquarters(code: string) {
        setJurisdictions((js) => js.map((j) => ({ ...j, headquarters: j.code === code })));
        clearError("headquarters");
    }

    function changeRegistration(value: string) {
        setRegistration(value);
        clearError("iibbRegistration");
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
                entry: catalogs && catalogs.length > 0 ? "search" : "manual",
                nomenclator: "ARCA",
                nomenclatorJurisdiction: "",
                nomenclatorReference: "",
                code: "",
                description: "",
                origin: "MANUAL",
                catalogId: null,
                catalogVersion: null,
                rates: {},
                ...seed,
            },
        ]);
    }

    function updateActivity(uid: number, patch: Partial<ActivityRow>) {
        setActivities((rows) => rows.map((a) => (a.uid === uid ? { ...a, ...patch } : a)));
        for (const k of Object.keys(patch)) {
            if (k === "nomenclator" || k === "nomenclatorJurisdiction" || k === "nomenclatorReference" || k === "code" || k === "description" || k === "origin") {
                clearError(activityFieldKey(uid, k));
            }
        }
    }

    /** Elegir del catálogo propone una copia fija; el estudio ve y confirma al guardar. */
    function applyCatalogSelection(uid: number, s: CatalogSelection) {
        updateActivity(uid, {
            origin: "CATALOG",
            catalogId: s.catalogId,
            catalogVersion: s.catalogVersion,
            nomenclator: s.nomenclator,
            nomenclatorJurisdiction: s.nomenclatorJurisdiction,
            nomenclatorReference: s.reference,
            code: s.code,
            description: s.description,
        });
    }

    /** Pasar a carga manual: se conservan los textos, se quita el vínculo con el catálogo. */
    function switchToManual(uid: number) {
        updateActivity(uid, { origin: "MANUAL", catalogId: null, catalogVersion: null, entry: "manual" });
    }

    function setRate(uid: number, code: string, patch: Partial<DraftRate>) {
        setActivities((rows) =>
            rows.map((a) => {
                if (a.uid !== uid) return a;
                const prev = a.rates[code] ?? EMPTY_RATE;
                return { ...a, rates: { ...a.rates, [code]: { ...prev, ...patch } } };
            }),
        );
        clearError(rateFieldKey(uid, code));
    }

    /** Edición manual de la tasa o del tratamiento: origen "manual del estudio" (o sin origen si queda vacía). */
    function setManualRate(uid: number, code: string, patch: Partial<Pick<DraftRate, "rate" | "treatment">>) {
        const row = activities.find((a) => a.uid === uid);
        const prev = row?.rates[code] ?? EMPTY_RATE;
        const next = { ...prev, ...patch };
        const absent = next.treatment === "RATE" && next.rate.trim() === "";
        setRate(uid, code, { ...patch, origin: absent ? null : "STUDIO_MANUAL", ruleRef: null });
    }

    function confirmSuggestion(uid: number, code: string, alt: RateAlternative) {
        setRate(uid, code, { associated: true, treatment: alt.treatment, rate: alt.rate ?? "", origin: "CONFIRMED_SUGGESTION", ruleRef: alt.ruleRef });
        setSuggestFor(null);
    }

    /** Alternativa no acreditable: queda como decisión del estudio, sin referencia a la regla. */
    function recordAsStudioDecision(uid: number, code: string, alt: Pick<RateAlternative, "treatment" | "rate">) {
        setRate(uid, code, { associated: true, treatment: alt.treatment, rate: alt.rate ?? "", origin: "STUDIO_MANUAL", ruleRef: null });
        setSuggestFor(null);
    }

    function requestRemoveActivity(row: ActivityRow) {
        const loss = activityRemovalLoss(row, storedSummary, storedIndex);
        if (row.storedKey || loss.lines.length > 0) {
            setPending({ kind: "activity", uid: row.uid, storedKey: row.storedKey, label: activityLabel(row), ...loss });
        } else {
            setActivities((rows) => rows.filter((a) => a.uid !== row.uid));
        }
    }

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
        // Actividades informadas por ARCA: carga manual identificada (sin vínculo
        // automático con CLAE ni equivalencia provincial; ver docs).
        for (const a of applied.activities) {
            addActivity({ entry: "manual", nomenclator: "ARCA", code: a.code, description: a.description, nomenclatorReference: a.nomenclatorReference ?? "" });
        }
        setLookup({ phase: "idle" });
    }

    // ── Envío ───────────────────────────────────────────────────────────────
    function buildIibbDraft() {
        return { registration: reg, jurisdictions, activities: activities.map((a) => activityPayload(a, selectedCodes)) };
    }

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

    function showErrors(kind: FormErrorKind, errors: FormError[], message: string) {
        setErrorKind(kind);
        setFormErrors(errors);
        setErrorMessage(message);
        setFocusRequest((n) => n + 1);
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (stale) return; // formulario obsoleto: nunca se reenvía
        setErrorKind(null);
        setErrorMessage("");

        const draft = {
            mode,
            fields,
            initialContacts: { phone: initial.phone, contactEmail: initial.contactEmail },
            registration,
            jurisdictions,
            activities,
        };
        const errors = collectFormErrors(draft, jurisdictionLabel);
        if (errors.length > 0) {
            showErrors("validation", errors, "");
            return;
        }
        setFormErrors([]);
        const check = validateIibbProfile(buildIibbDraft());
        if (!check.ok) {
            // Red de seguridad: el validador por campo no debería dejar pasar nada.
            showErrors("general", [], `Ingresos Brutos: ${check.error}`);
            return;
        }
        const iibb = { ...check.value, ...confirmationsPayload(confirmedJurisdictions, confirmedActivities, check.value) };
        const unconfirmed = unconfirmedRemovals(storedSummary, iibb);
        if (unconfirmed.jurisdictions.length > 0 || unconfirmed.activities.length > 0) {
            askPendingRemoval(unconfirmed);
            showErrors("general", [], "Confirmá las quitas pendientes antes de guardar.");
            return;
        }

        const snap = snapshotOf(activities, selectedCodes);
        // Alícuota del cálculo actual: se envía SÓLO si el usuario la cambió. Sin cambios, el alta
        // usa el valor predeterminado del contrato (3) y la edición conserva el valor guardado.
        const { name, cuit, condition, address, phone, contactEmail } = fields;
        const legacyRate = fields.defaultIibbRate.trim();
        const legacyChanged = legacyRate !== initial.defaultIibbRate;
        const payload = { name, cuit, condition, address, phone, contactEmail, iibb, ...(legacyChanged ? { defaultIibbRate: legacyRate } : {}) };
        setLoading(true);
        try {
            const result =
                mode === "create"
                    ? await submitNewClient(payload)
                    : await submitClientUpdate(initial.id!, { ...payload, expectedUpdatedAt: initial.expectedUpdatedAt });
            if (!result.ok) {
                const mapped = serverErrorToForm(result, snap, activities, jurisdictionLabel);
                if (mapped.kind === "conflict") {
                    // Conflicto de versión: se conserva el borrador y se bloquea el reenvío.
                    setStale(true);
                    setErrorKind("conflict");
                    setErrorMessage(mapped.message);
                    return;
                }
                showErrors(mapped.kind, mapped.errors, mapped.message);
                return;
            }
            router.push(mode === "create" ? "/clients" : backHref);
            router.refresh();
        } catch {
            showErrors("general", [], "Ocurrió un error al guardar el cliente.");
        } finally {
            setLoading(false);
        }
    }

    const id = (s: string) => `${baseId}-${s}`;
    const contactPending = mode === "edit" && (initial.phone.trim() === "" || initial.contactEmail.trim() === "");
    const a11y = (key: string, describedBy?: string) => fieldA11y(baseId, key, errorMap, describedBy);

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

            <form onSubmit={handleSubmit} noValidate className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
                <ErrorSummary ref={summaryRef} baseId={baseId} kind={errorKind} errors={formErrors} message={errorMessage} />
                {stale && (
                    <div role="alert" style={{ ...ERROR_BOX, display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                        <span>
                            <span aria-hidden="true">⚠ </span>
                            Conflicto de versión: {errorMessage}
                        </span>
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
                    <label htmlFor={a11y("name").id} style={LABEL}>Nombre / Razón Social</label>
                    <input {...a11y("name")} name="name" type="text" className="input" style={fieldStyle("name", errorMap)} placeholder="Ej. Empresa S.A." value={fields.name} onChange={set("name")} />
                    <FieldError baseId={baseId} fieldKey="name" errors={errorMap} />
                </div>

                <div>
                    <label htmlFor={a11y("cuit").id} style={LABEL}>CUIT</label>
                    <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                        <input {...a11y("cuit")} name="cuit" type="text" className="input" style={fieldStyle("cuit", errorMap)} placeholder="20-12345678-9" value={fields.cuit} onChange={set("cuit")} />
                        <button type="button" className="btn btn-secondary" onClick={consultArca} disabled={lookup.phase === "loading" || fields.cuit.trim() === ""}>
                            {lookup.phase === "loading" ? "Consultando..." : "Consultar CUIT en ARCA"}
                        </button>
                    </div>
                    <FieldError baseId={baseId} fieldKey="cuit" errors={errorMap} />
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
                    <label htmlFor={a11y("condition").id} style={LABEL}>Condición Fiscal (IVA)</label>
                    <select {...a11y("condition")} name="condition" className="input" style={fieldStyle("condition", errorMap)} value={fields.condition} onChange={set("condition")}>
                        {conditions.map((c) => (
                            <option key={c} value={c}>{c}</option>
                        ))}
                    </select>
                    <FieldError baseId={baseId} fieldKey="condition" errors={errorMap} />
                </div>

                <div>
                    <label htmlFor={a11y("address").id} style={LABEL}>Dirección</label>
                    <input {...a11y("address")} name="address" type="text" className="input" style={fieldStyle("address", errorMap)} placeholder="Calle Falsa 123" value={fields.address} onChange={set("address")} />
                    <FieldError baseId={baseId} fieldKey="address" errors={errorMap} />
                </div>

                {/* Contactos */}
                <div style={SECTION}>
                    <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Contacto</h2>
                    {contactPending && <p role="status" style={NOTICE}>{CONTACT_PENDING_NOTICE}</p>}
                    <div>
                        <label htmlFor={a11y("phone").id} style={LABEL}>Teléfono</label>
                        <input
                            {...a11y("phone")}
                            name="phone"
                            type="tel"
                            className="input"
                            style={fieldStyle("phone", errorMap)}
                            placeholder="+54 11 5555-0000"
                            aria-required={mode === "create" || initial.phone.trim() !== ""}
                            value={fields.phone}
                            onChange={set("phone")}
                        />
                        <FieldError baseId={baseId} fieldKey="phone" errors={errorMap} />
                    </div>
                    <div>
                        <label htmlFor={a11y("contactEmail").id} style={LABEL}>Email de contacto</label>
                        <input
                            {...a11y("contactEmail", id("contactEmail-hint"))}
                            name="contactEmail"
                            type="email"
                            className="input"
                            style={fieldStyle("contactEmail", errorMap)}
                            placeholder="contacto@ejemplo.com"
                            aria-required={mode === "create" || initial.contactEmail.trim() !== ""}
                            value={fields.contactEmail}
                            onChange={set("contactEmail")}
                        />
                        <FieldError baseId={baseId} fieldKey="contactEmail" errors={errorMap} />
                        <p id={id("contactEmail-hint")} style={HINT}>Dato de contacto confirmado por el estudio. No es el domicilio fiscal electrónico.</p>
                    </div>
                </div>

                {/* Ingresos Brutos */}
                <div style={SECTION}>
                    <h2 style={{ fontSize: "1.125rem", fontWeight: 600 }}>Ingresos Brutos</h2>
                    <p style={HINT}>{IIBB_INFORMATIVE_NOTICE}</p>
                    <div>
                        <label htmlFor={a11y("iibbRegistration").id} style={LABEL}>Inscripción en Ingresos Brutos</label>
                        <select
                            {...a11y("iibbRegistration")}
                            className="input"
                            style={fieldStyle("iibbRegistration", errorMap)}
                            value={registration}
                            onChange={(e) => changeRegistration(e.target.value)}
                        >
                            <option value="">Sin clasificar</option>
                            {IIBB_REGISTRATIONS.map((r) => (
                                <option key={r} value={r}>{IIBB_REGISTRATION_LABEL[r]}</option>
                            ))}
                        </select>
                        <FieldError baseId={baseId} fieldKey="iibbRegistration" errors={errorMap} />
                        {reg === null && <p role="status" style={{ ...NOTICE, marginTop: "var(--spacing-xs)" }}>{IIBB_UNCLASSIFIED_NOTICE}</p>}
                    </div>

                    {rule && (
                        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
                            <legend style={LABEL}>{IIBB_JURISDICTION_KIND_LABEL[rule.kind]}</legend>
                            {rule.max === 1 && selectedCodes.length <= 1 ? (
                                <select
                                    {...a11y("jurisdictions")}
                                    className="input"
                                    style={fieldStyle("jurisdictions", errorMap)}
                                    aria-label="Jurisdicción"
                                    value={selectedCodes[0] ?? ""}
                                    onChange={(e) => setSingleJurisdiction(e.target.value)}
                                >
                                    <option value="">Seleccionar jurisdicción</option>
                                    {JURISDICTIONS.map((j) => (
                                        <option key={j.code} value={j.code}>{jurisdictionLabel(j.code)}</option>
                                    ))}
                                </select>
                            ) : (
                                <div
                                    {...a11y("jurisdictions")}
                                    role="group"
                                    tabIndex={-1}
                                    aria-label="Jurisdicciones"
                                    style={fieldStyle("jurisdictions", errorMap, { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "var(--spacing-xs)", padding: "2px" })}
                                >
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
                            <FieldError baseId={baseId} fieldKey="jurisdictions" errors={errorMap} />
                            {rule.headquarters === "required" && (
                                <>
                                    {/* Destino estable del error de sede (enlace del resumen). */}
                                    <p {...a11y("headquarters")} tabIndex={-1} style={fieldStyle("headquarters", errorMap, HINT)}>
                                        Marcá una jurisdicción sede entre las seleccionadas. Se admite una sola jurisdicción en situaciones de transición.
                                    </p>
                                    <FieldError baseId={baseId} fieldKey="headquarters" errors={errorMap} />
                                </>
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
                    <div {...a11y("activities")} tabIndex={-1} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                        <h3 style={{ fontSize: "1rem", fontWeight: 600 }}>Actividades y alícuotas por jurisdicción</h3>
                        <p style={HINT}>
                            Buscá la actividad en un catálogo oficial o registrala como carga manual. Los códigos de nomencladores distintos no son equivalentes entre sí. Las alícuotas son
                            informativas: todavía no se usan en la liquidación. Sin informar, 0 % y exento son datos distintos.
                        </p>
                        {catalogsError && <p role="status" style={HINT}>Catálogos no disponibles ({catalogsError}): podés seguir con carga manual.</p>}
                        <FieldError baseId={baseId} fieldKey="activities" errors={errorMap} />
                        {activities.length === 0 && <p style={HINT}>Sin actividades registradas.</p>}
                        {activities.map((a, idx) => {
                            const k = (f: Parameters<typeof activityFieldKey>[1]) => activityFieldKey(a.uid, f);
                            const locked = a.storedKey !== null; // identidad de una actividad guardada
                            const fromCatalog = a.origin === "CATALOG";
                            const searching = !locked && !fromCatalog && a.entry === "search";
                            return (
                                <div key={a.uid} className="card" role="group" aria-label={`Actividad ${idx + 1}`} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                                    <div style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "center", flexWrap: "wrap" }}>
                                        <strong>Actividad {idx + 1}</strong>
                                        <span {...a11y(k("origin"))} tabIndex={-1} style={BADGE}>
                                            {searching ? "Sin elegir" : ACTIVITY_ORIGIN_LABEL[a.origin]}
                                            {fromCatalog && a.catalogVersion ? ` · ${a.catalogVersion}` : ""}
                                        </span>
                                    </div>
                                    <FieldError baseId={baseId} fieldKey={k("origin")} errors={errorMap} />

                                    {searching && catalogs !== null && (
                                        <>
                                            <ActivityCatalogSearch idPrefix={id(`act-${a.uid}-search`)} catalogs={catalogs} onSelect={(s) => applyCatalogSelection(a.uid, s)} />
                                            <div>
                                                <button type="button" className="btn btn-secondary" onClick={() => updateActivity(a.uid, { entry: "manual" })}>
                                                    No está en el catálogo: registrar como carga manual
                                                </button>
                                            </div>
                                        </>
                                    )}

                                    {!searching && (
                                        <>
                                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "var(--spacing-sm)" }}>
                                                <div>
                                                    <label htmlFor={a11y(k("nomenclator")).id} style={LABEL}>Nomenclador</label>
                                                    <select
                                                        {...a11y(k("nomenclator"))}
                                                        className="input"
                                                        style={fieldStyle(k("nomenclator"), errorMap)}
                                                        value={a.nomenclator}
                                                        disabled={locked || fromCatalog}
                                                        onChange={(e) => updateActivity(a.uid, { nomenclator: e.target.value as ActivityNomenclator })}
                                                    >
                                                        {ACTIVITY_NOMENCLATORS.map((n) => (
                                                            <option key={n} value={n}>{ACTIVITY_NOMENCLATOR_LABEL[n]}</option>
                                                        ))}
                                                    </select>
                                                    <FieldError baseId={baseId} fieldKey={k("nomenclator")} errors={errorMap} />
                                                </div>
                                                {a.nomenclator === "PROVINCIAL" && (
                                                    <div>
                                                        <label htmlFor={a11y(k("nomenclatorJurisdiction")).id} style={LABEL}>Jurisdicción del nomenclador</label>
                                                        <select
                                                            {...a11y(k("nomenclatorJurisdiction"))}
                                                            className="input"
                                                            style={fieldStyle(k("nomenclatorJurisdiction"), errorMap)}
                                                            value={a.nomenclatorJurisdiction}
                                                            disabled={locked || fromCatalog}
                                                            onChange={(e) => updateActivity(a.uid, { nomenclatorJurisdiction: e.target.value })}
                                                        >
                                                            <option value="">Seleccionar</option>
                                                            {JURISDICTIONS.map((j) => (
                                                                <option key={j.code} value={j.code}>{jurisdictionLabel(j.code)}</option>
                                                            ))}
                                                        </select>
                                                        <FieldError baseId={baseId} fieldKey={k("nomenclatorJurisdiction")} errors={errorMap} />
                                                    </div>
                                                )}
                                                <div>
                                                    <label htmlFor={a11y(k("code")).id} style={LABEL}>Código</label>
                                                    <input
                                                        {...a11y(k("code"))}
                                                        className="input"
                                                        style={fieldStyle(k("code"), errorMap)}
                                                        value={a.code}
                                                        readOnly={locked || fromCatalog}
                                                        onChange={(e) => updateActivity(a.uid, { code: e.target.value })}
                                                    />
                                                    <FieldError baseId={baseId} fieldKey={k("code")} errors={errorMap} />
                                                </div>
                                                <div>
                                                    <label htmlFor={a11y(k("nomenclatorReference")).id} style={LABEL}>
                                                        Referencia{fromCatalog ? " oficial" : a.nomenclator === "OTRO" ? " del nomenclador" : " (opcional)"}
                                                    </label>
                                                    <input
                                                        {...a11y(k("nomenclatorReference"))}
                                                        className="input"
                                                        style={fieldStyle(k("nomenclatorReference"), errorMap)}
                                                        value={a.nomenclatorReference}
                                                        readOnly={fromCatalog}
                                                        onChange={(e) => updateActivity(a.uid, { nomenclatorReference: e.target.value })}
                                                    />
                                                    <FieldError baseId={baseId} fieldKey={k("nomenclatorReference")} errors={errorMap} />
                                                </div>
                                            </div>
                                            <div>
                                                <label htmlFor={a11y(k("description")).id} style={LABEL}>Descripción</label>
                                                <input
                                                    {...a11y(k("description"))}
                                                    className="input"
                                                    style={fieldStyle(k("description"), errorMap)}
                                                    value={a.description}
                                                    readOnly={fromCatalog}
                                                    onChange={(e) => updateActivity(a.uid, { description: e.target.value })}
                                                />
                                                <FieldError baseId={baseId} fieldKey={k("description")} errors={errorMap} />
                                            </div>
                                            {fromCatalog ? (
                                                <p style={HINT}>
                                                    Copia fija del catálogo oficial ({a.nomenclatorReference || a.catalogId}). Una versión nueva del catálogo no la modifica.{" "}
                                                    {!locked && (
                                                        <button type="button" className="btn btn-secondary" onClick={() => switchToManual(a.uid)}>
                                                            Editar como carga manual
                                                        </button>
                                                    )}
                                                </p>
                                            ) : (
                                                !locked &&
                                                catalogs !== null &&
                                                catalogs.length > 0 && (
                                                    <div>
                                                        <button type="button" className="btn btn-secondary" onClick={() => updateActivity(a.uid, { entry: "search" })}>
                                                            Buscar en un catálogo oficial
                                                        </button>
                                                    </div>
                                                )
                                            )}
                                        </>
                                    )}

                                    {selectedCodes.length > 0 ? (
                                        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
                                            {selectedCodes.map((code) => {
                                                const r = a.rates[code] ?? EMPTY_RATE;
                                                const rk = rateFieldKey(a.uid, code);
                                                const originId = id(`act-${a.uid}-rate-${code}-origin`);
                                                return (
                                                    <div key={code} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                                        <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center", flexWrap: "wrap" }}>
                                                            <label style={{ display: "flex", gap: "var(--spacing-xs)", alignItems: "center", minWidth: "240px" }}>
                                                                <input type="checkbox" checked={r.associated} onChange={(e) => setRate(a.uid, code, { associated: e.target.checked })} />
                                                                {jurisdictionLabel(code)}
                                                            </label>
                                                            {r.associated && (
                                                                <>
                                                                    <select
                                                                        className="input"
                                                                        style={{ maxWidth: "150px" }}
                                                                        aria-label={`Tratamiento en ${jurisdictionLabel(code)}`}
                                                                        value={r.treatment}
                                                                        onChange={(e) => setManualRate(a.uid, code, { treatment: e.target.value as RateTreatment, rate: e.target.value === "EXEMPT" ? "" : r.rate })}
                                                                    >
                                                                        <option value="RATE">Alícuota (%)</option>
                                                                        <option value="EXEMPT">Exento</option>
                                                                    </select>
                                                                    {r.treatment === "RATE" && (
                                                                        <input
                                                                            {...a11y(rk, originId)}
                                                                            className="input"
                                                                            style={fieldStyle(rk, errorMap, { maxWidth: "140px" })}
                                                                            inputMode="decimal"
                                                                            aria-label={`Alícuota ${a.code || `actividad ${idx + 1}`} en ${jurisdictionLabel(code)} (%)`}
                                                                            placeholder="sin informar"
                                                                            value={r.rate}
                                                                            onChange={(e) => setManualRate(a.uid, code, { rate: e.target.value })}
                                                                        />
                                                                    )}
                                                                    {r.treatment === "EXEMPT" && (
                                                                        // Destino estable del error de la alícuota cuando es exención.
                                                                        <span {...a11y(rk, originId)} tabIndex={-1} style={fieldStyle(rk, errorMap)}>
                                                                            Exento (sin alícuota)
                                                                        </span>
                                                                    )}
                                                                    <button
                                                                        type="button"
                                                                        className="btn btn-secondary"
                                                                        disabled={a.code.trim() === ""}
                                                                        onClick={() => setSuggestFor({ uid: a.uid, code })}
                                                                    >
                                                                        Asistencia de alícuota
                                                                    </button>
                                                                </>
                                                            )}
                                                        </div>
                                                        {r.associated && (
                                                            <span id={originId} style={{ ...HINT, marginTop: 0 }}>
                                                                {r.treatment === "RATE" && r.rate.trim() === ""
                                                                    ? "Sin informar"
                                                                    : r.origin
                                                                      ? `${RATE_ORIGIN_LABEL[r.origin]}${r.ruleRef ? ` (${r.ruleRef})` : ""}`
                                                                      : "Sin origen registrado (carga anterior)"}
                                                            </span>
                                                        )}
                                                        <FieldError baseId={baseId} fieldKey={rk} errors={errorMap} />
                                                        {suggestFor?.uid === a.uid && suggestFor.code === code && (
                                                            <RateSuggestionPanel
                                                                jurisdiction={code}
                                                                activity={{ nomenclator: a.nomenclator, catalogId: a.origin === "CATALOG" ? a.catalogId : null, code: a.code }}
                                                                registration={reg}
                                                                current={
                                                                    r.associated && !(r.treatment === "RATE" && r.rate.trim() === "")
                                                                        ? {
                                                                              description: `${r.treatment === "EXEMPT" ? "Exento" : `${r.rate} %`} (${r.origin ? RATE_ORIGIN_LABEL[r.origin] : "sin origen registrado"})`,
                                                                          }
                                                                        : null
                                                                }
                                                                onConfirm={(alt) => confirmSuggestion(a.uid, code, alt)}
                                                                onRecordAsStudioDecision={(alt) => recordAsStudioDecision(a.uid, code, alt)}
                                                                onClose={() => setSuggestFor(null)}
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
                            );
                        })}
                        <div>
                            <button type="button" className="btn btn-secondary" onClick={() => addActivity()}>Agregar actividad</button>
                        </div>
                    </div>

                    {/* Alícuota del cálculo actual: única alícuota que usan hoy el cálculo y las exportaciones */}
                    <section className="card" aria-labelledby={id("legacy-title")} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
                        <h3 id={id("legacy-title")} style={{ fontSize: "1rem", fontWeight: 600 }}>Cálculo actual</h3>
                        <label htmlFor={a11y("defaultIibbRate").id} style={{ fontWeight: 500 }}>
                            Alícuota del cálculo actual (%)
                        </label>
                        <input
                            {...a11y("defaultIibbRate", id("legacy-status"))}
                            name="defaultIibbRate"
                            type="text"
                            inputMode="decimal"
                            className="input"
                            style={fieldStyle("defaultIibbRate", errorMap, { maxWidth: "160px" })}
                            value={fields.defaultIibbRate}
                            onChange={set("defaultIibbRate")}
                        />
                        <span id={id("legacy-status")} style={{ ...HINT, marginTop: 0 }}>
                            {mode === "create"
                                ? fields.defaultIibbRate.trim() === initial.defaultIibbRate
                                    ? `${initial.defaultIibbRate} %: valor predeterminado, pendiente de confirmación.`
                                    : "Valor indicado en el alta."
                                : "Sin constancia de revisión: el sistema no registra si el estudio revisó este valor."}{" "}
                            El cálculo y las exportaciones todavía usan este único valor. No se obtiene automáticamente de las actividades ni de las alícuotas por jurisdicción de
                            esta ficha, y no representa una liquidación por jurisdicción.
                        </span>
                        <FieldError baseId={baseId} fieldKey="defaultIibbRate" errors={errorMap} />
                    </section>
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
