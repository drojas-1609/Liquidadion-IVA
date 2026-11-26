import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { currentFiscalYear, diffRateYear, pickYearRate } from "@/lib/iibb/rate-years";
import { iibbByActivity } from "@/lib/iibb/activity-base";
import { buildGrossIncomeInput } from "@/lib/iibb/activity-input";

const D = (v: string) => new Prisma.Decimal(v);
const row = (code: string, rate: string | null, extra: Partial<{ treatment: "RATE" | "EXEMPT"; id: string }> = {}) => ({
    id: extra.id ?? `r-${code}`,
    jurisdictionCode: "920",
    activityCode: code,
    rate: rate === null ? null : D(rate),
    treatment: extra.treatment ?? ("RATE" as const),
    rateOrigin: "STUDIO_MANUAL" as const,
    ruleRef: null,
});

describe("alícuotas por año (F2)", () => {
    it("año en curso según la fecha de Argentina", () => {
        expect(currentFiscalYear("2026-12-31")).toBe(2026);
        expect(currentFiscalYear("2027-01-01")).toBe(2027);
    });

    it("diff: conserva las iguales, reemplaza las cambiadas, borra las que dejan de estar informadas", () => {
        const existing = [row("471190", "3"), row("492110", "3"), row("620100", "4")];
        const desired = [row("471190", "3.00"), row("492110", "2.5"), row("620100", null)];
        const { remove, create } = diffRateYear(existing, desired);
        expect(remove.sort()).toEqual(["r-492110", "r-620100"]);
        expect(create.map((c) => [c.activityCode, c.rate?.toString()])).toEqual([["492110", "2.5"]]);
    });

    it("la exención se conserva como dato informado sin tasa", () => {
        const { create } = diffRateYear([], [row("851010", null, { treatment: "EXEMPT" })]);
        expect(create).toHaveLength(1);
    });

    it("liquidación: alícuota del año; si falta, la de la ficha marcada", () => {
        const year = new Map([["920|471190", { rate: D("3"), treatment: "RATE" as const }]]);
        expect(pickYearRate(year, { rate: D("5"), treatment: "RATE" }, "920", "471190")).toMatchObject({ fromProfile: false });
        expect(pickYearRate(year, { rate: D("5"), treatment: "RATE" }, "920", "471190").rate?.toString()).toBe("3");
        expect(pickYearRate(year, { rate: D("1.5"), treatment: "RATE" }, "920", "492110")).toMatchObject({ fromProfile: true });
        expect(pickYearRate(year, undefined, "920", "999999")).toEqual({ rate: null, exempt: false, fromProfile: false, minimum: null, additional: null });
    });

    it("advierte cuando una alícuota usada no está confirmada para el año", () => {
        const r = iibbByActivity(
            [{ pointOfSale: 1, manualCode: null, base: D("100") }],
            { jurisdictionCode: "920", fiscalYear: 2027, principalCode: "471190", posMap: {}, activities: [{ code: "471190", description: "Kiosco", rate: D("3"), exempt: false, fromProfile: true }] },
            D("3.5"),
        );
        expect(r.tax.toFixed(2)).toBe("3.00");
        expect(r.warnings).toEqual(["La alícuota de la actividad 471190 no está confirmada para 2027: se usó la de la ficha del cliente."]);
    });
});

describe("ingresos brutos anuales", () => {
    it("acepta formato argentino y punto decimal; null borra", () => {
        expect(buildGrossIncomeInput({ incomeYear: 2025, amount: "1.234.567,89", note: "DDJJ anual" }, 2026)).toEqual({ ok: true, value: { incomeYear: 2025, amount: "1234567.89", note: "DDJJ anual" } });
        expect(buildGrossIncomeInput({ incomeYear: 2025, amount: "1234567.89" }, 2026)).toMatchObject({ ok: true, value: { amount: "1234567.89" } });
        expect(buildGrossIncomeInput({ incomeYear: 2025, amount: null }, 2026)).toMatchObject({ ok: true, value: { amount: null } });
    });
    it("rechaza negativos, años futuros y campos extra", () => {
        expect(buildGrossIncomeInput({ incomeYear: 2025, amount: "-1" }, 2026).ok).toBe(false);
        expect(buildGrossIncomeInput({ incomeYear: 2027, amount: "1" }, 2026).ok).toBe(false);
        expect(buildGrossIncomeInput({ incomeYear: 2025, amount: "1", x: 1 }, 2026).ok).toBe(false);
        expect(buildGrossIncomeInput({ incomeYear: 2025, amount: "1,234" }, 2026).ok).toBe(false);
    });
});
