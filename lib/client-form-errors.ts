/**
 * Errores del formulario de clientes asociados a CAMPOS con claves ESTABLES.
 *
 * - Las filas dinámicas (actividades) se identifican por su `uid` (nunca
 *   reutilizado) y las alícuotas por el código de jurisdicción: agregar, quitar
 *   o reordenar filas no hace que un error señale otra actividad.
 * - Las reglas NO se duplican: se aplica el validador autoritativo
 *   (`validateIibbProfile`, el mismo de la API) por campo y por fila, para
 *   reunir todos los errores y no sólo el primero.
 * - Los errores del servidor llegan con índices (`iibb.activities[2].code`); se
 *   traducen con la FOTO de lo que se envió (orden de uids y de jurisdicciones),
 *   no con el estado actual del formulario.
 *
 * Puro: apto para cliente y tests.
 */
import { normalizeCuit } from "./cuit";
import { isClientCondition } from "./client-condition";
import {
    activityKey,
    checkRateString,
    normalizeContactEmail,
    normalizeContactPhone,
    validateIibbProfile,
    type ActivityNomenclator,
    type ActivityOrigin,
} from "./client-profile";
import type { RateOrigin, RateTreatment } from "./iibb-rates/types";

export interface FormError {
    key: string;
    /** Nombre legible del campo (para el resumen). */
    label: string;
    message: string;
}

export type FormErrorKind = "validation" | "conflict" | "general";

export interface DraftRate {
    associated: boolean;
    rate: string;
    treatment: RateTreatment;
    origin: RateOrigin | null;
    ruleRef: string | null;
}

export interface DraftActivity {
    uid: number;
    nomenclator: ActivityNomenclator;
    nomenclatorJurisdiction: string;
    nomenclatorReference: string;
    code: string;
    description: string;
    origin: ActivityOrigin;
    catalogId: string | null;
    catalogVersion: string | null;
    rates: Record<string, DraftRate>;
}

export interface DraftForm {
    mode: "create" | "edit";
    fields: { name: string; cuit: string; condition: string; address: string; phone: string; contactEmail: string; defaultIibbRate: string };
    /** Contactos guardados al abrir (edición de históricos: pueden seguir pendientes). */
    initialContacts: { phone: string; contactEmail: string };
    registration: string;
    jurisdictions: Array<{ code: string; headquarters: boolean }>;
    activities: DraftActivity[];
}

// ── Claves ──────────────────────────────────────────────────────────────────

export const activityFieldKey = (uid: number, field: "nomenclator" | "nomenclatorJurisdiction" | "nomenclatorReference" | "code" | "description" | "origin") =>
    `act:${uid}:${field}`;
export const rateFieldKey = (uid: number, jurisdiction: string) => `act:${uid}:rate:${jurisdiction}`;

/** Id de DOM estable para una clave (sólo [A-Za-z0-9_-]). */
export function domIdFor(baseId: string, key: string): string {
    return `${baseId}-f-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

const GENERAL_LABEL: Record<string, string> = {
    name: "Nombre / Razón Social",
    cuit: "CUIT",
    condition: "Condición Fiscal (IVA)",
    address: "Dirección",
    phone: "Teléfono",
    contactEmail: "Email de contacto",
    defaultIibbRate: "Alícuota del cálculo actual (%)",
    iibbRegistration: "Inscripción en Ingresos Brutos",
    jurisdictions: "Jurisdicciones",
    headquarters: "Jurisdicción sede",
    activities: "Actividades",
};

function activityLabel(index: number, a: Pick<DraftActivity, "code">): string {
    return `Actividad ${index + 1}${a.code.trim() ? ` (${a.code.trim()})` : ""}`;
}

// ── Payload (misma forma que envía el formulario) ──────────────────────────

export function activityPayload(a: DraftActivity, selectedCodes: readonly string[]) {
    return {
        nomenclator: a.nomenclator,
        nomenclatorJurisdiction: a.nomenclator === "PROVINCIAL" ? a.nomenclatorJurisdiction : null,
        nomenclatorReference: a.nomenclatorReference.trim() === "" ? null : a.nomenclatorReference,
        code: a.code,
        description: a.description,
        origin: a.origin,
        catalogId: a.origin === "CATALOG" ? a.catalogId : null,
        catalogVersion: a.origin === "CATALOG" ? a.catalogVersion : null,
        rates: ratesPayload(a, selectedCodes),
    };
}

export function ratesPayload(a: Pick<DraftActivity, "rates">, selectedCodes: readonly string[]) {
    return Object.entries(a.rates)
        .filter(([code, r]) => r.associated && selectedCodes.includes(code))
        .map(([jurisdiction, r]) => {
            const value = r.treatment === "EXEMPT" || r.rate.trim() === "" ? null : r.rate.trim();
            const absent = r.treatment === "RATE" && value === null;
            return {
                jurisdiction,
                rate: value,
                treatment: r.treatment,
                origin: absent ? null : r.origin,
                ruleRef: absent || r.origin !== "CONFIRMED_SUGGESTION" ? null : r.ruleRef,
            };
        });
}

/** Foto del orden enviado: traduce índices del servidor a claves estables. */
export interface SubmittedSnapshot {
    activityUids: number[];
    rateJurisdictions: string[][];
}

export function snapshotOf(activities: readonly DraftActivity[], selectedCodes: readonly string[]): SubmittedSnapshot {
    return {
        activityUids: activities.map((a) => a.uid),
        rateJurisdictions: activities.map((a) => ratesPayload(a, selectedCodes).map((r) => r.jurisdiction)),
    };
}

// ── Mapeo de campos de la API ──────────────────────────────────────────────

/** Campo de la API (`iibb.activities[2].rates[1]`, `phone`, ...) -> clave estable; null si no corresponde a un campo. */
export function keyForApiField(field: string | null | undefined, snap: SubmittedSnapshot): string | null {
    if (!field) return null;
    if (field in GENERAL_LABEL && field !== "activities") return field;
    if (field === "iibb.registration") return "iibbRegistration";
    if (field === "iibb.headquarters") return "headquarters";
    if (field === "iibb.jurisdictions" || /^iibb\.jurisdictions\[\d+\]$/.test(field)) return "jurisdictions";
    const m = /^iibb\.activities\[(\d+)\](?:\.(\w+)(?:\[(\d+)\])?)?$/.exec(field);
    if (m) {
        const uid = snap.activityUids[Number(m[1])];
        if (uid === undefined) return "activities";
        const sub = m[2];
        if (sub === "rates" && m[3] !== undefined) {
            const jur = snap.rateJurisdictions[Number(m[1])]?.[Number(m[3])];
            return jur ? rateFieldKey(uid, jur) : activityFieldKey(uid, "code");
        }
        if (sub === "nomenclator" || sub === "nomenclatorJurisdiction" || sub === "nomenclatorReference" || sub === "code" || sub === "description" || sub === "origin") {
            return activityFieldKey(uid, sub);
        }
        if (sub === "catalogId" || sub === "catalogVersion") return activityFieldKey(uid, "origin");
        return activityFieldKey(uid, "code");
    }
    if (field.startsWith("iibb.activities")) return "activities";
    return null;
}

export function labelForKey(key: string, activities: readonly DraftActivity[], jurisdictionName: (code: string) => string): string {
    if (key in GENERAL_LABEL) return GENERAL_LABEL[key];
    const m = /^act:(\d+):(\w+)(?::(\d+))?$/.exec(key);
    if (!m) return key;
    const index = activities.findIndex((a) => a.uid === Number(m[1]));
    const base = index >= 0 ? activityLabel(index, activities[index]) : "Actividad quitada";
    const sub: Record<string, string> = {
        nomenclator: "nomenclador",
        nomenclatorJurisdiction: "jurisdicción del nomenclador",
        nomenclatorReference: "referencia",
        code: "código",
        description: "descripción",
        origin: "origen",
    };
    if (m[2] === "rate" && m[3]) return `${base}: alícuota en ${jurisdictionName(m[3])}`;
    return `${base}: ${sub[m[2]] ?? m[2]}`;
}

// ── Recolección de errores (cliente) ───────────────────────────────────────

const ACTIVITY_SUBFIELDS = ["nomenclator", "nomenclatorJurisdiction", "nomenclatorReference", "code", "description", "origin"] as const;

export function collectFormErrors(d: DraftForm, jurisdictionName: (code: string) => string): FormError[] {
    const out: Array<{ key: string; message: string }> = [];
    const f = d.fields;
    if (f.name.trim() === "") out.push({ key: "name", message: "el nombre es obligatorio" });
    const cuit = normalizeCuit(f.cuit);
    if (!cuit.ok) out.push({ key: "cuit", message: cuit.error });
    if (!isClientCondition(f.condition.trim())) out.push({ key: "condition", message: "elegí una condición fiscal válida" });
    for (const [k, normalize] of [
        ["phone", normalizeContactPhone],
        ["contactEmail", normalizeContactEmail],
    ] as const) {
        // Edición de un cliente histórico sin contacto: puede seguir pendiente.
        if (d.mode === "edit" && f[k].trim() === "" && d.initialContacts[k].trim() === "") continue;
        const r = normalize(f[k]);
        if (!r.ok) out.push({ key: k, message: d.mode === "edit" && f[k].trim() === "" ? "un contacto ya cargado no se puede vaciar: reemplazalo por otro valor" : r.error });
    }

    // Alícuota del cálculo actual: obligatoria, mismas reglas que la API (parseRate).
    const legacy = f.defaultIibbRate.trim();
    if (legacy === "") out.push({ key: "defaultIibbRate", message: "indicá la alícuota del cálculo actual" });
    else {
        const err = checkRateString(legacy);
        if (err) out.push({ key: "defaultIibbRate", message: err });
    }

    const selected = d.jurisdictions.map((j) => j.code);
    // Nivel perfil (inscripción, jurisdicciones, sede): validador autoritativo sin actividades.
    const profileLevel = validateIibbProfile({ registration: d.registration || null, jurisdictions: d.jurisdictions, activities: [] });
    if (!profileLevel.ok) {
        out.push({ key: keyForApiField(profileLevel.field, { activityUids: [], rateJurisdictions: [] }) ?? "jurisdictions", message: profileLevel.error });
    }
    // Cada actividad por separado (su primer error de datos) y cada alícuota por separado.
    const base = { registration: d.registration || null, jurisdictions: d.jurisdictions };
    const seenKeys = new Map<string, number>();
    for (const a of d.activities) {
        const payload = activityPayload(a, selected);
        const alone = validateIibbProfile({ ...base, activities: [{ ...payload, rates: [] }] });
        if (!alone.ok && !alone.field.startsWith("iibb.activities")) {
            // Problema del perfil ya informado arriba: no se repite por fila.
        } else if (!alone.ok) {
            const sub = /^iibb\.activities\[0\]\.(\w+)/.exec(alone.field)?.[1];
            const field = (ACTIVITY_SUBFIELDS as readonly string[]).includes(sub ?? "") ? (sub as (typeof ACTIVITY_SUBFIELDS)[number]) : sub === "catalogId" || sub === "catalogVersion" ? "origin" : "code";
            out.push({ key: activityFieldKey(a.uid, field), message: alone.error });
        } else {
            const k = activityKey({ nomenclator: payload.nomenclator, nomenclatorJurisdiction: payload.nomenclatorJurisdiction ?? "", code: payload.code.trim() });
            if (seenKeys.has(k)) out.push({ key: activityFieldKey(a.uid, "code"), message: `actividad duplicada: ${payload.code.trim()}` });
            else seenKeys.set(k, a.uid);
        }
        for (const r of payload.rates) {
            const one = validateIibbProfile({ ...base, activities: [{ ...payload, rates: [r] }] });
            if (!one.ok && one.field.startsWith("iibb.activities[0].rates")) out.push({ key: rateFieldKey(a.uid, r.jurisdiction), message: one.error });
        }
    }
    if (d.activities.length > 50) out.push({ key: "activities", message: "demasiadas actividades (máximo 50)" });

    return out.map((e) => ({ ...e, label: labelForKey(e.key, d.activities, jurisdictionName) }));
}

/** Errores de servidor -> forma del formulario. */
export function serverErrorToForm(
    result: { message: string; field?: string | null; fieldMessage?: string | null; stale?: boolean },
    snap: SubmittedSnapshot,
    activities: readonly DraftActivity[],
    jurisdictionName: (code: string) => string,
): { kind: FormErrorKind; errors: FormError[]; message: string } {
    if (result.stale) return { kind: "conflict", errors: [], message: result.message };
    const key = keyForApiField(result.field, snap);
    if (!key) return { kind: "general", errors: [], message: result.message };
    // Junto al campo va el mensaje crudo de la API (sin el prefijo del nombre del campo).
    const message = result.fieldMessage ?? result.message;
    return { kind: "validation", errors: [{ key, label: labelForKey(key, activities, jurisdictionName), message }], message: result.message };
}
