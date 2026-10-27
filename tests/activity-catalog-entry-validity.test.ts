import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { searchCatalogs } from "@/lib/activity-catalog/search";
import { entryValidity, validateCatalogFile } from "@/lib/activity-catalog/validate";
import { entriesSha256 } from "@/lib/activity-catalog/checksum";
import { parseEntryDate, readCatalogSheet } from "@/scripts/activity-catalogs/import";
import { catalog } from "./_fixtures/catalogs";

/** Como el anexo I de la RG CA 19/2025: vigencia propia por código (altas y bajas dentro de una misma versión). */
const NAES = catalog({ id: "fixture-naes-vig", validFrom: "2018-01-01", validTo: null }, [
    { code: "530090", description: "Mensajería de prueba (baja)", reference: null, validFrom: "2018-01-01", validTo: "2025-12-31" },
    { code: "530099", description: "Mensajería de prueba n.c.p. (alta)", reference: null, validFrom: "2026-01-01", validTo: null },
    { code: "620100", description: "Consultoría de prueba", reference: null, validFrom: "2018-01-01", validTo: null },
]);

describe("vigencia por código dentro de una versión", () => {
    const find = (q: string, date: string, includeNotValid = false) => searchCatalogs([NAES], q, { nomenclator: "NAES", date, includeNotValid });

    it("un código dado de baja no se ofrece después de su fin; el alta, sólo desde su inicio", () => {
        expect(find("mensajeria", "2025-06-01").map((r) => r.entry.code)).toEqual(["530090"]);
        expect(find("mensajeria", "2026-03-01").map((r) => r.entry.code)).toEqual(["530099"]);
        expect(find("620100", "2026-03-01")).toHaveLength(1);
    });
    it("registro histórico: con includeNotValid aparecen ambos, marcados con su vigencia efectiva", () => {
        const r = find("mensajeria", "2026-03-01", true);
        expect(r.map((x) => [x.entry.code, x.validOnDate, x.validFrom, x.validTo])).toEqual([
            ["530090", false, "2018-01-01", "2025-12-31"],
            ["530099", true, "2026-01-01", null],
        ]);
    });
    it("vigencia efectiva: la de la versión acotada por la del código", () => {
        expect(entryValidity({ validFrom: "2020-01-01", validTo: "2026-12-31" }, { validFrom: "2018-01-01", validTo: null })).toEqual({ validFrom: "2020-01-01", validTo: "2026-12-31" });
        expect(entryValidity({ validFrom: "2018-01-01", validTo: null }, { validFrom: "2026-01-01", validTo: "2026-06-30" })).toEqual({ validFrom: "2026-01-01", validTo: "2026-06-30" });
        expect(entryValidity({ validFrom: "2018-01-01", validTo: null }, {})).toEqual({ validFrom: "2018-01-01", validTo: null });
    });
    it("validación: fechas inválidas, invertidas o fuera de la versión", () => {
        const bad = catalog({ validFrom: "2018-01-01", validTo: "2026-12-31" }, [
            { code: "000001", description: "A", reference: null, validFrom: "2018-13-01", validTo: null },
            { code: "000002", description: "B", reference: null, validFrom: "2020-01-01", validTo: "2019-01-01" },
            { code: "000003", description: "C", reference: null, validFrom: "2017-01-01", validTo: null },
            { code: "000004", description: "D", reference: null, validFrom: null, validTo: "2027-01-01" },
        ]);
        const p = validateCatalogFile(bad);
        expect(p).toContain("entrada 1: validFrom debe ser AAAA-MM-DD o null");
        expect(p).toContain("entrada 2: validTo anterior a validFrom");
        expect(p).toContain("entrada 3: vigencia anterior a la de la versión");
        expect(p).toContain("entrada 4: vigencia posterior a la de la versión");
        expect(validateCatalogFile(NAES)).toEqual([]);
    });
    it("el checksum cubre la vigencia por código", () => {
        const moved = NAES.entries.map((e) => (e.code === "530090" ? { ...e, validTo: "2026-12-31" } : e));
        expect(entriesSha256(moved)).not.toBe(entriesSha256(NAES.entries));
    });
});

describe("importación de vigencias por código", () => {
    it("MM/AAAA: inicio el día 1, fin el último día del mes; también AAAA-MM-DD", () => {
        expect(parseEntryDate("01/2018", "from")).toBe("2018-01-01");
        expect(parseEntryDate("12/2025", "to")).toBe("2025-12-31");
        expect(parseEntryDate("02/2024", "to")).toBe("2024-02-29");
        expect(parseEntryDate("2026-01-15", "from")).toBe("2026-01-15");
        expect(() => parseEntryDate("1/2018", "from")).toThrow(/no reconocida/);
        expect(() => parseEntryDate("13/2018", "from")).toThrow(/no reconocida/);
    });

    const MAP = { sheet: "A", codeHeader: "Código NAES", descriptionHeader: "Descripción", referenceHeader: null, codeLength: null };
    const wb = (rows: unknown[][]) => {
        const w = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(rows), "A");
        return w;
    };

    it("lee las columnas de inicio y fin (encabezados con dos puntos, como el anexo oficial)", () => {
        const r = readCatalogSheet(
            wb([
                ["Código NAES", "Descripción", "Inicio de Vigencia:", "Fin de Vigencia:"],
                ["530090", "Baja", "01/2018", "12/2025"],
                ["530099", "Alta", "01/2026", ""],
            ]),
            { ...MAP, validFromHeader: "Inicio de Vigencia:", validToHeader: "Fin de Vigencia:" },
        );
        expect(r.entries).toEqual([
            { code: "530090", description: "Baja", reference: null, validFrom: "2018-01-01", validTo: "2025-12-31" },
            { code: "530099", description: "Alta", reference: null, validFrom: "2026-01-01", validTo: null },
        ]);
    });
    it("sin columnas de vigencia, las entradas no llevan vigencia propia", () => {
        expect(readCatalogSheet(wb([["Código NAES", "Descripción"], ["620100", "X"]]), MAP).entries).toEqual([{ code: "620100", description: "X", reference: null }]);
    });
    it("una sola columna indicada, fecha numérica de Excel o texto no reconocido: la importación falla", () => {
        expect(() => readCatalogSheet(wb([["Código NAES", "Descripción"]]), { ...MAP, validFromHeader: "Inicio" })).toThrow(/ambas columnas/);
        const vh = { ...MAP, validFromHeader: "Inicio", validToHeader: "Fin" };
        expect(() => readCatalogSheet(wb([["Código NAES", "Descripción", "Inicio", "Fin"], ["620100", "X", 43101, ""]]), vh)).toThrow(/debe ser texto/);
        expect(() => readCatalogSheet(wb([["Código NAES", "Descripción", "Inicio", "Fin"], ["620100", "X", "enero 2018", ""]]), vh)).toThrow(/fila 2: fecha de vigencia no reconocida/);
    });
});
