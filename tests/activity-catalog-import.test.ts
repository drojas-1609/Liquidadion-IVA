import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildCatalogFile, readCatalogSheet, type ManifestArgs } from "@/scripts/activity-catalogs/import";
import { validateCatalogFile } from "@/lib/activity-catalog/validate";
import { integrityProblems } from "@/lib/activity-catalog/checksum";

/** Planilla SINTÉTICA con filas de título antes del encabezado (como suelen venir los anexos). */
function workbook(rows: unknown[][]): XLSX.WorkBook {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Actividades");
    return wb;
}
const MAP = { sheet: "Actividades", codeHeader: "Código NAES", descriptionHeader: "Descripción", referenceHeader: null, codeLength: null };
const ARGS: ManifestArgs = {
    id: "fixture-import",
    nomenclator: "NAES",
    jurisdiction: null,
    name: "Fixture importado (no oficial)",
    organism: "Organismo de prueba",
    norm: "Norma de prueba",
    version: "Prueba",
    sourceUrl: "https://example.test/x.xlsx",
    sourceFile: "x.xlsx",
    publishedAt: "2025-12-10",
    consultedAt: "2026-10-27",
    validFrom: "2025-12-10",
    validTo: null,
    supersedes: null,
};
const SOURCE = new TextEncoder().encode("bytes de la planilla sintética");

describe("importación de catálogos", () => {
    it("lee como TEXTO, conserva ceros iniciales y normaliza espacios; ignora filas vacías", () => {
        const r = readCatalogSheet(
            workbook([["ANEXO DE PRUEBA"], [], ["Código NAES", "Descripción"], ["011111", "Cultivo  de   arroz"], [], ["620100", " Consultoría "]]),
            MAP,
        );
        expect(r.headerRow).toBe(3);
        expect(r.entries).toEqual([
            { code: "011111", description: "Cultivo de arroz", reference: null },
            { code: "620100", description: "Consultoría", reference: null },
        ]);
        expect(r.paddedCodes).toBe(0);
    });
    it("encabezado tolerante a acentos y mayúsculas", () => {
        const r = readCatalogSheet(workbook([["CODIGO NAES", "DESCRIPCION"], ["620100", "X"]]), MAP);
        expect(r.entries).toHaveLength(1);
    });
    it("código guardado como número: sin --code-length se rechaza; con --code-length se completan ceros y se informa", () => {
        const wb = workbook([["Código NAES", "Descripción"], [11111, "Cultivo"], [620100, "Consultoría"]]);
        expect(() => readCatalogSheet(wb, MAP)).toThrow(/--code-length/);
        const r = readCatalogSheet(wb, { ...MAP, codeLength: 6 });
        expect(r.entries.map((e) => e.code)).toEqual(["011111", "620100"]);
        expect(r.paddedCodes).toBe(1);
        expect(() => readCatalogSheet(workbook([["Código NAES", "Descripción"], [1234567, "Largo"]]), { ...MAP, codeLength: 6 })).toThrow(/más largo/);
    });
    it("fila con datos incompletos: la importación falla (no se descartan filas en silencio)", () => {
        expect(() => readCatalogSheet(workbook([["Código NAES", "Descripción"], ["620100", ""]]), MAP)).toThrow(/falta código o descripción/);
        expect(() => readCatalogSheet(workbook([["Otro", "Descripción"]]), MAP)).toThrow(/encabezados/);
        expect(() => readCatalogSheet(workbook([["Código NAES", "Descripción"]]), { ...MAP, sheet: "Nope" })).toThrow(/no existe la hoja/);
    });
    it("resultado: PENDIENTE_REVISION, con checksums; duplicados rechazados por la validación", () => {
        const { entries } = readCatalogSheet(workbook([["Código NAES", "Descripción"], ["620100", "A"], ["620200", "B"]]), MAP);
        const file = buildCatalogFile(SOURCE, entries, ARGS);
        expect(file.manifest.review.status).toBe("PENDIENTE_REVISION");
        expect(Object.keys(file.manifest.review.levels)).toEqual(["technical", "validity"]);
        expect(Object.values(file.manifest.review.levels).every((l) => l?.status === "PENDIENTE")).toBe(true);
        expect(file.manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(validateCatalogFile(file)).toEqual([]);
        expect(integrityProblems(file)).toEqual([]);
        const dup = buildCatalogFile(SOURCE, [...entries, { code: "620100", description: "C", reference: null }], ARGS);
        expect(validateCatalogFile(dup).some((p) => p.includes("duplicado"))).toBe(true);
    });
    it("reproducible: mismos bytes y filas -> mismo archivo", () => {
        const { entries } = readCatalogSheet(workbook([["Código NAES", "Descripción"], ["620100", "A"]]), MAP);
        expect(JSON.stringify(buildCatalogFile(SOURCE, entries, ARGS))).toBe(JSON.stringify(buildCatalogFile(SOURCE, entries, ARGS)));
    });
});
