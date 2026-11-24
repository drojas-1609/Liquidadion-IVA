/**
 * Decisiones del estudio (Diego Rojas, 24/11/2026) sobre las reglas de ARBA 2026
 * que estaban retenidas (docs/catalogos-actividades/REVISION.md, fichas B2 a B5):
 *
 *  - B2/B3: códigos con `bonif_actiba = S` o `AlicuotaSUS` en la exportación de
 *    ARBA → se habilitan los tramos del art. 20 con un AVISO (campo sin
 *    definición normativa: verificar antes de confirmar).
 *  - B4: tratamientos especiales como ALTERNATIVA excluyente, sujeta a un hecho
 *    declarado por el estudio:
 *      · art. 22: 1,5 % para 390000 y 812090 prestadas a municipios por quienes
 *        también desarrollan 381100/381200;
 *      · art. 134: 2 % para las actividades del art. 184 bis del Código Fiscal
 *        (servicios digitales de prestadores no residentes): 631201 a 631204.
 *    Los tramos exigen el hecho contrario.
 *  - B5: se mantiene el hecho «no inició actividades en el ejercicio»; el límite
 *    de Convenio Multilateral queda para la F4; la errata del tramo 6 se lee
 *    según el texto en letras.
 *
 * Puro: lo usan el generador (arba-2026.ts) y `arba-2026-decisiones`, que aplica
 * lo mismo al conjunto ya generado sin volver a leer las fuentes.
 */
import type { RateRule, RateRuleSet, RuleCondition } from "../../lib/iibb-rates/types";

export const ART22_CODES = ["390000", "812090"] as const;
export const ART134_CODES = ["631201", "631202", "631203", "631204"] as const;

export const CAVEAT_ARBA_FLAGS =
    "La exportación oficial de ARBA marca este código con «bonif_actiba» o «AlicuotaSUS», campos sin definición en la Ley 15.558: puede haber una bonificación o una alícuota especial no modelada. Verificar antes de confirmar.";

const FACT_ART22 = (expected: boolean): RuleCondition => ({
    kind: "DECLARED_FACT",
    factKey: "pbaArt22Municipios",
    expected,
    description: expected
        ? "Los servicios se prestan a Municipios de la Provincia por un contribuyente que también desarrolla las actividades 381100 y 381200 (art. 22, Ley 15.558)"
        : "Los servicios NO se prestan a Municipios en las condiciones del art. 22 de la Ley 15.558",
});

const FACT_ART134 = (expected: boolean): RuleCondition => ({
    kind: "DECLARED_FACT",
    factKey: "pbaArt184bisNoResidente",
    expected,
    description: expected
        ? "Servicios digitales prestados por un sujeto no residente en el país (art. 184 bis del Código Fiscal; art. 134, Ley 15.558)"
        : "El prestador NO es un sujeto no residente comprendido en el art. 184 bis del Código Fiscal (art. 134, Ley 15.558)",
});

export type ArbaTreatment = "NORMAL" | "AVISO" | "ART22" | "ART134";

export function arbaTreatment(code: string, unknownFlags: boolean): ArbaTreatment {
    if ((ART22_CODES as readonly string[]).includes(code)) return "ART22";
    if ((ART134_CODES as readonly string[]).includes(code)) return "ART134";
    return unknownFlags ? "AVISO" : "NORMAL";
}

/** Sufijo del id de la regla según el tratamiento (estable, sin hash). */
export const TREATMENT_SUFFIX: Readonly<Record<ArbaTreatment, string>> = { NORMAL: "", AVISO: "-aviso", ART22: "-no-art22", ART134: "-no-art134" };

/** Lo que el tratamiento agrega a una regla de tramos. */
export function treatmentExtras(t: ArbaTreatment): { conditions: RuleCondition[]; caveat?: string } {
    if (t === "AVISO") return { conditions: [], caveat: CAVEAT_ARBA_FLAGS };
    if (t === "ART22") return { conditions: [FACT_ART22(false)] };
    if (t === "ART134") return { conditions: [FACT_ART134(false)] };
    return { conditions: [] };
}

/** Alternativas de los tratamientos especiales (excluyentes de los tramos). */
export function specialRules(common: readonly RuleCondition[]): RateRule[] {
    const base = { registrations: ["LOCAL", "CONVENIO_MULTILATERAL"] as RateRule["registrations"], validFrom: null, validTo: null, treatment: "RATE" as const };
    return [
        { ...base, id: "art22-municipios", activityCodes: [...ART22_CODES], rate: "1.5", conditions: [...common, FACT_ART22(true)], legalReference: "Ley 15.558, art. 22 (exportación ARBA: «Art.22», 1,5 %)" },
        { ...base, id: "art134-no-residentes", activityCodes: [...ART134_CODES], rate: "2", conditions: [...common, FACT_ART134(true)], legalReference: "Ley 15.558, art. 134 y art. 184 bis del Código Fiscal (exportación ARBA: «Art.134», 2 %)" },
    ];
}

const HOLD_FLAGS = "Exportación de ARBA con bonif_actiba";
const HOLD_SPECIAL = "Además de los tramos, ARBA publica un tratamiento especial";

/**
 * Aplica las decisiones a un conjunto ya generado (con reglas retenidas): las
 * mismas reglas que regenerar (ids, códigos y condiciones salen de las mismas
 * funciones; puede variar sólo el orden de las claves). Idempotente.
 */
export function applyArbaDecisions(set: RateRuleSet, common: readonly RuleCondition[]): RateRuleSet {
    const out = new Map<string, RateRule>();
    for (const r of set.rules) {
        const hold = r.pendingInterpretation;
        if (!hold) {
            out.set(r.id, r);
            continue;
        }
        if (!hold.startsWith(HOLD_FLAGS) && !hold.startsWith(HOLD_SPECIAL)) throw new Error(`regla ${r.id}: retención no prevista por las decisiones`);
        const baseId = r.id.replace(/-h[0-9a-z]+$/, "");
        for (const code of r.activityCodes) {
            const t = arbaTreatment(code, hold.startsWith(HOLD_FLAGS));
            const id = `${baseId}${TREATMENT_SUFFIX[t]}`;
            const prev = out.get(id);
            if (prev) {
                prev.activityCodes.push(code);
                continue;
            }
            const { pendingInterpretation: _held, ...rest } = r;
            const extra = treatmentExtras(t);
            out.set(id, { ...rest, id, activityCodes: [code], conditions: [...r.conditions, ...extra.conditions], ...(extra.caveat ? { caveat: extra.caveat } : {}) });
        }
    }
    for (const s of specialRules(common)) if (!out.has(s.id)) out.set(s.id, s);
    return { ...set, rules: [...out.values()] };
}
