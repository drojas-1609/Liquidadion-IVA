import { describe, it, expect } from "vitest";
import { compareMoney, findRule, suggestRate, type RateQuery } from "@/lib/iibb-rates/suggest";
import { validateRuleSet } from "@/lib/iibb-rates/validate";
import { parseRuleRef, ruleRef } from "@/lib/iibb-rates/types";
import { PENDING_RULES, THRESHOLD_RULES, rule, ruleSet } from "./_fixtures/catalogs";

const q = (over: Partial<RateQuery>): RateQuery => ({
    jurisdiction: "901",
    nomenclator: "NAES",
    catalogId: "fixture-naes-v1",
    code: "620100",
    date: "2026-03-01",
    registration: "LOCAL",
    facts: {},
    ...over,
});

describe("suggestRate — cobertura", () => {
    it("sin conjuntos de reglas: «pendiente de determinar» (no se inventa una tasa)", () => {
        const s = suggestRate([], q({}));
        expect(s.status).toBe("SIN_COBERTURA");
        if (s.status === "SIN_COBERTURA") expect(s.message).toMatch(/pendiente de determinar/);
    });
    it("un conjunto PENDIENTE de revisión no se usa", () => {
        expect(suggestRate([ruleSet({ review: PENDING_RULES }, [rule({})])], q({})).status).toBe("SIN_COBERTURA");
    });
    it("otra jurisdicción, otro nomenclador o fuera de vigencia: sin cobertura", () => {
        const set = ruleSet({}, [rule({})]);
        expect(suggestRate([set], q({ jurisdiction: "902" })).status).toBe("SIN_COBERTURA");
        expect(suggestRate([set], q({ date: "2027-01-01" })).status).toBe("SIN_COBERTURA");
        expect(suggestRate([set], q({ catalogId: "otro-catalogo" })).status).toBe("SIN_COBERTURA");
    });
    it("ARCA/CLAE nunca determina una tasa de IIBB (los conjuntos son NAES o provinciales)", () => {
        expect(suggestRate([ruleSet({}, [rule({})])], q({ nomenclator: "ARCA", catalogId: "fixture-clae" })).status).toBe("SIN_COBERTURA");
    });
    it("dos normas vigentes para lo mismo: no se elige una", () => {
        const a = ruleSet({ id: "fixture-a" }, [rule({ rate: "3" })]);
        const b = ruleSet({ id: "fixture-b" }, [rule({ rate: "4" })]);
        expect(suggestRate([a, b], q({})).status).toBe("SIN_COBERTURA");
    });
    it("código sin regla en la norma: SIN_REGLA (pendiente)", () => {
        expect(suggestRate([ruleSet({}, [rule({})])], q({ code: "011111" })).status).toBe("SIN_REGLA");
    });
});

describe("suggestRate — alícuota única, alternativas y condiciones", () => {
    it("una sola regla sin condiciones: UNICA, con fuente, vigencia y referencia legal", () => {
        const s = suggestRate([ruleSet({}, [rule({ rate: "3.5" })])], q({}));
        expect(s).toEqual({
            status: "UNICA",
            alternative: {
                ruleRef: "fixture-rules-901#r1",
                treatment: "RATE",
                rate: "3.5",
                validFrom: "2026-01-01",
                validTo: "2026-12-31",
                norm: "Ley de prueba 2026",
                legalReference: "Art. de prueba 1",
                sourceUrl: "https://example.test/ley-2026.pdf",
                conditions: [],
            },
        });
    });
    it("umbral por ingresos SIN el dato: alternativas y dato faltante (no se completa sola)", () => {
        const s = suggestRate([ruleSet({}, THRESHOLD_RULES)], q({ code: "479101" }));
        expect(s.status).toBe("ALTERNATIVAS");
        if (s.status === "ALTERNATIVAS") {
            expect(s.alternatives.map((a) => a.rate)).toEqual(["3", "5"]);
            expect(s.missing).toEqual(["Ingresos brutos anuales del ejercicio anterior"]);
            expect(s.alternatives.every((a) => a.conditions.every((c) => c.status === "DESCONOCIDO"))).toBe(true);
        }
    });
    it("umbral con el dato: una sola; límite inclusivo y exclusivo exactos (sin flotantes)", () => {
        const set = ruleSet({}, THRESHOLD_RULES);
        const at = (income: string) => suggestRate([set], q({ code: "479101", facts: { priorYearGrossIncome: income } }));
        const one = (income: string) => {
            const s = at(income);
            return s.status === "UNICA" ? s.alternative.rate : s.status;
        };
        expect(one("100000000")).toBe("3");
        expect(one("100000000.00")).toBe("3");
        expect(one("100000000.01")).toBe("5");
        expect(one("99999999.99")).toBe("3");
        expect(one("0")).toBe("3");
    });
    it("dato con formato inválido se trata como desconocido", () => {
        expect(suggestRate([ruleSet({}, THRESHOLD_RULES)], q({ code: "479101", facts: { priorYearGrossIncome: "1e9" } })).status).toBe("ALTERNATIVAS");
    });
    it("regla por inscripción con inscripción desconocida: alternativas con el dato faltante", () => {
        const set = ruleSet({}, [rule({ registrations: ["CONVENIO_MULTILATERAL"], rate: "4" })]);
        const s = suggestRate([set], q({ registration: null }));
        expect(s.status).toBe("ALTERNATIVAS");
        if (s.status === "ALTERNATIVAS") expect(s.missing).toEqual(["Inscripción en Ingresos Brutos"]);
        expect(suggestRate([set], q({ registration: "LOCAL" })).status).toBe("NO_APLICA");
        expect(suggestRate([set], q({ registration: "CONVENIO_MULTILATERAL" })).status).toBe("UNICA");
    });
    it("hecho declarado: sin declarar = faltante; declarado en contra = no aplica", () => {
        const set = ruleSet({}, [
            rule({ rate: "1.5", conditions: [{ kind: "DECLARED_FACT", factKey: "industriaLocal", expected: true, description: "Establecimiento industrial en la jurisdicción" }] }),
        ]);
        expect(suggestRate([set], q({})).status).toBe("ALTERNATIVAS");
        expect(suggestRate([set], q({ facts: { declared: { industriaLocal: false } } })).status).toBe("NO_APLICA");
        expect(suggestRate([set], q({ facts: { declared: { industriaLocal: true } } })).status).toBe("UNICA");
    });
    it("cambio de tasa dentro del año (vigencias por regla)", () => {
        const set = ruleSet({}, [rule({ id: "hasta-mayo", rate: "3", validTo: "2026-05-31" }), rule({ id: "desde-junio", rate: "3.5", validFrom: "2026-06-01" })]);
        const at = (date: string) => {
            const s = suggestRate([set], q({ date }));
            return s.status === "UNICA" ? `${s.alternative.ruleRef}=${s.alternative.rate}` : s.status;
        };
        expect(at("2026-05-31")).toBe("fixture-rules-901#hasta-mayo=3");
        expect(at("2026-06-01")).toBe("fixture-rules-901#desde-junio=3.5");
    });
    it("0 % explícito, exención y ausencia son distintos", () => {
        const set = ruleSet({}, [rule({ id: "cero", rate: "0" }), rule({ id: "exenta", activityCodes: ["620900"], treatment: "EXEMPT", rate: null })]);
        const zero = suggestRate([set], q({}));
        const exempt = suggestRate([set], q({ code: "620900" }));
        expect(zero.status === "UNICA" && [zero.alternative.treatment, zero.alternative.rate]).toEqual(["RATE", "0"]);
        expect(exempt.status === "UNICA" && [exempt.alternative.treatment, exempt.alternative.rate]).toEqual(["EXEMPT", null]);
        expect(suggestRate([set], q({ code: "011111" })).status).toBe("SIN_REGLA"); // ausente
    });
});

describe("referencias, búsqueda de reglas y validación de conjuntos", () => {
    it("ruleRef estable y parseable", () => {
        expect(ruleRef("fixture-rules-901", "r1")).toBe("fixture-rules-901#r1");
        expect(parseRuleRef("fixture-rules-901#r1")).toEqual({ setId: "fixture-rules-901", ruleId: "r1" });
        expect(parseRuleRef("sin-separador")).toBeNull();
        expect(parseRuleRef("X#r1")).toBeNull();
    });
    it("findRule sólo en conjuntos REVISADOS", () => {
        expect(findRule([ruleSet({}, [rule({})])], "fixture-rules-901#r1")?.rule.rate).toBe("3");
        expect(findRule([ruleSet({ review: PENDING_RULES }, [rule({})])], "fixture-rules-901#r1")).toBeNull();
        expect(findRule([ruleSet({}, [rule({})])], "fixture-rules-901#nope")).toBeNull();
    });
    it("validateRuleSet: válido; exención con tasa, tasa fuera de rango, umbral sin límites y referencia legal faltante", () => {
        expect(validateRuleSet(ruleSet({}, [...THRESHOLD_RULES, rule({ id: "x", treatment: "EXEMPT", rate: null })]))).toEqual([]);
        const p = validateRuleSet(
            ruleSet({}, [
                rule({ id: "a", treatment: "EXEMPT", rate: "1" }),
                rule({ id: "b", rate: "101" }),
                rule({ id: "c", conditions: [{ kind: "PRIOR_YEAR_GROSS_INCOME", minExclusive: null, maxInclusive: null, description: "x" }] }),
                rule({ id: "d", legalReference: "" }),
                rule({ id: "d", activityCodes: [] }),
            ]),
        );
        expect(p).toEqual(
            expect.arrayContaining([
                "regla 1: una exención no lleva tasa",
                "regla 2: tasa inválida",
                "regla 3, condición 1: umbral sin límites",
                "regla 4: falta la referencia legal",
                "regla 5: id inválido o repetido",
                "regla 5: códigos inválidos",
            ]),
        );
    });
    it("compareMoney exacto", () => {
        expect(compareMoney("10", "9.99")).toBe(1);
        expect(compareMoney("010.5", "10.50")).toBe(0);
        expect(compareMoney("100000000.00", "100000000")).toBe(0);
        expect(compareMoney("99", "100")).toBe(-1);
    });
});
