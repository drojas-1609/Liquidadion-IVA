import { describe, it, expect } from "vitest";
import { parsePdfLines, readPdfTable } from "@/scripts/activity-catalogs/pdf-table";
import { crosscheckAgainstText, sliceSection } from "@/scripts/activity-catalogs/crosscheck-pdf";

/**
 * Volcado SINTÉTICO con las particularidades del anexo de la RG 3537 (CLAE):
 * código y descripción en la misma selección o en segmentos separados, una
 * misma línea partida en dos segmentos, descripciones de dos renglones, notas
 * «(Incluye…)» que no se copian y un código cuyo renglón queda debajo de la
 * nota del código anterior.
 */
const DUMP = [
    "1|700.0|62.5|195.9|ESTRUCTURA DE PRUEBA",
    "1|680.0|122.8|214.6|011111 Cultivo de prueba",
    "1|665.0|122.8|148.6|011119",
    "1|665.0|159.5|344.5|Cultivo de cereales de prueba n.c.p.",
    "1|650.0|159.5|299.4|(Incluye alforfón de prueba, etc.)",
    "1|635.0|122.8|148.6|011299",
    "1|635.0|159.5|265.6|Cultivo de oleaginosas,",
    "1|635.0|270.0|422.3|excepto soja de prueba",
    "1|612.3|122.8|148.6|011310",
    "1|624.0|159.5|543.1|(Incluye cártamo, colza, jojoba, lino",
    "1|613.9|159.5|309.7|oleaginoso, maní, etc.)",
    "1|612.3|159.5|279.7|Cultivo de papa de prueba",
    "1|597.0|122.8|148.6|161001",
    "1|597.0|159.5|540.0|Fabricación de muebles de prueba, excepto los de madera (metal, plástico,",
    "1|586.4|159.5|174.4|etc.)",
    "1|560.0|96.1|232.3|170 Grupo de prueba",
    "1|545.0|122.8|148.6|170101",
    "1|545.0|159.5|540.0|Fabricación de pasta de madera de prueba que ocupa dos",
    "1|534.3|159.5|300.0|renglones completos",
    "1|519.0|159.5|400.0|(No incluye otras actividades de prueba)",
    "1|4.8|293.3|301.2|31",
    "2|700.0|122.8|210.0|990000 Organismos extraterritoriales de prueba",
    "2|680.0|62.0|300.0|TABLA ANEXA AL F. 883",
    "2|660.0|122.8|188.5|000007 Jubilado",
].join("\n");

const OPTS = { codeX: [120, 130] as [number, number], descriptionX: 155, until: "TABLA ANEXA AL F. 883" };

describe("importación de una tabla publicada sólo en PDF", () => {
    const entries = readPdfTable(parsePdfLines(DUMP), OPTS);

    it("toma cada código con su descripción y no copia las notas entre paréntesis", () => {
        expect(entries).toEqual([
            { code: "011111", description: "Cultivo de prueba", reference: null },
            { code: "011119", description: "Cultivo de cereales de prueba n.c.p.", reference: null },
            { code: "011299", description: "Cultivo de oleaginosas, excepto soja de prueba", reference: null },
            { code: "011310", description: "Cultivo de papa de prueba", reference: null },
            { code: "161001", description: "Fabricación de muebles de prueba, excepto los de madera (metal, plástico, etc.)", reference: null },
            { code: "170101", description: "Fabricación de pasta de madera de prueba que ocupa dos renglones completos", reference: null },
            { code: "990000", description: "Organismos extraterritoriales de prueba", reference: null },
        ]);
    });
    it("lo posterior a --until (la tabla de responsables no comprendidos) no se importa", () => {
        expect(entries.some((e) => e.code === "000007")).toBe(false);
        expect(() => readPdfTable(parsePdfLines(DUMP), { ...OPTS, until: "NO EXISTE" })).toThrow(/no se encontró --until/);
    });
    it("un código sin descripción en su renglón hace fallar la importación", () => {
        expect(() => readPdfTable(parsePdfLines("1|700.0|122.8|148.6|011111\n1|650.0|159.5|300.0|Texto lejano"), { ...OPTS, until: null })).toThrow(/no tiene descripción/);
    });
    it("un volcado mal formado se rechaza", () => {
        expect(() => parsePdfLines("1|x|122.8|148.6|011111 Algo")).toThrow(/volcado inválida/);
    });
});

/** Texto SINTÉTICO como el que PDFKit extrae del anexo I de la RG CA 19/2025. */
const ANNEX = [
    "Artículo 1°.- ... 530090 ... (texto del articulado, se saltea)",
    "Anexo I",
    "NAES - Nomenclador de prueba",
    "011111 Cultivo de arroz El cultivo de prueba",
    "y otras cosas.",
    "Sin descripción. 01/2018",
    "530090",
    "Servicios de",
    "mensajerías.",
    "La recolección de prueba. 01/2018 12/2025",
    "530099 Servicios de mensajerías n.c.p. Incluye prueba 01/2026",
    "Tabla de Equivalencias de prueba",
    "999999 Fuera del tramo",
].join("\n");

const CATALOG = [
    { code: "011111", description: "Cultivo de arroz", reference: null, validFrom: "2018-01-01", validTo: null },
    { code: "530090", description: "Servicios de mensajerías.", reference: null, validFrom: "2018-01-01", validTo: "2025-12-31" },
    { code: "530099", description: "Servicios de mensajerías n.c.p.", reference: null, validFrom: "2026-01-01", validTo: null },
];

describe("cotejo de una versión importada contra el texto del anexo en PDF", () => {
    const text = sliceSection(ANNEX, "NAES - Nomenclador de prueba", "Tabla de Equivalencias");

    it("sin diferencias cuando código, orden, descripción y vigencias coinciden", () => {
        expect(crosscheckAgainstText(CATALOG, text)).toEqual({ checked: 3, missingCodes: [], extraCodes: [], descriptionMismatches: [], validityMismatches: [] });
    });
    it("detecta descripción distinta, vigencia distinta, código ausente y código sobrante", () => {
        const r = crosscheckAgainstText([{ ...CATALOG[0], description: "Cultivo de trigo" }, { ...CATALOG[1], validTo: "2026-12-31" }, CATALOG[2]], text);
        expect(r.descriptionMismatches).toEqual(["011111"]);
        expect(r.validityMismatches).toEqual([{ code: "530090", expected: "01/2018 12/2026", found: "01/2018 12/2025" }]);
        const other = crosscheckAgainstText([CATALOG[0], CATALOG[1], { code: "777777", description: "No existe", reference: null }], text);
        expect(other.missingCodes).toEqual(["777777"]);
        expect(other.extraCodes).toEqual(["530099"]);
    });
    it("las marcas acotan el tramo; una marca inexistente es un error", () => {
        expect(text).not.toContain("999999");
        expect(text).not.toContain("Artículo 1°");
        expect(() => sliceSection(ANNEX, "NO EXISTE", null)).toThrow(/--from/);
    });
});
