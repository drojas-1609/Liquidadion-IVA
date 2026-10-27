import { describe, it, expect } from "vitest";
import { verifyProfileSources, type StoredProfileForSources } from "@/lib/iibb-profile-sources";
import { selectionFromEntry } from "@/lib/activity-catalog/types";
import type { IibbActivityData } from "@/lib/client-profile";
import { NAES_PENDING, NAES_V1, PENDING_RULES, rule, ruleSet } from "./_fixtures/catalogs";

const CATALOGS = [NAES_V1, NAES_PENDING];
const RULES = [
    ruleSet({}, [
        rule({ id: "r1", rate: "3.5" }),
        rule({ id: "ex", activityCodes: ["620900"], treatment: "EXEMPT", rate: null }),
        rule({ id: "umbral", rate: "5", conditions: [{ kind: "PRIOR_YEAR_GROSS_INCOME", minExclusive: "100", maxInclusive: null, description: "Ingresos > $100" }] }),
        rule({ id: "hecho", rate: "4", conditions: [{ kind: "DECLARED_FACT", factKey: "sinOtro", expected: true, description: "Sin otro tratamiento" }] }),
        rule({ id: "cm", rate: "2", registrations: ["CONVENIO_MULTILATERAL"] }),
    ]),
];

function fromCatalog(code: string, over: Partial<IibbActivityData> = {}): IibbActivityData {
    const entry = NAES_V1.entries.find((e) => e.code === code)!;
    const s = selectionFromEntry(NAES_V1.manifest, entry);
    return {
        nomenclator: "NAES",
        nomenclatorJurisdiction: "",
        nomenclatorReference: s.reference,
        code: s.code,
        description: s.description,
        origin: "CATALOG",
        catalogId: s.catalogId,
        catalogVersion: s.catalogVersion,
        rates: [],
        ...over,
    };
}
const manual = (over: Partial<IibbActivityData> = {}): IibbActivityData => ({
    nomenclator: "NAES",
    nomenclatorJurisdiction: "",
    nomenclatorReference: null,
    code: "620100",
    description: "Texto libre del estudio",
    origin: "MANUAL",
    catalogId: null,
    catalogVersion: null,
    rates: [],
    ...over,
});
const verify = (activities: IibbActivityData[], stored: StoredProfileForSources | null = null) => verifyProfileSources({ activities, registration: null }, stored, CATALOGS, RULES);

describe("procedencia de actividades de catálogo", () => {
    it("copia exacta de un catálogo revisado: aceptada", () => {
        expect(verify([fromCatalog("620100")])).toBeNull();
    });
    it("carga manual (histórica o no catalogada): no se verifica contra catálogos", () => {
        expect(verify([manual({ code: "ZZ01", nomenclator: "OTRO", nomenclatorReference: "Nomenclador viejo" })])).toBeNull();
    });
    it("descripción, versión, referencia o nomenclador alterados: rechazada con campo de la fila", () => {
        for (const over of [{ description: "Otra" }, { catalogVersion: "X" }, { nomenclatorReference: "Otra ref" }, { nomenclator: "ARCA" as const }]) {
            expect(verify([manual(), fromCatalog("620100", over)])?.field).toBe("iibb.activities[1].code");
        }
    });
    it("código inexistente o catálogo pendiente de revisión: rechazada", () => {
        expect(verify([fromCatalog("620100", { code: "620199" })])?.error).toMatch(/no figura en un catálogo revisado/);
        expect(verify([fromCatalog("620100", { catalogId: "fixture-naes-pending", code: "999999" })])?.error).toMatch(/no figura en un catálogo revisado/);
    });
    it("guardada y SIN cambios: no se reverifica aunque el catálogo ya no esté publicado", () => {
        const old = fromCatalog("620100", { catalogId: "catalogo-retirado", catalogVersion: "Vieja", nomenclatorReference: "Ref vieja" });
        const stored: StoredProfileForSources = { activities: [{ ...old, rates: [] }] };
        expect(verify([old], stored)).toBeNull();
        // Si se modifica la copia, sí se verifica (y falla: no coincide con un catálogo publicado).
        expect(verify([{ ...old, description: "Editada" }], stored)).not.toBeNull();
    });
});

describe("procedencia de sugerencias confirmadas", () => {
    const rate = (over: Partial<IibbActivityData["rates"][number]>) => ({ jurisdiction: "901", rate: "3.5", treatment: "RATE" as const, origin: "CONFIRMED_SUGGESTION" as const, ruleRef: "fixture-rules-901#r1", ...over });

    it("coincide con la regla revisada: aceptada (también desde carga manual con el código de la regla)", () => {
        expect(verify([fromCatalog("620100", { rates: [rate({})] })])).toBeNull();
        expect(verify([manual({ rates: [rate({ rate: "3.50" })] })])).toBeNull();
    });
    it("valor, tratamiento, jurisdicción o código distintos de la regla: rechazada", () => {
        expect(verify([fromCatalog("620100", { rates: [rate({ rate: "4" })] })])?.error).toMatch(/no coincide con la regla/);
        expect(verify([fromCatalog("620100", { rates: [rate({ treatment: "EXEMPT", rate: null })] })])?.error).toMatch(/no coincide con la regla/);
        expect(verify([fromCatalog("620100", { rates: [rate({ jurisdiction: "902" })] })])?.error).toMatch(/no corresponde/);
        expect(verify([fromCatalog("011111", { rates: [rate({})] })])?.error).toMatch(/no corresponde/);
    });
    it("regla inexistente o de un conjunto pendiente: rechazada", () => {
        expect(verify([fromCatalog("620100", { rates: [rate({ ruleRef: "fixture-rules-901#nope" })] })])?.field).toBe("iibb.activities[0].rates[0]");
        const pendingSets = [ruleSet({ review: PENDING_RULES }, [rule({ rate: "3.5" })])];
        expect(verifyProfileSources({ activities: [fromCatalog("620100", { rates: [rate({})] })], registration: null }, null, CATALOGS, pendingSets)).not.toBeNull();
    });
    it("exención confirmada desde la regla", () => {
        expect(verify([fromCatalog("620900", { rates: [rate({ treatment: "EXEMPT", rate: null, ruleRef: "fixture-rules-901#ex" })] })])).toBeNull();
    });
    it("tasa manual del estudio: no requiere regla", () => {
        expect(verify([manual({ rates: [rate({ origin: "STUDIO_MANUAL", ruleRef: null, rate: "7" })] })])).toBeNull();
    });
    it("regla con condiciones de ingresos o hechos declarados: NO se guarda como sugerencia (no se acredita al guardar)", () => {
        expect(verify([fromCatalog("620100", { rates: [rate({ rate: "5", ruleRef: "fixture-rules-901#umbral" })] })])?.error).toMatch(/decisión del estudio/);
        expect(verify([fromCatalog("620100", { rates: [rate({ rate: "4", ruleRef: "fixture-rules-901#hecho" })] })])?.error).toMatch(/decisión del estudio/);
        // La misma tasa como decisión del estudio, sin procedencia normativa, sí se guarda.
        expect(verify([fromCatalog("620100", { rates: [rate({ rate: "5", origin: "STUDIO_MANUAL", ruleRef: null })] })])).toBeNull();
    });
    it("regla que exige una inscripción: sólo si coincide con la de la ficha", () => {
        const a = [fromCatalog("620100", { rates: [rate({ rate: "2", ruleRef: "fixture-rules-901#cm" })] })];
        expect(verify(a)?.error).toMatch(/inscripción/);
        expect(verifyProfileSources({ activities: a, registration: "LOCAL" }, null, CATALOGS, RULES)?.error).toMatch(/inscripción/);
        expect(verifyProfileSources({ activities: a, registration: "CONVENIO_MULTILATERAL" }, null, CATALOGS, RULES)).toBeNull();
        // Guardada sin cambios en la alícuota, pero la ficha cambia de inscripción: se rechaza.
        const stored = { activities: a };
        expect(verifyProfileSources({ activities: a, registration: "CONVENIO_MULTILATERAL" }, stored, CATALOGS, RULES)).toBeNull();
        expect(verifyProfileSources({ activities: a, registration: "LOCAL" }, stored, CATALOGS, RULES)?.error).toMatch(/inscripción/);
    });
    it("sugerencia guardada sin cambios: no se reverifica si la norma se retiró", () => {
        const a = fromCatalog("620100", { rates: [rate({ ruleRef: "norma-retirada#r9", rate: "2" })] });
        expect(verify([a], { activities: [a] })).toBeNull();
    });
});
