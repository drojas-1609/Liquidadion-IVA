import { describe, it, expect } from "vitest";
import { ALICUOTARIA_HEADER, OTROS_HEADER, arbaCatalogEntries, arbaCorrespondences, arbaDate, arbaDecimal, arbaPeriod, arbaRates, readTsvLatin1 } from "@/scripts/activity-catalogs/arba-naiibb";
import { TRAMO_CAPS, buildArbaRules, contrastWithLaw, readLawTable, tiersOf } from "@/scripts/iibb-rates/arba-2026";
import { parsePdfLines } from "@/scripts/activity-catalogs/pdf-table";

/** Texto SINTÉTICO con el formato de la exportación oficial de ARBA (tabulado, ISO-8859-1, CRLF, tabulador final). */
function tsv(header: readonly string[], rows: string[][], trailingTab = true): Uint8Array {
    const text = [header.join("\t"), ...rows.map((r) => r.join("\t") + (trailingTab ? "\t" : ""))].join("\r\n") + "\r\n";
    return Uint8Array.from([...text].map((c) => c.charCodeAt(0))); // latin1: un byte por carácter
}
const row = (over: Partial<Record<(typeof ALICUOTARIA_HEADER)[number], string>>) =>
    ALICUOTARIA_HEADER.map(
        (h) =>
            ({
                Codigo: "011111",
                Descripcion: "Cultivo de arroz",
                Incluye: "",
                Excluye: "",
                ActividadVigenteDesde: "01/01/2018",
                ActividadVigenteHasta: "",
                Marca_No_Vigente: "",
                id_Grupo_Act_Rs: "99",
                bonif_actiba: "",
                PeriodoVigenteDesde: "202601",
                PeriodoVigenteHasta: "202612",
                TipoAlicuota: "N",
                TipoMinimoAlicuota: "",
                MontoMinimoAlicuota: "10967",
                Alicuota: "1,5",
                MontoInferiorAlicuota: "0",
                MontoSuperiorAlicuota: "0",
                Articulo: "",
                AlicuotaSUS: "",
                ...over,
            })[h],
    );

describe("lectura de la exportación de ARBA como texto", () => {
    it("coma decimal, ceros iniciales, fechas DD/MM/AAAA, períodos y acentos ISO-8859-1", () => {
        expect(arbaDecimal("1,5")).toBe("1.5");
        expect(arbaDecimal("3000000,01")).toBe("3000000.01");
        expect(arbaDecimal("0")).toBe("0");
        expect(() => arbaDecimal("1E+13")).toThrow(/no reconocido/);
        expect(() => arbaDecimal("1.500,00")).toThrow(/no reconocido/);
        expect(arbaDate("01/01/2026")).toBe("2026-01-01");
        expect(() => arbaDate("1/1/18")).toThrow(/DD\/MM\/AAAA/);
        expect(arbaPeriod("202612")).toBe("2026-12");
        const t = readTsvLatin1(tsv(ALICUOTARIA_HEADER, [row({ Descripcion: "Fabricación de máquinas" })]), ALICUOTARIA_HEADER);
        expect(t.rows[0][1]).toBe("Fabricación de máquinas");
        expect(t.rows[0][0]).toBe("011111");
    });
    it("tabulador final sólo si la celda extra está vacía; encabezado exacto", () => {
        expect(() => readTsvLatin1(tsv(ALICUOTARIA_HEADER, [[...row({}), "x"]], false), ALICUOTARIA_HEADER)).toThrow(/columnas/);
        expect(() => readTsvLatin1(tsv(["Otro"], []), ALICUOTARIA_HEADER)).toThrow(/encabezado/);
    });
    it("un código re-guardado sin ceros («11111») se rechaza: no se completan ceros", () => {
        const t = readTsvLatin1(tsv(ALICUOTARIA_HEADER, [row({ Codigo: "11111" })]), ALICUOTARIA_HEADER);
        expect(() => arbaCatalogEntries(t)).toThrow(/6 dígitos/);
    });
    it("catálogo: una entrada por código con vigencia; descripción distinta entre filas: error", () => {
        const t = readTsvLatin1(tsv(ALICUOTARIA_HEADER, [row({}), row({ TipoAlicuota: "G" }), row({ Codigo: "530091", ActividadVigenteDesde: "01/01/2026" })]), ALICUOTARIA_HEADER);
        expect(arbaCatalogEntries(t)).toEqual([
            { code: "011111", description: "Cultivo de arroz", reference: null, validFrom: "2018-01-01", validTo: null },
            { code: "530091", description: "Cultivo de arroz", reference: null, validFrom: "2026-01-01", validTo: null },
        ]);
        const bad = readTsvLatin1(tsv(ALICUOTARIA_HEADER, [row({}), row({ Descripcion: "Otra" })]), ALICUOTARIA_HEADER);
        expect(() => arbaCatalogEntries(bad)).toThrow(/distinta entre filas/);
    });
    it("alícuotas: «9999999999999,99», «1E+13» y «0» son «sin tope»; filas sin período se informan aparte", () => {
        const t = readTsvLatin1(
            tsv(ALICUOTARIA_HEADER, [
                row({ MontoSuperiorAlicuota: "9999999999999,99", MontoInferiorAlicuota: "15286053,01" }),
                row({ MontoSuperiorAlicuota: "1E+13", PeriodoVigenteDesde: "202501", PeriodoVigenteHasta: "202512" }),
                row({ Codigo: "841100", PeriodoVigenteDesde: "", PeriodoVigenteHasta: "", TipoAlicuota: "", MontoMinimoAlicuota: "", Alicuota: "", MontoInferiorAlicuota: "", MontoSuperiorAlicuota: "" }),
            ]),
            ALICUOTARIA_HEADER,
        );
        const r = arbaRates(t);
        expect(r.rows.map((x) => [x.lowerAmount, x.upperAmount])).toEqual([
            ["15286053.01", null],
            ["0", null],
        ]);
        expect(r.withoutPeriod).toEqual(["841100"]);
    });
    it("correspondencias: se conservan tal como las publica ARBA (código AFIP de 5 dígitos incluido)", () => {
        const o = readTsvLatin1(tsv(OTROS_HEADER, [["011111", "Cultivo de arroz", "EQUIVALENCIA AFIP", "11111", "Cultivo de arroz", "01/01/2018", "", "", ""]], false), OTROS_HEADER);
        expect(arbaCorrespondences(o, new Set(["011111"]))[0]).toMatchObject({ type: "EQUIVALENCIA AFIP", targetCode: "11111", from: "2018-01-01" });
        expect(() => arbaCorrespondences(o, new Set())).toThrow(/ausente del nomenclador/);
    });
});

/** Tabla SINTÉTICA del art. 20 con la disposición del PDF oficial (código a la izquierda, 8 tasas a la derecha). */
const LAW = parsePdfLines(
    [
        "6|493.2|70.5|521.4|ARTÍCULO 20. De acuerdo a lo establecido",
        "8|397.2|74.6|92.9|0111",
        ...[274, 314, 351, 388, 425, 463, 500, 538].map((x, i) => `8|394.9|${x}|${x + 20}|${i < 4 ? "0,75%" : "0%"}`),
        "19|263.7|102.0|297.4|502102 Servicio de transporte escolar fluvial. 1,50%",
        ...[308, 345, 382, 420, 457, 495, 532].map((x) => `19|263.7|${x}|${x + 20}|1,50%`),
        "25|654.4|70.5|331.2|ARTÍCULO 21. Suspéndense",
    ].join("\n"),
);

const N = (lower: string, upper: string | null, rate: string, code = "011111") => ({
    code,
    periodFrom: "2026-01",
    periodTo: "2026-12",
    rateType: "N",
    rate,
    minimumAmount: "10967",
    lowerAmount: lower,
    upperAmount: upper,
    upperRaw: "",
    article: null,
    rsGroup: "99",
    bonification: false,
    rateSUS: null,
});

describe("contraste con la Ley 15.558 y reglas 2026", () => {
    const law = readLawTable(LAW);
    it("lee clases y códigos, también con la tasa general pegada al texto del código", () => {
        expect(law.get("0111")).toEqual(["0.75", "0.75", "0.75", "0.75", "0", "0", "0", "0"]);
        expect(law.get("502102")).toEqual(Array(8).fill("1.5"));
    });
    const tiers = [N("0", TRAMO_CAPS[3], "0"), N(`${TRAMO_CAPS[3]}.01`, null, "0.75")];
    it("tramos que coinciden con la ley en las 8 columnas", () => {
        expect(contrastWithLaw("011111", tiersOf(tiers), law)).toBeNull();
        expect(contrastWithLaw("011111", tiersOf([N("0", TRAMO_CAPS[3], "0"), N(`${TRAMO_CAPS[3]}.01`, null, "1")]), law)).toMatch(/general exportación 1 % \/ ley 0.75 %/);
        expect(contrastWithLaw("999999", tiersOf(tiers), law)).toMatch(/sin fila/);
    });
    it("topes que no son del art. 20, huecos y filas duplicadas", () => {
        expect(() => tiersOf([N("0", "100", "0"), N("100.01", null, "1")])).toThrow(/no es un tope del art. 20/);
        expect(() => tiersOf([N("0", TRAMO_CAPS[3], "0"), N("200000000", null, "1")])).toThrow(/se esperaba/);
        const notes: string[] = [];
        const dedup = tiersOf([N("0", TRAMO_CAPS[2], "4.5"), N(TRAMO_CAPS[2], null, "5"), N(`${TRAMO_CAPS[2]}.01`, null, "5")], notes);
        expect(dedup).toHaveLength(2);
        expect(notes[0]).toMatch(/fila duplicada/);
    });
    it("reglas: condicionadas por ingresos y hechos declarados; retención de códigos con datos no definidos o tratamientos especiales", () => {
        const same = (code: string) => [N("0", TRAMO_CAPS[3], "0", code), N(`${TRAMO_CAPS[3]}.01`, null, "0.75", code)];
        const rows = [
            ...same("011111"),
            { ...N("0", null, "0.75", "011111"), rateType: "G" },
            ...same("011112"),
            { ...N("0", null, "2", "011112"), article: "Art.134" },
            ...same("011119").map((r) => ({ ...r, bonification: true })),
        ];
        const { rules, held, problems } = buildArbaRules(rows, law, new Set(["011111", "011112", "011119"]));
        expect(problems).toEqual([]);
        expect(held).toEqual(["011112", "011119"]);
        const r = rules.find((x) => x.activityCodes.includes("011111") && x.rate === "0")!;
        expect(r.activityCodes).toEqual(["011111"]);
        expect(r.conditions.map((c) => (c.kind === "DECLARED_FACT" ? c.factKey : c.kind))).toEqual(["pbaSinExencion", "pbaNoInicioEnEjercicio", "PRIOR_YEAR_GROSS_INCOME"]);
        expect(r.registrations).toEqual(["LOCAL", "CONVENIO_MULTILATERAL"]);
        expect(r.pendingInterpretation).toBeUndefined();
        expect(rules.filter((x) => x.activityCodes.some((c) => held.includes(c))).every((x) => typeof x.pendingInterpretation === "string")).toBe(true);
        // Código que no está en el catálogo: sin regla.
        expect(buildArbaRules(same("999999"), law, new Set()).problems[0]).toMatch(/no está en el catálogo/);
    });
});
