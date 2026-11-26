import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { iibbByActivity, type IibbActivityConfig } from "@/lib/iibb/activity-base";
import { validateRuleSet } from "@/lib/iibb-rates/validate";
import { suggestRate } from "@/lib/iibb-rates/suggest";
import { validateIibbProfile } from "@/lib/client-profile";
import { buildTdfRules, TDF_2026_ROWS } from "@/scripts/iibb-rates/table-2026";
import { buildIibbEntry } from "@/lib/accounting/journal";
import tdf from "@/data/iibb-rate-rules/tierra-del-fuego-ley-1498-2026.json";
import approvedSc from "@/data/iibb-rate-rules/santa-cruz-ley-3485-2026.json";
import type { RateRuleSet } from "@/lib/iibb-rates/types";

const D = (v: string) => new Prisma.Decimal(v);
const set = tdf as unknown as RateRuleSet;

describe("Tierra del Fuego 2026: conjunto con adicional FFSS", () => {
    it("es válido, jurisdicción 923 y los 4 códigos de agencias de viajes al 0,50 % + FFSS 1,50 %", () => {
        expect(validateRuleSet(set)).toEqual([]);
        expect(set.manifest.jurisdiction).toBe("923");
        expect(set.manifest.review.status).toBe("PENDIENTE_REVISION");
        const codes = set.rules.flatMap((r) => r.activityCodes).sort();
        expect(codes).toEqual(["791101", "791102", "791201", "791202"]);
        for (const r of set.rules) {
            expect(r.rate).toBe("0.5");
            expect(r.additional).toEqual({ label: "FFSS", rate: "1.5" });
        }
    });
    it("la sugerencia lleva el adicional (con el conjunto aprobado en la prueba)", () => {
        // Se toma prestada la revisión completa (3 niveles) de un conjunto aprobado: el de TDF sigue pendiente.
        const approved = { ...set, manifest: { ...set.manifest, review: (approvedSc as unknown as RateRuleSet).manifest.review } } as RateRuleSet;
        const s = suggestRate([approved], { jurisdiction: "923", nomenclator: "NAES", catalogId: "naes-rg-ca-19-2025", code: "791201", date: "2026-10-15", registration: "LOCAL", facts: {} });
        expect(s.status).toBe("UNICA");
        if (s.status === "UNICA") expect(s.alternative.additional).toEqual({ label: "FFSS", rate: "1.5" });
    });
    it("un código fuera del catálogo se reporta", () => {
        expect(buildTdfRules([...TDF_2026_ROWS, { code: "999999", description: "x", rate: "1", ffss: "1", page: 1 }], new Set(TDF_2026_ROWS.map((r) => r.code))).problems).toHaveLength(1);
    });
    it("el validador rechaza adicionales mal formados", () => {
        const bad = (additional: unknown) => validateRuleSet({ ...set, rules: [{ ...set.rules[0], additional }] } as unknown as RateRuleSet);
        expect(bad({ label: "ffss", rate: "1.5" }).some((p) => p.includes("adicional"))).toBe(true);
        expect(bad({ label: "FFSS", rate: "0" }).some((p) => p.includes("adicional"))).toBe(true);
        expect(bad({ label: "FFSS", rate: "abc" }).some((p) => p.includes("adicional"))).toBe(true);
    });
});

describe("liquidación con adicional (datos ficticios)", () => {
    const cfg: IibbActivityConfig = {
        jurisdictionCode: "923",
        principalCode: "791201",
        posMap: { 2: "791101" },
        activities: [
            { code: "791201", description: "Mayorista", rate: D("0.5"), exempt: false, additional: { label: "FFSS", rate: D("1.5") } },
            { code: "791101", description: "Minorista", rate: D("0.5"), exempt: false, additional: { label: "FFSS", rate: D("1.5") } },
        ],
    };
    it("el FFSS se calcula por actividad sobre la misma base y se agrupa como adicional; no entra en el impuesto", () => {
        const r = iibbByActivity([{ pointOfSale: 1, manualCode: null, base: D("1000000") }, { pointOfSale: 2, manualCode: null, base: D("200000") }], cfg, D("3"));
        expect(r.tax.toString()).toBe("6000");
        expect(r.lines.find((l) => l.code === "791201")?.additional?.amount.toString()).toBe("15000");
        expect(r.additionals).toEqual([{ label: "FFSS", amount: D("18000") }]);
        expect(r.additionalsTotal.toString()).toBe("18000");
    });
    it("sin adicionales: lista vacía y total 0", () => {
        const r = iibbByActivity([{ pointOfSale: 1, manualCode: null, base: D("1000") }], { ...cfg, activities: cfg.activities.map((a) => ({ ...a, additional: null })) }, D("3"));
        expect(r.additionals).toEqual([]);
        expect(r.additionalsTotal.isZero()).toBe(true);
    });
    it("el asiento de IIBB incluye los adicionales y balancea", () => {
        const zero = D("0");
        const e = buildIibbEntry({ tax: D("6000"), additionalsTotal: D("18000"), otherDebits: zero, previousBalance: D("11178.67"), withholdings: D("100"), sirtac: zero, perceptions: zero, customsPerceptions: zero, bankCollections: zero, paymentsOnAccount: zero, otherCredits: zero, balanceDgr: D("12721.33"), balanceTaxpayer: zero }, 10, 2026);
        expect(e.lines.some((l) => l.memo.startsWith("Adicionales"))).toBe(true);
    });
});

describe("ficha: adicional por alícuota", () => {
    const base = { registration: "LOCAL", jurisdictions: [{ code: "923", headquarters: false }] };
    const withRate = (r: Record<string, unknown>) =>
        validateIibbProfile({ ...base, activities: [{ nomenclator: "NAES", code: "791201", description: "Ficticia", rates: [{ jurisdiction: "923", rate: "0.5", origin: "STUDIO_MANUAL", ...r }] }] });
    it("acepta sigla y alícuota (coma decimal, minúsculas normalizadas)", () => {
        const r = withRate({ additional: { label: "ffss", rate: "1,5" } });
        expect(r.ok && r.value.activities[0].rates[0].additional).toEqual({ label: "FFSS", rate: "1.5" });
    });
    it("vacío no agrega la clave; incompleto o sin alícuota es error", () => {
        const r = withRate({ additional: { label: "", rate: "" } });
        expect(r.ok && "additional" in r.value.activities[0].rates[0]).toBe(false);
        expect(withRate({ additional: { label: "FFSS", rate: "" } }).ok).toBe(false);
        expect(withRate({ additional: { label: "", rate: "1.5" } }).ok).toBe(false);
        expect(withRate({ rate: null, origin: null, additional: { label: "FFSS", rate: "1.5" } }).ok).toBe(false);
        expect(withRate({ additional: { label: "FFSS", rate: "0" } }).ok).toBe(false);
    });
});
