import { describe, expect, it } from "vitest";
import { buildCtesRules, buildScRules, normRate, readCtesRows, readScRows, CTES_MINIMUM_BY_RATE } from "../scripts/iibb-rates/table-2026";
import { validateRuleSet } from "@/lib/iibb-rates/validate";
import { suggestRate } from "@/lib/iibb-rates/suggest";
import type { RateRuleSet } from "@/lib/iibb-rates/types";
import ctes from "@/data/iibb-rate-rules/corrientes-rg-293-2025.json";
import sc from "@/data/iibb-rate-rules/santa-cruz-ley-3485-2026.json";

const CTES = ctes as unknown as RateRuleSet;
const SC = sc as unknown as RateRuleSet;
const approved = (s: RateRuleSet): RateRuleSet => ({ ...s, manifest: { ...s.manifest, review: { status: "REVISADO", reviewedBy: "test", reviewedAt: "2026-11-24", levels: Object.fromEntries(Object.keys(s.manifest.review.levels).map((k) => [k, { status: "CONFORME", reviewer: "test", date: "2026-11-24", notes: "test" }])) } as never } });

describe("lectura de las tablas", () => {
    it("alícuotas en ambos formatos", () => {
        expect(["2,90%", "2.9", "5%", "0,75%"].map(normRate)).toEqual(["2.9", "2.9", "5", "0.75"]);
    });
    it("Corrientes: filas con régimen, mínimo con coma, no alcanzado e ilegibles", () => {
        const t = [
            "  11111     Cultivo de arroz                     1.15       80       0001    Regimen General",
            "  11111     Cultivo de arroz                      2.9      200       0003       Por Menor",
            "  551022    Hoteles                               2.9       4,5      1001       Hotel 1 est",
            "  949920    Consorcios                            >No alcanzado",
            "  410021                                          2.50      200        6          Fonavi",
            "  999999    algo raro",
        ].join("\n");
        const r = readCtesRows(t);
        expect(r.rows.map((x) => [x.code, x.rate, x.minimum, x.regime])).toEqual([
            ["011111", "1.15", "80", "0001"],
            ["011111", "2.9", "200", "0003"],
            ["551022", "2.9", "4.5", "1001"],
            ["410021", "2.5", "200", "0006"],
        ]);
        expect(r.notTaxed).toEqual(["949920"]);
        expect(r.problems).toHaveLength(1);
    });
    it("Santa Cruz: la alícuota puede estar en una línea vecina", () => {
        const t = ["   11111   Cultivo de arroz        0,75%", "   descripción larga        1,50%", "   13012", "   960999  Intermediación         5,00%"].join("\n");
        const r = readScRows(t);
        expect(r.problems).toEqual([]);
        expect(r.rows).toEqual([
            { code: "011111", rate: "0.75" },
            { code: "013012", rate: "1.5" },
            { code: "960999", rate: "5" },
        ]);
    });
});

describe("Corrientes 2026 (RG DGR 293/2025)", () => {
    const rows = (...x: [string, string, string, string][]) => x.map(([code, rate, minimum, regime]) => ({ code, description: "x", rate, minimum, regime, regimeName: "x" }));
    it("general con el hecho contrario y alternativa con hecho declarado; mínimos del art. 10 A", () => {
        const { rules, problems } = buildCtesRules(rows(["011111", "1.15", "80", "0001"], ["011111", "2.9", "200", "0003"]), new Set(["011111"]));
        expect(problems).toEqual([]);
        const g = rules.find((r) => r.id.startsWith("general"))!;
        const a = rules.find((r) => r.id.startsWith("ctesVentaConsumidorFinal"))!;
        expect([g.rate, g.minimumMonthly, a.rate, a.minimumMonthly]).toEqual(["1.15", "80", "2.9", "200"]);
        expect(g.conditions.at(-1)).toMatchObject({ factKey: "ctesVentaConsumidorFinal", expected: false });
        expect(a.conditions.at(-1)).toMatchObject({ factKey: "ctesVentaConsumidorFinal", expected: true });
        expect(CTES_MINIMUM_BY_RATE["2.9"]).toBe("200");
    });
    it("retiene categorías por habitación, mínimos distintos del art. 10 A y regímenes duplicados", () => {
        const { held } = buildCtesRules(rows(["551021", "2.9", "3", "0001"], ["551022", "2.9", "4.5", "1001"], ["581100", "1.75", "125", "0001"], ["581100", "2.9", "200", "0001"]), new Set(["551021", "551022", "581100"]));
        expect(held).toEqual(["551021", "551022", "581100"]);
    });
    it("conjunto generado: válido, 1008 códigos, 16 retenidos, pendiente de revisión", () => {
        expect(validateRuleSet(CTES)).toEqual([]);
        expect(new Set(CTES.rules.flatMap((r) => r.activityCodes)).size).toBe(1008);
        expect(new Set(CTES.rules.filter((r) => r.pendingInterpretation).flatMap((r) => r.activityCodes)).size).toBe(16);
        expect(CTES.manifest).toMatchObject({ jurisdiction: "905", nomenclator: "NAES", validFrom: "2026-01-01" });
    });
    it("sugiere 1,15 % con mínimo $ 80 para el cultivo de arroz al por mayor", () => {
        const s = suggestRate([approved(CTES)], { jurisdiction: "905", nomenclator: "NAES", catalogId: "naes-rg-ca-19-2025", code: "011111", date: "2026-03-01", registration: "LOCAL", facts: { declared: { ctesSinTratamientoEspecial: true, ctesVentaConsumidorFinal: false } } });
        expect(s.status === "UNICA" && [s.alternative.rate, s.alternative.minimumMonthly]).toEqual(["1.15", "80"]);
    });
});

describe("Santa Cruz 2026 (Ley 3485, nomenclador ARCA)", () => {
    it("mínimos del art. 7 y una sola alícuota por código", () => {
        const { rules, problems } = buildScRules([{ code: "551010", rate: "4.5" }, { code: "471190", rate: "3" }, { code: "939030", rate: "15" }], new Set(["551010", "471190", "939030"]));
        expect(problems).toEqual([]);
        expect(rules.map((r) => [r.activityCodes[0], r.rate, r.minimumMonthly ?? null])).toEqual([
            ["551010", "4.5", "3500"],
            ["471190", "3", null],
            ["939030", "15", "6000"],
        ]);
        expect(buildScRules([{ code: "471190", rate: "3" }, { code: "471190", rate: "2" }], new Set(["471190"])).problems[0]).toMatch(/dos alícuotas/);
    });
    it("conjunto generado: válido sólo por ser Santa Cruz (ARCA), 949 códigos, y las actividades de OOSHEN", () => {
        expect(validateRuleSet(SC)).toEqual([]);
        expect(validateRuleSet({ ...SC, manifest: { ...SC.manifest, jurisdiction: "901" } })).toContain("nomenclador inválido");
        const rate = new Map(SC.rules.flatMap((r) => r.activityCodes.map((c) => [c, r.rate] as const)));
        expect(rate.size).toBe(949);
        expect([rate.get("471190"), rate.get("492110")]).toEqual(["3", "2"]);
    });
    it("sugiere por código ARCA, no por NAES", () => {
        const q = { jurisdiction: "920", catalogId: null, code: "471190", date: "2026-03-01", registration: "LOCAL" as const, facts: { declared: { scRegimenGeneral: true } } };
        const s = suggestRate([approved(SC)], { ...q, nomenclator: "ARCA" });
        expect(s.status === "UNICA" && s.alternative.rate).toBe("3");
        expect(suggestRate([approved(SC)], { ...q, nomenclator: "NAES" }).status).toBe("SIN_COBERTURA");
    });
});
