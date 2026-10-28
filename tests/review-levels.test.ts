import { describe, it, expect } from "vitest";
import { isApproved, validateReview, CATALOG_REVIEW_LEVELS, RULES_REVIEW_LEVELS } from "@/lib/activity-catalog/review";
import { eligibleCatalogs } from "@/lib/activity-catalog/search";
import { suggestRate, findRule, withApprovedCatalog } from "@/lib/iibb-rates/suggest";
import { addCheck, approve, decideLevel } from "@/scripts/activity-catalogs/review";
import { NAES_V1, PENDING, PENDING_RULES, REVIEWED, catalog, rule, ruleSet } from "./_fixtures/catalogs";

const pendingCatalog = catalog({ id: "fixture-niveles", review: PENDING }, NAES_V1.entries);
const pendingRules = ruleSet({ review: PENDING_RULES }, [rule({ rate: "3.5" })]);

describe("revisión por niveles", () => {
    it("catálogo: niveles técnico y de vigencia; reglas: además interpretación", () => {
        expect(Object.keys(pendingCatalog.manifest.review.levels)).toEqual(["technical", "validity"]);
        expect(Object.keys(pendingRules.manifest.review.levels)).toEqual(["technical", "validity", "interpretation"]);
        expect(() => decideLevel(pendingCatalog, "interpretation", "CONFORME", "Estudio", "2026-10-28", null)).toThrow(/no corresponde/);
    });
    it("un check del preparador queda registrado pero NO cambia la decisión ni publica", () => {
        const f = addCheck(pendingCatalog, "technical", { kind: "AUTOMATICO", at: "2026-10-27", result: "SIN_DIFERENCIAS", summary: "Cotejo sin diferencias", evidence: ["fuentes/x.pdf"] });
        expect(f.manifest.review.levels.technical?.status).toBe("PENDIENTE");
        expect(f.manifest.review.levels.technical?.checks).toHaveLength(1);
        expect(eligibleCatalogs([f], { date: "2026-03-01" })).toEqual([]);
    });
    it("aprobación final sólo con TODOS los niveles CONFORME; una observación la bloquea", () => {
        const tech = decideLevel(pendingCatalog, "technical", "CONFORME", "Estudio", "2026-10-28", null);
        expect(() => approve(tech, "Estudio", "2026-10-28", null)).toThrow(/niveles sin CONFORME: validity/);
        const observed = decideLevel(tech, "validity", "OBSERVADO", "Estudio", "2026-10-28", "Falta confirmar RG posterior");
        expect(() => approve(observed, "Estudio", "2026-10-28", null)).toThrow(/sin CONFORME/);
        expect(() => decideLevel(tech, "validity", "OBSERVADO", "Estudio", "2026-10-28", null)).toThrow(/requiere notas/);
        const ok = approve(decideLevel(tech, "validity", "CONFORME", "Estudio", "2026-10-28", null), "Estudio", "2026-10-29", "Aprobado");
        expect(isApproved(ok.manifest.review, CATALOG_REVIEW_LEVELS)).toBe(true);
        expect(eligibleCatalogs([ok], { date: "2026-03-01" }).map((c) => c.manifest.id)).toEqual(["fixture-niveles"]);
    });
    it("cambiar la decisión de un nivel de algo aprobado lo vuelve a pendiente (no queda publicado con un nivel en duda)", () => {
        const back = decideLevel({ ...pendingCatalog, manifest: { ...pendingCatalog.manifest, review: REVIEWED } }, "validity", "OBSERVADO", "Estudio", "2026-11-01", "Nueva norma");
        expect(back.manifest.review.status).toBe("PENDIENTE_REVISION");
        expect(eligibleCatalogs([back], { date: "2026-03-01" })).toEqual([]);
    });
    it("un REVISADO con un nivel no CONFORME es inválido y no se publica aunque se fuerce el estado", () => {
        const forced = { ...REVIEWED, levels: { ...REVIEWED.levels, validity: { ...REVIEWED.levels.validity!, status: "OBSERVADO" as const, notes: "x" } } };
        expect(validateReview(forced, CATALOG_REVIEW_LEVELS)).toContain("REVISADO requiere todos los niveles CONFORME");
        expect(isApproved(forced, CATALOG_REVIEW_LEVELS)).toBe(false);
        // un conjunto de reglas aprobado sólo con los niveles de catálogo (sin interpretación) no se usa
        const set = ruleSet({ review: REVIEWED }, [rule({ rate: "3.5" })]);
        expect(isApproved(set.manifest.review, RULES_REVIEW_LEVELS)).toBe(false);
        expect(suggestRate([set], { jurisdiction: "901", nomenclator: "NAES", catalogId: "fixture-naes-v1", code: "620100", date: "2026-03-01", registration: null, facts: {} }).status).toBe("SIN_COBERTURA");
    });
    it("los archivos inválidos (checksum alterado) no se revisan", () => {
        const tampered = { ...pendingCatalog, entries: pendingCatalog.entries.map((e, i) => (i === 0 ? { ...e, description: "Otra" } : e)) };
        expect(() => decideLevel(tampered, "technical", "CONFORME", "Estudio", "2026-10-28", null)).toThrow(/no es válido/);
    });
});

describe("reglas retenidas por interpretación pendiente", () => {
    const set = ruleSet({}, [
        rule({ id: "habilitada", activityCodes: ["620100"], rate: "3" }),
        rule({ id: "retenida", activityCodes: ["620100", "620900"], rate: "4", pendingInterpretation: "Fecha de inicio por confirmar" }),
    ]);
    const q = (code: string) => ({ jurisdiction: "901", nomenclator: "NAES", catalogId: "fixture-naes-v1", code, date: "2026-03-01", registration: null, facts: {} });

    it("nunca se sugieren, aun con el conjunto aprobado; si podrían aplicar, la respuesta no es única", () => {
        const s = suggestRate([set], q("620100"));
        expect(s.status).toBe("ALTERNATIVAS");
        if (s.status === "ALTERNATIVAS") {
            expect(s.alternatives.map((a) => a.ruleRef)).toEqual(["fixture-rules-901#habilitada"]);
            expect(s.held).toEqual(["Fecha de inicio por confirmar"]);
        }
        const only = suggestRate([set], q("620900"));
        expect(only.status).toBe("SIN_REGLA");
        if (only.status === "SIN_REGLA") expect(only.message).toMatch(/retenidas hasta que el estudio decida/);
    });
    it("el servidor no acepta guardar una sugerencia con una regla retenida", () => {
        expect(findRule([set], "fixture-rules-901#retenida")).toBeNull();
        expect(findRule([set], "fixture-rules-901#habilitada")).not.toBeNull();
    });
});

describe("un conjunto de reglas no se usa antes que su catálogo", () => {
    const set = ruleSet({ catalogIds: ["fixture-niveles"] }, [rule({ rate: "3.5" })]);
    it("catálogo pendiente: el conjunto aprobado no se usa; catálogo aprobado: sí", () => {
        expect(withApprovedCatalog([set], [pendingCatalog])).toEqual([]);
        const approvedCat = { ...pendingCatalog, manifest: { ...pendingCatalog.manifest, review: REVIEWED } };
        expect(withApprovedCatalog([set], [approvedCat])).toEqual([set]);
        expect(withApprovedCatalog([set], [])).toEqual([]);
    });
    it("el catálogo se aprueba sin depender de sus reglas (revisiones separadas)", () => {
        const approvedCat = { ...pendingCatalog, manifest: { ...pendingCatalog.manifest, review: REVIEWED } };
        expect(eligibleCatalogs([approvedCat], { date: "2026-03-01" })).toHaveLength(1);
    });
});

