import { describe, it, expect } from "vitest";
import naes from "@/data/activity-catalogs/naes-rg-ca-19-2025.json";
import clae from "@/data/activity-catalogs/clae-rg-afip-3537-2013.json";
import caba from "@/data/iibb-rate-rules/caba-ley-6927-2026.json";
import arba from "@/data/activity-catalogs/arba-naiibb18-2026-10-27.json";
import arbaCorr from "@/data/activity-catalogs/arba-naiibb18-2026-10-27.correspondencias.json";
import arbaRules from "@/data/iibb-rate-rules/arba-ley-15558-2026.json";
import { sha256Hex } from "@/lib/activity-catalog/checksum";
import { verifyProfileSources } from "@/lib/iibb-profile-sources";
import { validateCatalogFile } from "@/lib/activity-catalog/validate";
import { integrityProblems } from "@/lib/activity-catalog/checksum";
import { searchCatalogs } from "@/lib/activity-catalog/search";
import type { CatalogFile } from "@/lib/activity-catalog/types";
import { validateRuleSet } from "@/lib/iibb-rates/validate";
import { suggestRate } from "@/lib/iibb-rates/suggest";
import type { RateRuleSet } from "@/lib/iibb-rates/types";
import { REVIEWED, REVIEWED_RULES } from "./_fixtures/catalogs";

/**
 * Datos OFICIALES versionados en el repo (importados con scripts/activity-catalogs
 * y scripts/iibb-rates). Estos tests no reemplazan la revisión humana contra la
 * fuente: verifican estructura, integridad y las cifras que se cotejaron al
 * importar (docs/catalogos-actividades/README.md, «Cobertura»).
 */
const NAES = naes as unknown as CatalogFile;
const CLAE = clae as unknown as CatalogFile;
const CABA = caba as unknown as RateRuleSet;

describe("catálogos oficiales importados", () => {
    it("estructura válida e íntegra (checksum de entradas)", () => {
        for (const c of [NAES, CLAE]) {
            expect(validateCatalogFile(c), c.manifest.id).toEqual([]);
            expect(integrityProblems(c), c.manifest.id).toEqual([]);
        }
    });
    it("NAES RG CA 19/2025: 1013 códigos, 4 bajas al 31/12/2025 y 18 altas desde 01/2026 (RG CA 12/2025)", () => {
        expect(NAES.manifest).toMatchObject({ nomenclator: "NAES", jurisdiction: null, sourceSha256: "f1bb5ccb09b5e4de4ea914fea77e49f730ef433817071da5eef11dec83aca31c", entryCount: 1013 });
        expect(NAES.entries.filter((e) => e.validTo).map((e) => e.code)).toEqual(["530090", "631110", "631120", "649290"]);
        expect(NAES.entries.filter((e) => e.validFrom === "2026-01-01")).toHaveLength(18);
        expect(NAES.entries.every((e) => /^\d{6}$/.test(e.code))).toBe(true);
    });
    it("CLAE F.883 (RG AFIP 3537/2013): 951 actividades, sin la ampliación abrogada de la RG 5607/2024", () => {
        expect(CLAE.manifest).toMatchObject({ nomenclator: "ARCA", jurisdiction: null, validFrom: "2013-11-01", entryCount: 951 });
        expect(CLAE.entries.find((e) => e.code === "530091")).toBeUndefined(); // alta de la RG 5607, abrogada por la RG 5612
        expect(CLAE.entries.find((e) => e.code === "000007")).toBeUndefined(); // tabla de responsables no comprendidos
    });
    it("el mismo código en NAES y en CLAE sigue siendo de catálogos distintos (sin equivalencia asumida)", () => {
        const reviewed = [NAES, CLAE].map((c) => ({ ...c, manifest: { ...c.manifest, review: REVIEWED } }));
        const r = searchCatalogs(reviewed, "011129", { date: "2026-10-27" });
        expect(r.map((x) => x.nomenclator).sort()).toEqual(["ARCA", "NAES"]);
    });
});

describe("reglas oficiales de alícuotas: CABA 2026", () => {
    it("estructura válida; todos los códigos existen en el NAES vigente en 2026", () => {
        expect(validateRuleSet(CABA)).toEqual([]);
        const valid2026 = new Set(NAES.entries.filter((e) => !e.validTo || e.validTo >= "2026-01-01").map((e) => e.code));
        const codes = new Set(CABA.rules.flatMap((r) => r.activityCodes));
        expect([...codes].filter((c) => !valid2026.has(c))).toEqual([]);
        expect(codes.size).toBe(799);
        expect(CABA.rules.filter((r) => r.pendingInterpretation).length).toBe(15);
        for (const c of ["301200", "302000", "303000", "639100", "639900"]) expect(codes.has(c), c).toBe(false);
        expect(CABA.manifest).toMatchObject({ jurisdiction: "901", catalogIds: ["naes-rg-ca-19-2025"], validFrom: "2026-01-01", validTo: "2026-12-31" });
    });
    it("mientras esté PENDIENTE de revisión no sugiere nada", () => {
        expect(CABA.manifest.review.status).toBe("PENDIENTE_REVISION");
        const s = suggestRate([CABA], { jurisdiction: "901", nomenclator: "NAES", catalogId: "naes-rg-ca-19-2025", code: "351110", date: "2026-07-01", registration: null, facts: {} });
        expect(s.status).toBe("SIN_COBERTURA");
    });
    it("lectura de la norma (con el conjunto marcado como revisado sólo en el test)", () => {
        const set = { ...CABA, manifest: { ...CABA.manifest, review: REVIEWED_RULES } };
        const ask = (code: string, date: string, income: string) =>
            suggestRate([set], {
                jurisdiction: "901",
                nomenclator: "NAES",
                catalogId: "naes-rg-ca-19-2025",
                code,
                date,
                registration: null,
                facts: { priorYearGrossIncome: income, declared: { cabaSinOtroTratamiento: true, cabaConsumidorResidencial: false } },
            });
        // 351110 (Planilla 3): $2.100 M supera el umbral de la Ley 6927 ($2.004 M). Aun declarando todo, el 4 %
        // residencial retenido impide una respuesta única; desde junio (Ley 6948) todo está retenido.
        const may = ask("351110", "2026-05-15", "2100000000");
        const jul = ask("351110", "2026-07-15", "2100000000");
        expect(may.status === "ALTERNATIVAS" && may.alternatives.map((a) => a.rate)).toEqual(["3.75"]);
        expect(jul.status).toBe("SIN_REGLA");
        // 331101 (Planilla 5, sin retenciones en enero-mayo): umbral de $364 M.
        expect((({ s }) => s.status === "UNICA" && s.alternative.rate)({ s: ask("331101", "2026-03-01", "364000001") })).toBe("5");
        // 551010 (alojamiento por hora, art. 26) y los códigos de los arts. 12 a 21 no tienen regla de planilla.
        expect(ask("551010", "2026-07-15", "1").status).toBe("SIN_REGLA");
        // Fuera de 2026 no hay cobertura (no se extrapola a otros años).
        expect(ask("351110", "2027-01-15", "1").status).toBe("SIN_COBERTURA");
    });
});

describe("Provincia de Buenos Aires: NAIIB-18 (exportación oficial) y Ley 15.558 (2026)", () => {
    const CAT = arba as unknown as CatalogFile;
    const RULES = arbaRules as unknown as RateRuleSet;
    it("catálogo provincial 902 válido e íntegro: 1035 códigos de 6 dígitos con las altas y bajas de la RN 34/2025", () => {
        expect(validateCatalogFile(CAT)).toEqual([]);
        expect(integrityProblems(CAT)).toEqual([]);
        expect(CAT.manifest).toMatchObject({ nomenclator: "PROVINCIAL", jurisdiction: "902", entryCount: 1035 });
        const codes = new Set(CAT.entries.map((e) => e.code));
        expect([...codes].every((c) => /^\d{6}$/.test(c))).toBe(true);
        for (const c of ["011111", "530091", "631112", "731003"]) expect(codes.has(c), c).toBe(true);
        for (const c of ["530090", "631110"]) expect(codes.has(c), c).toBe(false);
        // NAIIB-18 ≠ NAES: el mismo código puede describir otra actividad (nunca se equiparan por código).
        const arba731002 = CAT.entries.find((e) => e.code === "731002")!.description;
        const naes731002 = NAES.entries.find((e) => e.code === "731002")!.description;
        expect(arba731002).toBe("Servicios de publicidad, por actividades de intermediación");
        expect(naes731002).not.toBe(arba731002);
        expect(CAT.entries.filter((e) => e.validFrom === "2026-01-01")).toHaveLength(17);
    });
    it("correspondencias: archivo separado, íntegro, con datos tal como los publica ARBA", () => {
        expect(sha256Hex(JSON.stringify(arbaCorr.rows))).toBe(arbaCorr.manifest.rowsSha256);
        expect(arbaCorr.rows).toHaveLength(3525);
        expect(new Set(arbaCorr.rows.map((r) => r.type))).toEqual(new Set(["CORRESPONDENCIA NAIIB 99", "EQUIVALENCIA AFIP", "DOCUMENTACION TRIBUTARIA"]));
    });
    it("reglas 2026 válidas, pendientes, sobre códigos del catálogo; todas condicionadas y 222 códigos retenidos", () => {
        expect(validateRuleSet(RULES)).toEqual([]);
        expect(RULES.manifest).toMatchObject({ jurisdiction: "902", nomenclator: "PROVINCIAL", validFrom: "2026-01-01", validTo: "2026-12-31", review: { status: "PENDIENTE_REVISION" } });
        const catCodes = new Set(CAT.entries.map((e) => e.code));
        const ruleCodes = new Set(RULES.rules.flatMap((r) => r.activityCodes));
        expect([...ruleCodes].filter((c) => !catCodes.has(c))).toEqual([]);
        expect(ruleCodes.size).toBe(1022);
        expect(RULES.rules.every((r) => r.conditions.length > 0)).toBe(true);
        const heldCodes = new Set(RULES.rules.filter((r) => r.pendingInterpretation).flatMap((r) => r.activityCodes));
        expect(heldCodes.size).toBe(222);
        for (const c of ["390000", "812090", "631201", "631204"]) expect(heldCodes.has(c), c).toBe(true);
    });
    it("aun aprobado, nada se guarda como sugerencia de la norma (todas las reglas son condicionadas)", () => {
        const set = { ...RULES, manifest: { ...RULES.manifest, review: REVIEWED_RULES } };
        const rule = set.rules.find((r) => !r.pendingInterpretation && r.activityCodes.includes("011111"))!;
        const entry = CAT.entries.find((e) => e.code === "011111")!;
        const activity = {
            nomenclator: "PROVINCIAL" as const,
            nomenclatorJurisdiction: "902",
            nomenclatorReference: "RN ARBA 38/2017 y modif.",
            code: "011111",
            description: entry.description,
            origin: "MANUAL" as const,
            catalogId: null,
            catalogVersion: null,
            rates: [{ jurisdiction: "902", rate: rule.rate, treatment: "RATE" as const, origin: "CONFIRMED_SUGGESTION" as const, ruleRef: `${set.manifest.id}#${rule.id}` }],
        };
        expect(verifyProfileSources({ activities: [activity], registration: "LOCAL" }, null, [], [set])?.error).toMatch(/decisión del estudio/);
        const s = suggestRate([set], { jurisdiction: "902", nomenclator: "PROVINCIAL", catalogId: CAT.manifest.id, code: "011111", date: "2026-03-01", registration: "LOCAL", facts: { priorYearGrossIncome: "1000" } });
        expect(s.status).toBe("ALTERNATIVAS");
        expect(suggestRate([set], { jurisdiction: "902", nomenclator: "PROVINCIAL", catalogId: CAT.manifest.id, code: "011111", date: "2025-12-01", registration: "LOCAL", facts: {} }).status).toBe("SIN_COBERTURA");
    });
});
