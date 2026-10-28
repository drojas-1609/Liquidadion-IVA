import { describe, it, expect } from "vitest";
import { ARTICLES, buildCabaRules, percentToRate, readPlanillas, specialArticleCodes, type PlanillaRow } from "@/scripts/iibb-rates/caba-2026";
import { parsePdfLines } from "@/scripts/activity-catalogs/pdf-table";
import { suggestRate, type RateQuery } from "@/lib/iibb-rates/suggest";
import { validateRuleSet } from "@/lib/iibb-rates/validate";
import { ruleSet } from "./_fixtures/catalogs";

/** Planillas SINTÉTICAS con la disposición del Anexo de la Ley 6927 (código a la izquierda, tasas a la derecha). */
const LINES = parsePdfLines(
    [
        "34|947.0|102.9|509.2|APARTADO I – ARTÍCULO 1°. PLANILLA ADJUNTA DE ACTIVIDADES 1 –",
        "34|900.0|101.4|133.0|011111",
        "34|900.0|148.9|300.0|Cultivo de prueba",
        "34|900.0|487.4|515.6|0,00%",
        "49|947.0|99.5|512.5|APARTADO III – ARTÍCULO 3°. PLANILLA ADJUNTA DE ACTIVIDADES 3 –",
        "49|799.2|100.5|133.7|351110",
        "49|799.2|148.9|347.8|Generación de prueba",
        "49|799.2|421.9|450.0|3,00%",
        "49|799.2|492.7|520.9|3,75%",
        "49|488.8|100.5|133.7|352022",
        "49|488.8|148.9|350.2|Distribución de prueba en",
        "49|480.2|148.9|182.7|dos renglones",
        "49|485.9|421.9|450.0|3,00%",
        "49|485.9|492.7|520.9|3,75%",
    ].join("\n"),
);

describe("planillas de la Ley Impositiva CABA 2026", () => {
    it("lee código y tasas de cada fila, incluso con la descripción en dos renglones", () => {
        expect(readPlanillas(LINES)).toEqual([
            { planilla: 1, code: "011111", rates: ["0,00%"] },
            { planilla: 3, code: "351110", rates: ["3,00%", "3,75%"] },
            { planilla: 3, code: "352022", rates: ["3,00%", "3,75%"] },
        ]);
    });
    it("tasas del PDF: «0,00%» es 0 explícito (no exento); «3,75%» -> 3.75", () => {
        expect(percentToRate("0,00%")).toBe("0");
        expect(percentToRate("3,75%")).toBe("3.75");
        expect(percentToRate("5,00%")).toBe("5");
        expect(() => percentToRate("Exento")).toThrow(/no reconocida/);
    });
    it("códigos citados en los arts. 12 a 21 y 26 (tratamientos especiales)", () => {
        const text = "Artículo 11.- 111111\nArtículo 12.- ... 351110 ...\nArtículo 21.- 222222\nArtículo 22.- 333333\nArtículo 26.\n551010 Alojamiento\nArtículo 27.- 444444";
        expect([...specialArticleCodes(text)].sort()).toEqual(["222222", "351110", "551010"]);
        expect(() => specialArticleCodes("sin articulado")).toThrow(/no se encontraron/);
    });
});

const ROWS: PlanillaRow[] = [
    ...ARTICLES.map((a) => ({
        planilla: a.article,
        code: `9${String(a.article).padStart(2, "0")}001`,
        rates: a.rate !== undefined ? [`${a.rate},00%`] : [a.tiers!.ley6927.low, a.tiers!.ley6927.high].map((r) => `${r.includes(".") ? r.replace(".", ",").padEnd(4, "0") : `${r},00`}%`),
    })),
    { planilla: 5, code: "905099", rates: ["3,00%", "5,00%"] },
    // Código en dos planillas (como 301200 en las Planillas 2 y 5): encuadre ambiguo.
    { planilla: 2, code: "999001", rates: ["1,00%"] },
    { planilla: 5, code: "999001", rates: ["3,00%", "5,00%"] },
];
const CODES = new Set(ROWS.map((r) => r.code));

describe("reglas generadas para CABA 2026", () => {
    const { rules, excluded, exclusions } = buildCabaRules(ROWS, new Set(["905099"]), CODES);
    const set = ruleSet({ id: "caba-ley-6927-2026", jurisdiction: "901", catalogIds: ["naes-rg-ca-19-2025"], validFrom: "2026-01-01", validTo: "2026-12-31" }, rules);
    const q = (over: Partial<RateQuery>): RateQuery => ({
        jurisdiction: "901",
        nomenclator: "NAES",
        catalogId: "naes-rg-ca-19-2025",
        code: "905001",
        date: "2026-03-01",
        registration: null,
        facts: {},
        ...over,
    });

    it("estructura válida; tratamientos especiales y códigos en dos planillas quedan sin tasa automática", () => {
        expect(validateRuleSet(set)).toEqual([]);
        expect(excluded).toEqual(["905099"]);
        expect(exclusions.ambiguous).toEqual([{ code: "999001", planillas: [2, 5] }]);
        expect(suggestRate([set], q({ code: "905099" })).status).toBe("SIN_REGLA");
        expect(suggestRate([set], q({ code: "999001", facts: { declared: { cabaSinOtroTratamiento: true } } })).status).toBe("SIN_REGLA");
    });
    it("retenidas: las reglas de la Ley 6948 (desde junio) y el 4 % residencial del art. 3°", () => {
        const held = rules.filter((r) => r.pendingInterpretation).map((r) => r.id);
        expect(held).toContain("a3-residencial");
        expect(held.filter((id) => id.includes("jun-dic"))).toHaveLength(14);
        expect(rules.filter((r) => r.id.includes("ene-may")).every((r) => r.pendingInterpretation === undefined)).toBe(true);
    });
    it("una tasa del PDF distinta de la del artículo, o un código ausente del catálogo, hacen fallar la generación", () => {
        const wrong = ROWS.map((r) => (r.code === "905001" ? { ...r, rates: ["3,00%", "4,00%"] } : r));
        expect(() => buildCabaRules(wrong, new Set(), CODES)).toThrow(/distintas de las del artículo/);
        expect(() => buildCabaRules(ROWS, new Set(), new Set(["901001"]))).toThrow(/no está vigente en el catálogo/);
    });
    it("sin ingresos ni hechos declarados: alternativas con los datos faltantes, nunca una tasa única", () => {
        const s = suggestRate([set], q({}));
        expect(s.status).toBe("ALTERNATIVAS");
        if (s.status !== "ALTERNATIVAS") return;
        expect(s.alternatives.map((a) => a.rate)).toEqual(["3", "5"]);
        expect(s.missing).toContain("Ingresos brutos anuales del ejercicio anterior");
        expect(s.missing.some((m) => m.includes("no tiene previsto otro tratamiento"))).toBe(true);
    });
    const declared = { cabaSinOtroTratamiento: true };
    it("art. 5°: umbral de la Ley 6927 hasta el 31/05; desde junio, retenido (no se sugiere ni se acepta)", () => {
        const income = "380000000"; // entre $364.000.000 y $391.128.000
        const before = suggestRate([set], q({ date: "2026-05-31", facts: { priorYearGrossIncome: income, declared } }));
        const after = suggestRate([set], q({ date: "2026-06-01", facts: { priorYearGrossIncome: income, declared } }));
        expect(before.status === "UNICA" && [before.alternative.rate, before.alternative.ruleRef]).toEqual(["5", "caba-ley-6927-2026#a5-ene-may-supera"]);
        expect(after.status).toBe("SIN_REGLA");
        if (after.status === "SIN_REGLA") expect(after.message).toMatch(/retenidas/);
        // Las reglas retenidas se conservan con su texto y fuente para la revisión.
        const jun = rules.find((r) => r.id === "a5-jun-dic-hasta")!;
        expect([jun.rate, jun.legalReference, jun.sourceUrl?.includes("6948")]).toEqual(["3", "Ley 6948 (sustituye el art. 5° del Anexo de la Ley 6927) y Planilla 5", true]);
        expect(jun.conditions.find((c) => c.kind === "PRIOR_YEAR_GROSS_INCOME")).toMatchObject({ maxInclusive: "391128000" });
    });
    it("umbral exacto: «iguales o inferiores» toma la tasa baja", () => {
        const s = suggestRate([set], q({ date: "2026-05-01", facts: { priorYearGrossIncome: "364000000", declared } }));
        expect(s.status === "UNICA" && s.alternative.rate).toBe("3");
    });
    it("art. 1°: 0 % explícito (no exención)", () => {
        const s = suggestRate([set], q({ code: "901001", facts: { declared } }));
        expect(s.status === "UNICA" && [s.alternative.treatment, s.alternative.rate]).toEqual(["RATE", "0"]);
    });
    it("art. 3°: el 4 % residencial está retenido; por eso la tasa general nunca se presenta como única", () => {
        const base = { priorYearGrossIncome: "100", declared: { ...declared, cabaConsumidorResidencial: false } };
        const s = suggestRate([set], q({ code: "903001", date: "2026-03-01", facts: base }));
        expect(s.status).toBe("ALTERNATIVAS");
        if (s.status === "ALTERNATIVAS") {
            expect(s.alternatives.map((a) => a.rate)).toEqual(["3"]);
            expect(s.held.some((h) => h.includes("inciso 20 del artículo 19"))).toBe(true);
        }
        const res = suggestRate([set], q({ code: "903001", facts: { ...base, declared: { ...declared, cabaConsumidorResidencial: true } } }));
        expect(res.status).toBe("SIN_REGLA");
    });
    it("los hechos declarables viajan con su clave para que el panel pueda preguntarlos", () => {
        const s = suggestRate([set], q({ code: "902001", facts: {} }));
        expect(s.status).toBe("ALTERNATIVAS");
        if (s.status === "ALTERNATIVAS") {
            expect(s.alternatives[0].conditions.filter((c) => c.factKey).map((c) => [c.factKey, c.expected])).toEqual([
                ["cabaSinOtroTratamiento", true],
                ["cabaVentaNoEstadoNiConsumidorFinal", true],
                ["cabaActividadIndustrial", true],
                ["cabaNoBienesDeUso", true],
            ]);
        }
        const no = suggestRate([set], q({ code: "902001", facts: { declared: { ...declared, cabaVentaNoEstadoNiConsumidorFinal: false } } }));
        expect(no.status).toBe("NO_APLICA");
    });
});
