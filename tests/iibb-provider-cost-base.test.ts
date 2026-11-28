import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { iibbByActivity, type IibbActivityConfig } from "@/lib/iibb/activity-base";
import { buildActivityConfigInput, buildCostAdjustmentInput, cuitDigits } from "@/lib/iibb/activity-input";

// Datos ficticios.
const D = (v: string) => new Prisma.Decimal(v);
const cfg = (costs?: IibbActivityConfig["costs"]): IibbActivityConfig => ({
    jurisdictionCode: "923",
    principalCode: "791201",
    posMap: { 2: "791101" },
    activities: [
        { code: "791201", description: "Mayorista", rate: D("0.5"), exempt: false, additional: { label: "FFSS", rate: D("1.5") } },
        { code: "791101", description: "Minorista", rate: D("0.5"), exempt: false, additional: { label: "FFSS", rate: D("1.5") } },
    ],
    ...(costs ? { costs } : {}),
});
const sales = [{ pointOfSale: 1, manualCode: null, base: D("1000000") }, { pointOfSale: 2, manualCode: null, base: D("300000") }];

describe("base por diferencia (criterio del estudio)", () => {
    it("resta compras a prestadores y el ajuste; impuesto y FFSS sobre la diferencia", () => {
        const r = iibbByActivity(sales, cfg({ "791201": { providers: D("700000"), adjustment: D("-50000") } }), D("3"));
        const l = r.lines.find((x) => x.code === "791201")!;
        expect(l.difference).toMatchObject({ sales: D("1000000"), providers: D("700000"), adjustment: D("-50000"), cost: D("650000"), clamped: false });
        expect(l.base.toString()).toBe("350000");
        expect(l.tax.toString()).toBe("1750");
        expect(l.additional?.amount.toString()).toBe("5250");
        expect(r.lines.find((x) => x.code === "791101")?.base.toString()).toBe("300000");
        expect(r.base.toString()).toBe("650000");
        expect(r.warnings.some((w) => w.includes("criterio del estudio"))).toBe(true);
    });
    it("costo mayor que ventas: base 0 con advertencia", () => {
        const r = iibbByActivity(sales, cfg({ "791101": { providers: D("400000"), adjustment: D("0") } }), D("3"));
        const l = r.lines.find((x) => x.code === "791101")!;
        expect(l.base.isZero()).toBe(true);
        expect(l.difference?.clamped).toBe(true);
        expect(r.warnings.some((w) => w.includes("supera las ventas"))).toBe(true);
    });
    it("actividad con costo y sin ventas aparece con base 0", () => {
        const r = iibbByActivity([{ pointOfSale: 1, manualCode: null, base: D("1000") }], cfg({ "791101": { providers: D("10"), adjustment: D("0") } }), D("3"));
        expect(r.lines.find((x) => x.code === "791101")?.base.isZero()).toBe(true);
    });
    it("costo de una actividad que ya no está en la ficha: no se resta y se advierte", () => {
        const r = iibbByActivity(sales, cfg({ "999999": { providers: D("10"), adjustment: D("0") } }), D("3"));
        expect(r.lines.some((x) => x.code === "999999")).toBe(false);
        expect(r.warnings.some((w) => w.includes("999999"))).toBe(true);
        expect(r.base.toString()).toBe("1300000");
    });
    it("sin costos: sin cambios ni aviso", () => {
        const r = iibbByActivity(sales, cfg(), D("3"));
        expect(r.lines.every((l) => !l.difference)).toBe(true);
        expect(r.warnings.some((w) => w.includes("criterio del estudio"))).toBe(false);
    });
});

describe("prestadores en la configuración", () => {
    const codes = ["791201", "791101"];
    it("valida CUIT (dígito verificador), nombre y actividad; normaliza a 11 dígitos", () => {
        const ok = buildActivityConfigInput({ principalCode: "791201", pos: [], providers: [{ cuit: "30-71806875-0", name: " Hotel Ficticio ", activityCode: "791201" }] }, codes);
        expect(ok).toMatchObject({ ok: true, value: { providers: [{ cuit: "30718068750", name: "Hotel Ficticio", activityCode: "791201" }] } });
        expect(buildActivityConfigInput({ principalCode: null, pos: [], providers: [{ cuit: "30-71806875-1", name: "x", activityCode: "791201" }] }, codes).ok).toBe(false);
        expect(buildActivityConfigInput({ principalCode: null, pos: [], providers: [{ cuit: "30718068750", name: "", activityCode: "791201" }] }, codes).ok).toBe(false);
        expect(buildActivityConfigInput({ principalCode: null, pos: [], providers: [{ cuit: "30718068750", name: "x", activityCode: "011111" }] }, codes).ok).toBe(false);
        expect(buildActivityConfigInput({ principalCode: null, pos: [], providers: [{ cuit: "30718068750", name: "x", activityCode: "791201" }, { cuit: "30-71806875-0", name: "y", activityCode: "791101" }] }, codes).ok).toBe(false);
    });
    it("sin la clave providers no se tocan (compatibilidad)", () => {
        const r = buildActivityConfigInput({ principalCode: null, pos: [] }, codes);
        expect(r.ok && r.value.providers).toBeUndefined();
    });
    it("cuitDigits", () => {
        expect(cuitDigits("30 71806875 0")).toBe("30718068750");
        expect(cuitDigits("abc")).toBeNull();
    });
});

describe("ajustes manuales del costo", () => {
    const codes = ["791201"];
    it("importe con signo y coma decimal; nota obligatoria; sin repetidos ni cero", () => {
        expect(buildCostAdjustmentInput({ adjustments: [{ activityCode: "791201", amount: "-1.500,25", note: "NC del hotel fuera de término" }] }, codes)).toMatchObject({ ok: true, value: { adjustments: [{ amount: "-1500.25" }] } });
        expect(buildCostAdjustmentInput({ adjustments: [] }, codes).ok).toBe(true);
        expect(buildCostAdjustmentInput({ adjustments: [{ activityCode: "791201", amount: "100", note: " " }] }, codes).ok).toBe(false);
        expect(buildCostAdjustmentInput({ adjustments: [{ activityCode: "791201", amount: "0", note: "x" }] }, codes).ok).toBe(false);
        expect(buildCostAdjustmentInput({ adjustments: [{ activityCode: "791201", amount: "1,234", note: "x" }] }, codes).ok).toBe(false);
        expect(buildCostAdjustmentInput({ adjustments: [{ activityCode: "791201", amount: "1", note: "x" }, { activityCode: "791201", amount: "2", note: "y" }] }, codes).ok).toBe(false);
        expect(buildCostAdjustmentInput({ adjustments: [{ activityCode: "011111", amount: "1", note: "x" }] }, codes).ok).toBe(false);
    });
});
