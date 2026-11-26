import { describe, it, expect } from "vitest";
import { buildAnnualReview, canApplyRule, canKeep, parseAnnualReviewBody, type ReviewRateInput } from "@/lib/iibb/annual-review";
import { THRESHOLD_RULES, rule, ruleSet } from "./_fixtures/catalogs";

// Datos ficticios.
const base = (over: Partial<ReviewRateInput>): ReviewRateInput => ({
    rateId: "rate000000001",
    jurisdictionCode: "901",
    activityCode: "620100",
    description: "Servicios de prueba",
    nomenclator: "NAES",
    catalogId: "fixture-naes-v1",
    rate: "3.5",
    treatment: "RATE",
    origin: "STUDIO_MANUAL",
    ruleRef: null,
    minimum: null,
    ...over,
});
const run = (rates: ReviewRateInput[], over: Partial<Parameters<typeof buildAnnualReview>[0]> = {}) =>
    buildAnnualReview({ sets: [ruleSet({}, [rule({ rate: "3.5" }), ...THRESHOLD_RULES])], date: "2026-03-01", registration: "LOCAL", priorYearGrossIncome: null, rates, prior: new Map(), ...over });

describe("revisión anual: estados", () => {
    it("igual a la norma sin confirmar → IGUAL (se puede aplicar); confirmada con la regla → CONFIRMADA", () => {
        const [a] = run([base({})]);
        expect(a.status).toBe("IGUAL");
        expect(canApplyRule(a)).toBe(true);
        const [b] = run([base({ origin: "CONFIRMED_SUGGESTION", ruleRef: "fixture-rules-901#r1" })]);
        expect(b.status).toBe("CONFIRMADA");
        expect(canApplyRule(b)).toBe(false);
    });
    it("la norma fija otro valor → CAMBIA; sin informar también", () => {
        expect(run([base({ rate: "3" })])[0].status).toBe("CAMBIA");
        expect(run([base({ rate: null, origin: null })])[0].status).toBe("CAMBIA");
    });
    it("tramos sin ingresos del año anterior: requiere decisión; con ingresos, sugerencia única", () => {
        const r = base({ activityCode: "479101", rate: "5" });
        expect(run([r])[0].status).toBe("COINCIDE_ALTERNATIVA");
        expect(run([base({ activityCode: "479101", rate: "4" })])[0].status).toBe("REQUIERE_DECISION");
        const [conIngresos] = run([r], { priorYearGrossIncome: "50000000.00" });
        expect(conIngresos.status).toBe("CAMBIA");
        expect(conIngresos.suggestion?.rate).toBe("3");
    });
    it("sin regla aprobada → SIN_REGLA, no se aplica nada", () => {
        const [a] = run([base({ activityCode: "011111" })]);
        expect(a.status).toBe("SIN_REGLA");
        expect(canApplyRule(a)).toBe(false);
    });
    it("año anterior y registro del año: se muestran; mantener sólo si falta registrar ese valor", () => {
        const prior = new Map([["901|620100", { rate: "3", treatment: "RATE" as const, minimum: null }]]);
        const current = new Map([["901|620100", { rate: "3.5", treatment: "RATE" as const, minimum: null, confirmedAt: "2026-02-10" }]]);
        const [a] = run([base({})], { prior, current });
        expect(a.prior).toEqual({ rate: "3", treatment: "RATE", minimum: null });
        expect(a.yearConfirmedAt).toBe("2026-02-10");
        expect(canKeep(a)).toBe(false);
        const [b] = run([base({ rate: "4" })], { prior, current });
        expect(b.yearConfirmedAt).toBeNull();
        expect(canKeep(b)).toBe(true);
        expect(canKeep(run([base({ rate: null, origin: null })])[0])).toBe(false);
    });
});

describe("revisión anual: cuerpo del pedido", () => {
    it("acepta aplicar y mantener; rechaza vacío, repetidos, acción o regla inválida", () => {
        expect(parseAnnualReviewBody({ items: [{ rateId: "rate000000001", action: "APPLY_RULE", ruleRef: "x#r1" }, { rateId: "rate000000002", action: "KEEP" }] })).toMatchObject({ ok: true });
        expect(parseAnnualReviewBody({ items: [] })).toMatchObject({ ok: false });
        expect(parseAnnualReviewBody({ items: [{ rateId: "rate000000001", action: "KEEP" }, { rateId: "rate000000001", action: "KEEP" }] })).toMatchObject({ ok: false });
        expect(parseAnnualReviewBody({ items: [{ rateId: "rate000000001", action: "SET", rate: "3" }] })).toMatchObject({ ok: false });
        expect(parseAnnualReviewBody({ items: [{ rateId: "rate000000001", action: "APPLY_RULE" }] })).toMatchObject({ ok: false });
        expect(parseAnnualReviewBody({ items: [{ rateId: "x'; drop", action: "KEEP" }] })).toMatchObject({ ok: false });
    });
});
