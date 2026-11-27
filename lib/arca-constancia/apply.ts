import type { Constancia } from "./parse";
import { ACTIVITY_DESCRIPTION_MAX } from "../client-profile";

/**
 * Cambios que la constancia propone sobre la ficha IIBB del cliente (lógica
 * pura). Sólo agrega: nunca quita jurisdicciones ni actividades (las quitas
 * siguen el protocolo de confirmación de la ficha); lo que está en la ficha y
 * no en la constancia se informa para revisarlo a mano.
 */

export interface FormIibbState {
    registration: string;
    jurisdictions: Array<{ code: string; headquarters: boolean }>;
    activities: Array<{ nomenclator: string; code: string }>;
}

export interface ConstanciaProposal {
    /** Régimen a aplicar (null: la constancia no lo informa o ya coincide). */
    registration: "CONVENIO_MULTILATERAL" | "LOCAL" | null;
    addJurisdictions: Array<{ code: string; name: string; since: string | null }>;
    /** Sede a marcar (sólo CM; null si no cambia o no se pudo determinar). */
    headquarters: string | null;
    addActivities: Array<{ code: string; description: string; article: string | null; principal: boolean; since: string | null }>;
    /** En la ficha pero no en la constancia (no se quitan solos). */
    onlyInFormJurisdictions: string[];
    onlyInFormActivities: string[];
}

export function proposeFromConstancia(c: Constancia, form: FormIibbState): ConstanciaProposal {
    const regime = c.iibb?.regime ?? null;
    const registration = regime && regime !== form.registration ? regime : null;
    const finalRegime = regime ?? form.registration;
    const inForm = new Set(form.jurisdictions.map((j) => j.code));
    const inPdf = new Set(c.jurisdictions.map((j) => j.code));
    const currentHq = form.jurisdictions.find((j) => j.headquarters)?.code ?? null;
    const naes = new Set(form.activities.filter((a) => a.nomenclator === "NAES").map((a) => a.code));
    const pdfActs = new Set(c.provincialActivities.map((a) => a.code));
    return {
        registration,
        addJurisdictions: c.jurisdictions.filter((j) => !inForm.has(j.code)),
        headquarters: finalRegime === "CONVENIO_MULTILATERAL" && c.headquartersCode && c.headquartersCode !== currentHq ? c.headquartersCode : null,
        addActivities: c.provincialActivities.filter((a) => !naes.has(a.code)).map((a) => ({ ...a, description: fitDescription(a.description) })),
        onlyInFormJurisdictions: c.jurisdictions.length ? form.jurisdictions.filter((j) => !inPdf.has(j.code)).map((j) => j.code) : [],
        onlyInFormActivities: c.provincialActivities.length ? [...naes].filter((code) => !pdfActs.has(code)) : [],
    };
}

export function isEmptyProposal(p: ConstanciaProposal): boolean {
    return !p.registration && !p.headquarters && p.addJurisdictions.length === 0 && p.addActivities.length === 0;
}

/**
 * Algunas descripciones oficiales superan el máximo de la ficha
 * (ACTIVITY_DESCRIPTION_MAX, p. ej. 960999 de Santa Cruz): se recortan en un
 * límite de palabra con «…». El código es lo que identifica la actividad.
 */
export function fitDescription(d: string, max = ACTIVITY_DESCRIPTION_MAX): string {
    if (d.length <= max) return d;
    const cut = d.slice(0, max - 1);
    const sp = cut.lastIndexOf(" ");
    return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;.(]+$/, "")}…`;
}
