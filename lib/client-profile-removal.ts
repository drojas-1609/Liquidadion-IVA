/**
 * Quitas de la ficha IIBB en el formulario (lógica pura, navegador y tests).
 *
 * La base de cada confirmación es lo PERSISTIDO al abrir el formulario
 * (`summarizeStoredProfile` sobre los datos iniciales), no sólo lo visible: si
 * el usuario quitó primero una actividad o una asociación y después la
 * jurisdicción, el aviso igual enumera las asociaciones guardadas que se
 * pierden. El servidor exige exactamente el mismo conjunto (`unconfirmedRemovals`
 * sobre la fila bloqueada), así que cualquier diferencia se rechaza.
 */
import { jurisdictionLabel } from "./iibb/jurisdictions";
import {
    activityKey,
    type ActivityNomenclator,
    type ActivityRemovalConfirmation,
    type IibbProfileData,
    type JurisdictionRemovalConfirmation,
    type StoredIibbProfileSummary,
} from "./client-profile";

/** Actividad tal como la edita el formulario. */
export interface FormActivity {
    /** activityKey de la actividad guardada; null si es nueva. */
    storedKey: string | null;
    nomenclator: ActivityNomenclator;
    nomenclatorJurisdiction: string;
    code: string;
    description: string;
    /** jurisdicción -> asociada, alícuota ("" = sin informar) y tratamiento (EXEMPT = exento). */
    rates: Record<string, { associated: boolean; rate: string; treatment?: string }>;
}

/** Dato de alícuota para los avisos: 0 %, exento y sin informar se distinguen. */
export interface RateDisplay {
    rate: string | null;
    treatment?: string;
}

/** Actividades guardadas al abrir el formulario, por activityKey. */
export type StoredActivityIndex = Record<string, { label: string; rates: Record<string, RateDisplay> }>;

export function storedActivityIndex(
    activities: ReadonlyArray<{
        nomenclator: ActivityNomenclator;
        nomenclatorJurisdiction: string;
        code: string;
        description: string;
        rates: ReadonlyArray<{ jurisdiction: string; rate: string | null; treatment?: string }>;
    }>,
): StoredActivityIndex {
    return Object.fromEntries(
        activities.map((a) => [
            activityKey(a),
            { label: activityLabel(a), rates: Object.fromEntries(a.rates.map((r) => [r.jurisdiction, { rate: r.rate, treatment: r.treatment }])) },
        ]),
    );
}

export function activityLabel(a: { nomenclator: ActivityNomenclator; nomenclatorJurisdiction: string; code: string; description: string }): string {
    const nom = a.nomenclator === "PROVINCIAL" ? `Provincial ${a.nomenclatorJurisdiction}` : a.nomenclator;
    const code = a.code.trim() || "sin código";
    return a.description.trim() ? `${nom} ${code} (${a.description.trim()})` : `${nom} ${code}`;
}

const rateText = (r: RateDisplay | undefined) =>
    r?.treatment === "EXEMPT" ? "exento" : r?.rate === null || r?.rate === undefined || r.rate.trim() === "" ? "sin informar" : `${r.rate.trim()} %`;

/** Lo que se pierde: detalle legible y el conjunto exacto que se confirma. */
export interface RemovalLoss {
    /** Conjunto exacto guardado que se pierde (activityKey o códigos de jurisdicción), ordenado. */
    stored: string[];
    /** Una línea por dato guardado o sin guardar que se pierde. */
    lines: string[];
}

/** Quitar la jurisdicción `code`: asociaciones GUARDADAS + las visibles sin guardar. */
export function jurisdictionRemovalLoss(
    code: string,
    summary: StoredIibbProfileSummary,
    index: StoredActivityIndex,
    rows: readonly FormActivity[],
): RemovalLoss {
    const stored = [...(summary.associationsByJurisdiction[code] ?? [])].sort();
    const lines = stored.map((key) => {
        const s = index[key];
        const removed = !rows.some((r) => r.storedKey === key);
        return `${s?.label ?? key}: alícuota guardada ${rateText(s?.rates[code])}${removed ? " (actividad ya quitada en este formulario)" : ""}`;
    });
    for (const r of rows) {
        if (!r.rates[code]?.associated) continue;
        if (r.storedKey && stored.includes(r.storedKey)) continue;
        lines.push(`${activityLabel(r)}: alícuota sin guardar ${rateText(r.rates[code])}`);
    }
    return { stored, lines };
}

/** Quitar una actividad: la actividad guardada y sus alícuotas guardadas + las visibles sin guardar. */
export function activityRemovalLoss(row: FormActivity, summary: StoredIibbProfileSummary, index: StoredActivityIndex): RemovalLoss {
    const stored = row.storedKey ? [...(summary.activities[row.storedKey] ?? [])].sort() : [];
    const lines: string[] = [];
    if (row.storedKey) {
        lines.push(`Actividad guardada ${index[row.storedKey]?.label ?? activityLabel(row)}`);
        for (const code of stored) lines.push(`${jurisdictionLabel(code)}: alícuota guardada ${rateText(index[row.storedKey]?.rates[code])}`);
    }
    for (const [code, r] of Object.entries(row.rates)) {
        if (!r.associated || stored.includes(code)) continue;
        lines.push(`${jurisdictionLabel(code)}: alícuota sin guardar ${rateText(r)}`);
    }
    return { stored, lines };
}

/**
 * Confirmaciones vigentes para el envío: sólo las de jurisdicciones y
 * actividades que efectivamente faltan en el perfil (si el usuario las volvió a
 * agregar, la confirmación ya no aplica).
 */
export function confirmationsPayload(
    confirmedJurisdictions: Readonly<Record<string, readonly string[]>>,
    confirmedActivities: Readonly<Record<string, readonly string[]>>,
    next: Pick<IibbProfileData, "jurisdictions" | "activities">,
): { confirmRemovedJurisdictions: JurisdictionRemovalConfirmation[]; confirmRemovedActivities: ActivityRemovalConfirmation[] } {
    const codes = new Set(next.jurisdictions.map((j) => j.code));
    const keys = new Set(next.activities.map(activityKey));
    return {
        confirmRemovedJurisdictions: Object.entries(confirmedJurisdictions)
            .filter(([code]) => !codes.has(code))
            .map(([code, associations]) => ({ code, associations: [...associations] })),
        confirmRemovedActivities: Object.entries(confirmedActivities)
            .filter(([key]) => !keys.has(key))
            .map(([key, jurisdictions]) => ({ key, jurisdictions: [...jurisdictions] })),
    };
}
