import { describe, it, expect } from "vitest";
import { normalizeSearchText, searchCatalogs, eligibleCatalogs, findCatalogEntry } from "@/lib/activity-catalog/search";
import { validateCatalogFile, isValidOn } from "@/lib/activity-catalog/validate";
import { integrityProblems, entriesSha256 } from "@/lib/activity-catalog/checksum";
import { selectionFromEntry, catalogReferenceLabel } from "@/lib/activity-catalog/types";
import { CLAE, NAES_PENDING, NAES_V1, NAES_V2, PROV_921, REVIEWED, catalog } from "./_fixtures/catalogs";

const ALL = [NAES_V1, NAES_V2, CLAE, PROV_921, NAES_PENDING];
const D_MAY = "2026-05-15";
const D_JUL = "2026-07-15";

describe("normalizeSearchText", () => {
    it("minúsculas, sin acentos ni signos, espacios colapsados", () => {
        expect(normalizeSearchText("  Consultoría   INFORMÁTICA, N.C.P. ")).toBe("consultoria informatica n.c.p.");
        expect(normalizeSearchText("Ñandú")).toBe("nandu");
    });
});

describe("búsqueda en catálogos", () => {
    const naes = (q: string, date = D_MAY) => searchCatalogs(ALL, q, { nomenclator: "NAES", date });

    it("por código exacto, como string con ceros iniciales", () => {
        const r = naes("011111");
        expect(r[0].entry.code).toBe("011111");
        expect(r[0].rank).toBe(0);
        expect(typeof r[0].entry.code).toBe("string");
    });
    it("prefijo de código con ceros iniciales; sin ceros NO es coincidencia de código (no se trata como número)", () => {
        expect(naes("011").map((x) => [x.entry.code, x.rank])).toEqual([["011111", 1]]);
        // "11111" sólo aparece como texto contenido (rango 3), nunca como código igual o prefijo.
        expect(naes("11111").map((x) => [x.entry.code, x.rank])).toEqual([["011111", 3]]);
        expect(naes("11111").some((x) => x.rank <= 1)).toBe(false);
    });
    it("por descripción sin acentos, mayúsculas ni orden de palabras", () => {
        expect(naes("CONSULTORIA informatica").map((x) => x.entry.code)).toEqual(["620100"]);
        expect(naes("informática consultoría").map((x) => x.entry.code)).toEqual(["620100"]);
    });
    it("términos parciales", () => {
        expect(naes("consul info").map((x) => x.entry.code)).toEqual(["620100"]);
        expect(naes("internet").map((x) => x.entry.code)).toEqual(["479101"]);
    });
    it("por referencia oficial", () => {
        expect(naes("seccion j").map((x) => x.entry.code).sort()).toEqual(["620100", "620900"]);
    });
    it("el mismo código en otro nomenclador NO se mezcla: cada resultado identifica su catálogo", () => {
        const n = naes("620100");
        const a = searchCatalogs(ALL, "620100", { nomenclator: "ARCA", date: D_MAY });
        expect(n.map((x) => x.catalogId)).toEqual(["fixture-naes-v1"]);
        expect(a.map((x) => x.catalogId)).toEqual(["fixture-clae"]);
        expect(n[0].entry.description).not.toBe(a[0].entry.description);
        // Sin filtro de nomenclador: ambos aparecen, cada uno con su etiqueta.
        const both = searchCatalogs(ALL, "620100", { date: D_MAY });
        expect(new Set(both.map((x) => x.nomenclator))).toEqual(new Set(["NAES", "ARCA", "PROVINCIAL"]));
        expect(new Set(both.map((x) => x.catalogLabel)).size).toBe(3);
    });
    it("nomenclador provincial identificado por jurisdicción", () => {
        expect(searchCatalogs(ALL, "620100", { nomenclator: "PROVINCIAL", jurisdiction: "921", date: D_MAY })).toHaveLength(1);
        expect(searchCatalogs(ALL, "620100", { nomenclator: "PROVINCIAL", jurisdiction: "902", date: D_MAY })).toHaveLength(0);
    });
    it("versiones y vigencias: cambio dentro del año", () => {
        expect(naes("620900", D_MAY).map((x) => x.catalogId)).toEqual(["fixture-naes-v1"]);
        expect(naes("620900", D_JUL)).toEqual([]); // dado de baja en v2
        expect(naes("620901", D_JUL).map((x) => x.catalogId)).toEqual(["fixture-naes-v2"]);
        expect(naes("620100", D_JUL).map((x) => x.version)).toEqual(["Prueba 2/2026"]);
        expect(isValidOn(NAES_V1.manifest, "2026-05-31")).toBe(true);
        expect(isValidOn(NAES_V1.manifest, "2026-06-01")).toBe(false);
    });
    it("registro histórico: versiones revisadas no vigentes, marcadas como tales", () => {
        const r = searchCatalogs(ALL, "620100", { nomenclator: "NAES", date: D_JUL, includeNotValid: true });
        expect(r.map((x) => [x.catalogId, x.validOnDate])).toEqual([
            ["fixture-naes-v1", false],
            ["fixture-naes-v2", true],
        ]);
    });
    it("sólo versiones REVISADAS: una importación pendiente no se publica", () => {
        expect(eligibleCatalogs(ALL, { date: D_MAY, includeNotValid: true }).map((c) => c.manifest.id)).not.toContain("fixture-naes-pending");
        expect(naes("999999")).toEqual([]);
    });
    it("consulta vacía o sólo signos: sin resultados; límite acotado", () => {
        expect(naes("   ")).toEqual([]);
        expect(naes("--")).toEqual([]);
        expect(searchCatalogs(ALL, "de prueba", { date: D_MAY, limit: 2 })).toHaveLength(2);
    });
    it("findCatalogEntry: coincidencia exacta de código en un catálogo concreto", () => {
        expect(findCatalogEntry(ALL, "fixture-naes-v1", "620100")?.entry.description).toMatch(/consultoría/);
        expect(findCatalogEntry(ALL, "fixture-naes-v1", "620100 ")).toBeNull();
        expect(findCatalogEntry(ALL, "fixture-clae", "620900")).toBeNull();
    });
    it("selección: copia fija con nomenclador, versión, referencia y jurisdicción", () => {
        const s = selectionFromEntry(PROV_921.manifest, PROV_921.entries[0]);
        expect(s).toEqual({
            catalogId: "fixture-prov-921",
            nomenclator: "PROVINCIAL",
            nomenclatorJurisdiction: "921",
            catalogVersion: "P-921 v1",
            code: "620100",
            description: "Informática provincial de prueba",
            reference: "Res. de prueba 921",
        });
        expect(catalogReferenceLabel(NAES_V1.manifest, NAES_V1.entries[1])).toBe("Norma de prueba 1/2025 · Sección J");
    });
});

describe("validación de archivos de catálogo", () => {
    it("fixtures válidos e íntegros", () => {
        for (const c of ALL) {
            expect(validateCatalogFile(c), c.manifest.id).toEqual([]);
            expect(integrityProblems(c), c.manifest.id).toEqual([]);
        }
    });
    it("detecta códigos duplicados, numéricos o vacíos y descripciones sin normalizar", () => {
        const bad = catalog({}, [
            { code: "620100", description: "A", reference: null },
            { code: "620100", description: "B", reference: null },
            { code: 620200 as unknown as string, description: "C", reference: null },
            { code: "620300", description: " D  doble", reference: null },
        ]);
        const p = validateCatalogFile(bad);
        expect(p.some((x) => x.includes("duplicado"))).toBe(true);
        expect(p.some((x) => x.includes("código inválido"))).toBe(true);
        expect(p.some((x) => x.includes("sin normalizar"))).toBe(true);
    });
    it("provincial sin jurisdicción, NAES con jurisdicción, REVISADO sin revisor y fechas incoherentes", () => {
        expect(validateCatalogFile(catalog({ nomenclator: "PROVINCIAL", jurisdiction: null }, NAES_V1.entries))).toContain("un nomenclador provincial requiere jurisdicción 901–924");
        expect(validateCatalogFile(catalog({ jurisdiction: "901" }, NAES_V1.entries))).toContain("ARCA y NAES no llevan jurisdicción");
        expect(validateCatalogFile(catalog({ review: { ...REVIEWED, reviewedBy: null, reviewedAt: null } }, NAES_V1.entries))).toContain("REVISADO requiere aprobador y fecha");
        expect(validateCatalogFile(catalog({ validFrom: "2026-02-01", validTo: "2026-01-01" }, NAES_V1.entries))).toContain("validTo anterior a validFrom");
        expect(validateCatalogFile(catalog({ publishedAt: "2026-02-30" }, NAES_V1.entries))).toContain("publishedAt debe ser AAAA-MM-DD");
    });
    it("la referencia copiada a la ficha («norma · referencia») debe entrar en 60 caracteres", () => {
        const long = catalog({ norm: "Resolución General de la Comisión Arbitral número diecinueve" }, [{ code: "620100", description: "X", reference: "Sección J" }]);
        expect(validateCatalogFile(long).some((p) => p.includes("supera 60"))).toBe(true);
    });
    it("checksum: una entrada alterada después de la importación se detecta", () => {
        const tampered = { ...NAES_V1, entries: NAES_V1.entries.map((e, i) => (i === 0 ? { ...e, description: "Otra cosa" } : e)) };
        expect(integrityProblems(tampered)).toEqual(["entriesSha256 no coincide con las entradas"]);
        expect(entriesSha256(NAES_V1.entries)).toBe(NAES_V1.manifest.entriesSha256);
    });
});
