import { describe, it, expect } from "vitest";
import { summarizeStoredProfile, unconfirmedRemovals, validateIibbProfile, type IibbProfileData } from "@/lib/client-profile";
import {
    activityRemovalLoss,
    confirmationsPayload,
    jurisdictionRemovalLoss,
    storedActivityIndex,
    type FormActivity,
} from "@/lib/client-profile-removal";

/**
 * B1: las confirmaciones del formulario se calculan sobre lo PERSISTIDO al
 * abrirlo (además de lo visible) y coinciden con lo que exige el servidor
 * (`unconfirmedRemovals`). Datos SINTÉTICOS.
 */

// Guardado al abrir: CM con 901 (sede), 902, 921; NAES 620100 en 901 (3.5) y
// 902 (sin informar); ARCA 702092 en 902 (0 explícito).
const initialActivities = [
    { nomenclator: "NAES" as const, nomenclatorJurisdiction: "", nomenclatorReference: null, code: "620100", description: "Servicios de prueba", rates: [{ jurisdiction: "901", rate: "3.5" }, { jurisdiction: "902", rate: null }] },
    { nomenclator: "ARCA" as const, nomenclatorJurisdiction: "", nomenclatorReference: null, code: "702092", description: "Otra", rates: [{ jurisdiction: "902", rate: "0" }] },
];
const initial = { jurisdictions: [{ code: "901", headquarters: true }, { code: "902", headquarters: false }, { code: "921", headquarters: false }], activities: initialActivities };
const NAES_KEY = "NAES||620100";
const ARCA_KEY = "ARCA||702092";
const summary = summarizeStoredProfile(initial);
const index = storedActivityIndex(initialActivities);

const row = (a: (typeof initialActivities)[number]): FormActivity => ({
    storedKey: `${a.nomenclator}|${a.nomenclatorJurisdiction}|${a.code}`,
    nomenclator: a.nomenclator,
    nomenclatorJurisdiction: a.nomenclatorJurisdiction,
    code: a.code,
    description: a.description,
    rates: Object.fromEntries(a.rates.map((r) => [r.jurisdiction, { associated: true, rate: r.rate ?? "" }])),
});
const NAES_ROW = row(initialActivities[0]);
const ARCA_ROW = row(initialActivities[1]);

/** Perfil validado que enviaría el formulario + sus confirmaciones. */
function submitted(
    jurisdictions: string[],
    rows: FormActivity[],
    confirmedJ: Record<string, string[]>,
    confirmedA: Record<string, string[]>,
): IibbProfileData {
    const r = validateIibbProfile({
        registration: "CONVENIO_MULTILATERAL",
        jurisdictions: jurisdictions.map((code) => ({ code, headquarters: code === "901" })),
        activities: rows.map((a) => ({
            nomenclator: a.nomenclator,
            code: a.code,
            description: a.description,
            rates: Object.entries(a.rates)
                .filter(([code, x]) => x.associated && jurisdictions.includes(code))
                .map(([jurisdiction, x]) => ({ jurisdiction, rate: x.rate === "" ? null : x.rate })),
        })),
    });
    if (!r.ok) throw new Error(r.error);
    return { ...r.value, ...confirmationsPayload(confirmedJ, confirmedA, r.value) };
}

describe("aviso de quita: describe exactamente lo que se pierde", () => {
    it("jurisdicción: cada asociación guardada con su alícuota (0 explícito vs sin informar)", () => {
        const loss = jurisdictionRemovalLoss("902", summary, index, [NAES_ROW, ARCA_ROW]);
        expect(loss.stored).toEqual([ARCA_KEY, NAES_KEY]);
        expect(loss.lines).toEqual([
            "ARCA 702092 (Otra): alícuota guardada 0 %",
            "NAES 620100 (Servicios de prueba): alícuota guardada sin informar",
        ]);
    });
    it("actividad guardada: la actividad y cada alícuota guardada", () => {
        const loss = activityRemovalLoss(NAES_ROW, summary, index);
        expect(loss.stored).toEqual(["901", "902"]);
        expect(loss.lines).toEqual([
            "Actividad guardada NAES 620100 (Servicios de prueba)",
            "901 · Ciudad Autónoma de Buenos Aires: alícuota guardada 3.5 %",
            "902 · Buenos Aires: alícuota guardada sin informar",
        ]);
    });
    it("datos visibles sin guardar se enumeran aparte (y no entran en el conjunto confirmado)", () => {
        const nueva: FormActivity = { storedKey: null, nomenclator: "OTRO", nomenclatorJurisdiction: "", code: "X1", description: "Nueva", rates: { "921": { associated: true, rate: "2" } } };
        const loss = jurisdictionRemovalLoss("921", summary, index, [NAES_ROW, ARCA_ROW, nueva]);
        expect(loss.stored).toEqual([]);
        expect(loss.lines).toEqual(["OTRO X1 (Nueva): alícuota sin guardar 2 %"]);
        expect(activityRemovalLoss(nueva, summary, index)).toEqual({ stored: [], lines: ["921 · Santa Fe: alícuota sin guardar 2 %"] });
    });
    it("jurisdicción sin nada asociado: sin aviso", () => {
        expect(jurisdictionRemovalLoss("921", summary, index, [NAES_ROW, ARCA_ROW])).toEqual({ stored: [], lines: [] });
    });
});

describe("secuencias de quita (B1)", () => {
    it("quitar primero la actividad y después su jurisdicción: el aviso igual enumera la asociación guardada", () => {
        // 1) Quita NAES (aviso confirmado con sus jurisdicciones guardadas).
        const confirmedA = { [NAES_KEY]: activityRemovalLoss(NAES_ROW, summary, index).stored };
        // 2) Quita 902: en pantalla ya no hay asociación NAES, pero lo guardado sí.
        const loss = jurisdictionRemovalLoss("902", summary, index, [ARCA_ROW]);
        expect(loss.stored).toEqual([ARCA_KEY, NAES_KEY]);
        expect(loss.lines[1]).toBe("NAES 620100 (Servicios de prueba): alícuota guardada sin informar (actividad ya quitada en este formulario)");
        const confirmedJ = { "902": loss.stored };
        const next = submitted(["901", "921"], [ARCA_ROW], confirmedJ, confirmedA);
        expect(unconfirmedRemovals(summary, next)).toEqual({ jurisdictions: [], activities: [] });
    });

    it("quitar primero la asociación y después la jurisdicción: el aviso incluye la asociación guardada", () => {
        const naesSin902: FormActivity = { ...NAES_ROW, rates: { "901": NAES_ROW.rates["901"] } };
        const loss = jurisdictionRemovalLoss("902", summary, index, [naesSin902, ARCA_ROW]);
        expect(loss.stored).toEqual([ARCA_KEY, NAES_KEY]);
        const next = submitted(["901", "921"], [naesSin902, ARCA_ROW], { "902": loss.stored }, {});
        expect(unconfirmedRemovals(summary, next)).toEqual({ jurisdictions: [], activities: [] });
    });

    it("antes de B1 (confirmación sólo por lo visible) el servidor lo rechazaba: ahora el formulario lo detecta", () => {
        const next = submitted(["901", "921"], [ARCA_ROW], {}, { [NAES_KEY]: ["901", "902"] });
        expect(unconfirmedRemovals(summary, next).jurisdictions).toEqual(["902"]);
    });

    it("una confirmación de OTRO conjunto queda invalidada", () => {
        const next = submitted(["901", "921"], [ARCA_ROW], { "902": [NAES_KEY] }, { [NAES_KEY]: ["901", "902"] });
        expect(unconfirmedRemovals(summary, next).jurisdictions).toEqual(["902"]);
    });

    it("si se vuelve a agregar la jurisdicción, su confirmación no se envía", () => {
        const next = submitted(["901", "902", "921"], [NAES_ROW, ARCA_ROW], { "902": [ARCA_KEY, NAES_KEY] }, {});
        expect(next.confirmRemovedJurisdictions).toEqual([]);
        expect(unconfirmedRemovals(summary, next)).toEqual({ jurisdictions: [], activities: [] });
    });

    it("si se vuelve a agregar una actividad con la misma clave, su confirmación no se envía", () => {
        const next = submitted(["901", "902", "921"], [{ ...NAES_ROW, storedKey: null }, ARCA_ROW], {}, { [NAES_KEY]: ["901", "902"] });
        expect(next.confirmRemovedActivities).toEqual([]);
    });

    it("con lo guardado cambiado por otra persona (incorporación concurrente), la confirmación vieja no alcanza", () => {
        const concurrent = summarizeStoredProfile({
            jurisdictions: initial.jurisdictions,
            activities: [...initialActivities, { nomenclator: "OTRO", nomenclatorJurisdiction: "", code: "Z9", rates: [{ jurisdiction: "902" }] }],
        });
        const next = submitted(["901", "921"], [NAES_ROW, ARCA_ROW].map((r) => ({ ...r, rates: { ...r.rates, "902": { associated: false, rate: "" } } })), { "902": [ARCA_KEY, NAES_KEY] }, {});
        expect(unconfirmedRemovals(summary, next).jurisdictions).toEqual([]);
        expect(unconfirmedRemovals(concurrent, next).jurisdictions).toEqual(["902"]);
    });
});
