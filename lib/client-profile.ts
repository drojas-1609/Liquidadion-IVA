/**
 * Ficha del cliente: contactos y perfil de Ingresos Brutos (informativo).
 *
 * Validación PURA compartida por la API (autoridad) y los formularios. Sin
 * `server-only` ni Prisma: las alícuotas se validan como strings con las mismas
 * reglas que `lib/validation/decimal#parseRate` (la API además las convierte a
 * Decimal con parseRate).
 *
 * Nada de esto interviene en la liquidación: el cálculo sigue usando
 * `Client.defaultIibbRate`.
 */
import { isJurisdictionCode, jurisdictionLabel } from "./iibb/jurisdictions";
import {
    IIBB_JURISDICTION_RULES,
    IIBB_REGISTRATION_LABEL,
    MAX_JURISDICTIONS,
    isIibbRegistration,
    type IibbRegistration,
} from "./iibb/registration";

export type FieldResult<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

const fail = (field: string, error: string): { ok: false; field: string; error: string } => ({ ok: false, field, error });

// ── Contactos ───────────────────────────────────────────────────────────────

export const CONTACT_EMAIL_MAX = 254;
export const CONTACT_PHONE_MAX = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
/** Dígitos con separadores habituales y un "+" inicial opcional. */
const PHONE_RE = /^\+?[\d\s().-]+$/;

/**
 * Email de CONTACTO (no domicilio fiscal electrónico). Formato válido no implica
 * titularidad verificada. Se conserva tal como se ingresó (sin espacios en los
 * extremos).
 */
export function normalizeContactEmail(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "email de contacto requerido" };
    const value = raw.trim();
    if (value.length > CONTACT_EMAIL_MAX) return { ok: false, error: `email de contacto demasiado largo (máximo ${CONTACT_EMAIL_MAX})` };
    if (!EMAIL_RE.test(value)) return { ok: false, error: "email de contacto inválido" };
    return { ok: true, value };
}

/**
 * Teléfono de contacto en formato nacional o internacional: dígitos con
 * espacios, guiones, puntos o paréntesis y "+" inicial opcional; entre 6 y 15
 * dígitos (máximo E.164). No se impone un formato argentino.
 */
export function normalizeContactPhone(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "teléfono de contacto requerido" };
    const value = raw.trim().replace(/\s+/g, " ");
    if (value.length > CONTACT_PHONE_MAX) return { ok: false, error: `teléfono demasiado largo (máximo ${CONTACT_PHONE_MAX} caracteres)` };
    if (!PHONE_RE.test(value)) {
        return { ok: false, error: "teléfono inválido: sólo dígitos, espacios, guiones, puntos, paréntesis y un \"+\" inicial" };
    }
    const digits = value.replace(/\D/g, "").length;
    if (digits < 6 || digits > 15) return { ok: false, error: "teléfono inválido: debe tener entre 6 y 15 dígitos" };
    return { ok: true, value };
}

/** Etiqueta legible de los campos nuevos de la ficha (errores de la API); null si no es uno de ellos. */
export function profileFieldLabel(field: string): string | null {
    if (field === "phone") return "Teléfono";
    if (field === "contactEmail") return "Email de contacto";
    if (field === "iibb" || field.startsWith("iibb.")) return "Ingresos Brutos";
    return null;
}

export const CONTACT_PENDING_NOTICE = "Contacto pendiente: el estudio todavía no confirmó teléfono y/o email de este cliente.";

// ── Alícuotas (string, mismas reglas que parseRate) ─────────────────────────

const RATE_RE = /^\d+(\.\d+)?$/;
const RATE_SCALE = 6;

/** Valida una alícuota porcentual: >= 0, <= 100, hasta 6 decimales, sin signo ni exponente. */
export function checkRateString(s: string): string | null {
    if (!RATE_RE.test(s)) return "formato de alícuota inválido (sólo dígitos y punto decimal)";
    const [intPart, frac = ""] = s.split(".");
    if (frac.length > RATE_SCALE) return `demasiados decimales en la alícuota (máximo ${RATE_SCALE})`;
    const int = intPart.replace(/^0+(?=\d)/, "");
    if (int.length > 3 || Number(int) > 100 || (Number(int) === 100 && /[1-9]/.test(frac))) {
        return "la alícuota debe ser menor o igual a 100";
    }
    return null;
}

// ── Actividades ─────────────────────────────────────────────────────────────

export const ACTIVITY_NOMENCLATORS = ["ARCA", "NAES", "PROVINCIAL", "OTRO"] as const;
export type ActivityNomenclator = (typeof ACTIVITY_NOMENCLATORS)[number];

export const ACTIVITY_NOMENCLATOR_LABEL: Readonly<Record<ActivityNomenclator, string>> = {
    ARCA: "ARCA (actividad declarada ante ARCA)",
    NAES: "NAES (Convenio Multilateral / fiscos adheridos)",
    PROVINCIAL: "Nomenclador provincial",
    OTRO: "Otro nomenclador",
};

export function isActivityNomenclator(value: unknown): value is ActivityNomenclator {
    return typeof value === "string" && (ACTIVITY_NOMENCLATORS as readonly string[]).includes(value);
}

export const MAX_ACTIVITIES = 50;
const ACTIVITY_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9.\-/]{0,19}$/;
const ACTIVITY_DESCRIPTION_MAX = 250;
const NOMENCLATOR_REFERENCE_MAX = 60;

/** Clave de duplicado de una actividad: mismo nomenclador (y jurisdicción) y código. */
export function activityKey(a: { nomenclator: string; nomenclatorJurisdiction: string; code: string }): string {
    return `${a.nomenclator}|${a.nomenclatorJurisdiction}|${a.code.toUpperCase()}`;
}

// ── Perfil IIBB ─────────────────────────────────────────────────────────────

export interface IibbJurisdictionData {
    code: string;
    headquarters: boolean;
}
export interface IibbRateData {
    jurisdiction: string;
    /** null = sin informar; "0" = 0 % explícito. */
    rate: string | null;
}
export interface IibbActivityData {
    nomenclator: ActivityNomenclator;
    /** Jurisdicción del nomenclador provincial; "" si no aplica. */
    nomenclatorJurisdiction: string;
    nomenclatorReference: string | null;
    code: string;
    description: string;
    rates: IibbRateData[];
}
export interface IibbProfileData {
    registration: IibbRegistration | null;
    jurisdictions: IibbJurisdictionData[];
    activities: IibbActivityData[];
    /**
     * Jurisdicciones guardadas con asociaciones que el usuario confirmó quitar,
     * con el conjunto EXACTO de asociaciones (activityKey) que vio en el aviso.
     */
    confirmRemovedJurisdictions: JurisdictionRemovalConfirmation[];
    /**
     * Actividades guardadas que el usuario confirmó quitar, con el conjunto
     * EXACTO de jurisdicciones con alícuota guardada que vio en el aviso.
     */
    confirmRemovedActivities: ActivityRemovalConfirmation[];
}

export interface JurisdictionRemovalConfirmation {
    code: string;
    /** activityKey de las asociaciones guardadas que se pierden (ordenadas). */
    associations: string[];
}

export interface ActivityRemovalConfirmation {
    /** activityKey de la actividad guardada. */
    key: string;
    /** Jurisdicciones con asociación guardada que se pierden (ordenadas). */
    jurisdictions: string[];
}

function optionalTrimmed(v: unknown): string | null | undefined {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t === "" ? null : t;
}

const MAX_ACTIVITY_KEY = 120;
const isActivityKeyString = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ACTIVITY_KEY;

/**
 * Lista de confirmaciones `{ <id>: string, <set>: string[] }`. Ausente o null
 * -> []. Un id repetido o un elemento mal formado invalida toda la lista. Los
 * conjuntos se devuelven ordenados y sin repetidos (comparación exacta).
 */
function confirmationList(
    v: unknown,
    idKey: string,
    setKey: string,
    validId: (x: unknown) => x is string,
    validMember: (x: unknown) => x is string,
    maxItems: number,
    maxSet: number,
): Array<{ id: string; set: string[] }> | null {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > maxItems) return null;
    const out: Array<{ id: string; set: string[] }> = [];
    const seen = new Set<string>();
    for (const item of v) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
        const id = (item as Record<string, unknown>)[idKey];
        const set = (item as Record<string, unknown>)[setKey];
        if (!validId(id) || seen.has(id)) return null;
        if (!Array.isArray(set) || set.length > maxSet || !set.every(validMember)) return null;
        seen.add(id);
        out.push({ id, set: [...new Set(set as string[])].sort() });
    }
    return out;
}

/**
 * Valida y normaliza el perfil IIBB completo (reemplazo total). Reglas por
 * inscripción en `IIBB_JURISDICTION_RULES`; sin inscripción no se registran
 * jurisdicciones (se admiten actividades sin alícuotas).
 */
export function validateIibbProfile(raw: unknown): FieldResult<IibbProfileData> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("iibb", "perfil de Ingresos Brutos inválido");
    const b = raw as Record<string, unknown>;

    let registration: IibbRegistration | null = null;
    if (b.registration !== undefined && b.registration !== null && b.registration !== "") {
        if (!isIibbRegistration(b.registration)) {
            return fail("iibb.registration", `inscripción inválida (${Object.values(IIBB_REGISTRATION_LABEL).join(", ")})`);
        }
        registration = b.registration;
    }

    // Jurisdicciones
    const rawJur = b.jurisdictions ?? [];
    if (!Array.isArray(rawJur)) return fail("iibb.jurisdictions", "jurisdicciones inválidas");
    const jurisdictions: IibbJurisdictionData[] = [];
    const seen = new Set<string>();
    for (const [i, j] of rawJur.entries()) {
        if (typeof j !== "object" || j === null) return fail(`iibb.jurisdictions[${i}]`, "jurisdicción inválida");
        const { code, headquarters } = j as Record<string, unknown>;
        if (!isJurisdictionCode(code)) return fail(`iibb.jurisdictions[${i}]`, "jurisdicción inexistente");
        if (seen.has(code)) return fail(`iibb.jurisdictions[${i}]`, `jurisdicción duplicada: ${jurisdictionLabel(code)}`);
        if (headquarters !== undefined && typeof headquarters !== "boolean") {
            return fail(`iibb.jurisdictions[${i}]`, "indicación de sede inválida");
        }
        seen.add(code);
        jurisdictions.push({ code, headquarters: headquarters === true });
    }

    if (registration === null) {
        if (jurisdictions.length > 0) {
            return fail("iibb.registration", "seleccioná la inscripción en Ingresos Brutos antes de registrar jurisdicciones");
        }
    } else {
        const rule = IIBB_JURISDICTION_RULES[registration];
        const label = IIBB_REGISTRATION_LABEL[registration];
        if (jurisdictions.length < rule.min || jurisdictions.length > rule.max) {
            const expected =
                rule.min === rule.max
                    ? `exactamente ${rule.min} jurisdicción`
                    : rule.min === 0
                      ? `hasta ${rule.max} jurisdicciones`
                      : `al menos ${rule.min} jurisdicción`;
            return fail("iibb.jurisdictions", `${label} requiere ${expected}`);
        }
        const hq = jurisdictions.filter((j) => j.headquarters);
        if (rule.headquarters === "required" && hq.length !== 1) {
            return fail("iibb.headquarters", "Convenio Multilateral requiere una única jurisdicción sede, incluida entre las seleccionadas");
        }
        if (rule.headquarters === "forbidden" && hq.length > 0) {
            return fail("iibb.headquarters", `${label} no admite jurisdicción sede (sólo Convenio Multilateral)`);
        }
    }
    const profileCodes = new Set(jurisdictions.map((j) => j.code));

    // Actividades
    const rawAct = b.activities ?? [];
    if (!Array.isArray(rawAct)) return fail("iibb.activities", "actividades inválidas");
    if (rawAct.length > MAX_ACTIVITIES) return fail("iibb.activities", `demasiadas actividades (máximo ${MAX_ACTIVITIES})`);
    const activities: IibbActivityData[] = [];
    const keys = new Set<string>();
    for (const [i, a] of rawAct.entries()) {
        const f = `iibb.activities[${i}]`;
        if (typeof a !== "object" || a === null) return fail(f, "actividad inválida");
        const r = a as Record<string, unknown>;
        if (!isActivityNomenclator(r.nomenclator)) return fail(`${f}.nomenclator`, "nomenclador inválido");
        const nomenclator = r.nomenclator;

        const nj = optionalTrimmed(r.nomenclatorJurisdiction);
        if (nj === undefined) return fail(`${f}.nomenclatorJurisdiction`, "jurisdicción del nomenclador inválida");
        let nomenclatorJurisdiction = "";
        if (nomenclator === "PROVINCIAL") {
            if (!isJurisdictionCode(nj)) return fail(`${f}.nomenclatorJurisdiction`, "indicá la jurisdicción del nomenclador provincial");
            nomenclatorJurisdiction = nj;
        } else if (nj !== null) {
            return fail(`${f}.nomenclatorJurisdiction`, "la jurisdicción del nomenclador sólo aplica a nomencladores provinciales");
        }

        const reference = optionalTrimmed(r.nomenclatorReference);
        if (reference === undefined || (reference !== null && reference.length > NOMENCLATOR_REFERENCE_MAX)) {
            return fail(`${f}.nomenclatorReference`, `referencia del nomenclador inválida (máximo ${NOMENCLATOR_REFERENCE_MAX})`);
        }
        if (nomenclator === "OTRO" && reference === null) return fail(`${f}.nomenclatorReference`, "identificá el nomenclador");

        const code = typeof r.code === "string" ? r.code.trim() : "";
        if (!ACTIVITY_CODE_RE.test(code)) {
            return fail(`${f}.code`, "código de actividad inválido (letras, dígitos, punto, guion o barra; hasta 20)");
        }
        const description = typeof r.description === "string" ? r.description.trim().replace(/\s+/g, " ") : "";
        if (description === "" || description.length > ACTIVITY_DESCRIPTION_MAX) {
            return fail(`${f}.description`, `descripción de actividad requerida (máximo ${ACTIVITY_DESCRIPTION_MAX})`);
        }

        const key = activityKey({ nomenclator, nomenclatorJurisdiction, code });
        if (keys.has(key)) return fail(`${f}.code`, `actividad duplicada: ${code}`);
        keys.add(key);

        const rawRates = r.rates ?? [];
        if (!Array.isArray(rawRates)) return fail(`${f}.rates`, "alícuotas inválidas");
        const rates: IibbRateData[] = [];
        const rateJur = new Set<string>();
        for (const [k, x] of rawRates.entries()) {
            const fr = `${f}.rates[${k}]`;
            if (typeof x !== "object" || x === null) return fail(fr, "alícuota inválida");
            const { jurisdiction, rate } = x as Record<string, unknown>;
            if (!isJurisdictionCode(jurisdiction)) return fail(fr, "jurisdicción inexistente");
            if (!profileCodes.has(jurisdiction)) {
                return fail(fr, `la jurisdicción ${jurisdictionLabel(jurisdiction)} no está registrada para el cliente`);
            }
            if (rateJur.has(jurisdiction)) return fail(fr, `alícuota duplicada para ${jurisdictionLabel(jurisdiction)}`);
            rateJur.add(jurisdiction);
            let value: string | null = null;
            if (rate !== undefined && rate !== null && rate !== "") {
                if (typeof rate !== "string") return fail(fr, "la alícuota debe enviarse como texto");
                const err = checkRateString(rate.trim());
                if (err) return fail(fr, err);
                value = rate.trim();
            }
            rates.push({ jurisdiction, rate: value });
        }

        activities.push({ nomenclator, nomenclatorJurisdiction, nomenclatorReference: reference, code, description, rates });
    }

    const cj = confirmationList(b.confirmRemovedJurisdictions, "code", "associations", isJurisdictionCode, isActivityKeyString, MAX_JURISDICTIONS, MAX_ACTIVITIES);
    if (cj === null) return fail("iibb.confirmRemovedJurisdictions", "confirmación de jurisdicciones inválida");
    const ca = confirmationList(b.confirmRemovedActivities, "key", "jurisdictions", isActivityKeyString, isJurisdictionCode, MAX_ACTIVITIES, MAX_JURISDICTIONS);
    if (ca === null) return fail("iibb.confirmRemovedActivities", "confirmación de actividades inválida");
    const confirmRemovedJurisdictions = cj.map(({ id, set }) => ({ code: id, associations: set }));
    const confirmRemovedActivities = ca.map(({ id, set }) => ({ key: id, jurisdictions: set }));

    return {
        ok: true,
        value: { registration, jurisdictions, activities, confirmRemovedJurisdictions, confirmRemovedActivities },
    };
}

/**
 * Asociaciones GUARDADAS del perfil, en ambas direcciones. Es la base exacta de
 * las confirmaciones de quita: la usa el servidor (sobre la fila bloqueada) y
 * el formulario (sobre lo persistido al abrirlo), así ambos piden lo mismo.
 */
export interface StoredIibbProfileSummary {
    /** Jurisdicción guardada -> activityKey con asociación guardada (ordenadas). */
    associationsByJurisdiction: Record<string, string[]>;
    /** activityKey guardada -> jurisdicciones con asociación guardada (ordenadas). */
    activities: Record<string, string[]>;
}

export function summarizeStoredProfile(p: {
    jurisdictions: ReadonlyArray<{ code: string }>;
    activities: ReadonlyArray<{ nomenclator: string; nomenclatorJurisdiction: string; code: string; rates: ReadonlyArray<{ jurisdiction: string }> }>;
}): StoredIibbProfileSummary {
    const associationsByJurisdiction: Record<string, string[]> = {};
    const activities: Record<string, string[]> = {};
    for (const j of p.jurisdictions) associationsByJurisdiction[j.code] = [];
    for (const a of p.activities) {
        const key = activityKey(a);
        activities[key] = [...new Set(a.rates.map((r) => r.jurisdiction))].sort();
        for (const code of activities[key]) (associationsByJurisdiction[code] ??= []).push(key);
    }
    for (const code of Object.keys(associationsByJurisdiction)) associationsByJurisdiction[code].sort();
    return { associationsByJurisdiction, activities };
}

/**
 * Confirmaciones que exige pasar de lo guardado a `next`: cada jurisdicción
 * guardada que se quita y tenía asociaciones guardadas (aunque la actividad o la
 * asociación ya se hayan quitado antes en el formulario) y cada actividad
 * guardada que se quita, con el conjunto exacto de lo que se pierde.
 */
export function requiredRemovalConfirmations(
    stored: StoredIibbProfileSummary,
    next: Pick<IibbProfileData, "jurisdictions" | "activities">,
): { jurisdictions: JurisdictionRemovalConfirmation[]; activities: ActivityRemovalConfirmation[] } {
    const nextCodes = new Set(next.jurisdictions.map((j) => j.code));
    const nextKeys = new Set(next.activities.map(activityKey));
    return {
        jurisdictions: Object.entries(stored.associationsByJurisdiction)
            .filter(([code, keys]) => keys.length > 0 && !nextCodes.has(code))
            .map(([code, associations]) => ({ code, associations }))
            .sort((x, y) => x.code.localeCompare(y.code)),
        activities: Object.entries(stored.activities)
            .filter(([key]) => !nextKeys.has(key))
            .map(([key, jurisdictions]) => ({ key, jurisdictions }))
            .sort((x, y) => x.key.localeCompare(y.key)),
    };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    const x = [...new Set(a)].sort();
    const y = [...new Set(b)].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Quitas sin una confirmación EXACTA: falta la confirmación o el conjunto
 * confirmado no coincide con lo que realmente se pierde (por ejemplo, otra
 * persona agregó asociaciones después del aviso). Nada se elimina en silencio.
 */
export function unconfirmedRemovals(
    stored: StoredIibbProfileSummary,
    next: IibbProfileData,
): { jurisdictions: string[]; activities: string[] } {
    const required = requiredRemovalConfirmations(stored, next);
    return {
        jurisdictions: required.jurisdictions
            .filter((r) => {
                const c = next.confirmRemovedJurisdictions.find((x) => x.code === r.code);
                return !c || !sameSet(c.associations, r.associations);
            })
            .map((r) => r.code),
        activities: required.activities
            .filter((r) => {
                const c = next.confirmRemovedActivities.find((x) => x.key === r.key);
                return !c || !sameSet(c.jurisdictions, r.jurisdictions);
            })
            .map((r) => r.key),
    };
}
