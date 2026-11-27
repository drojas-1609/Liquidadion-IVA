import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { allocateCost, parseRateMap, parseSplits, type CostInvoice, type CostProvider } from "@/lib/iibb/provider-costs";
import { buildActivityConfigInput } from "@/lib/iibb/activity-input";

// Datos ficticios.
const D = (v: string) => new Prisma.Decimal(v);
const inv = (over: Partial<CostInvoice> = {}): CostInvoice => ({
    id: "inv000000001", sign: 1,
    vatNets: [{ code: 5, net: D("1000") }, { code: 4, net: D("500") }],
    exemptAndNonTaxed: D("200"), withoutVat: D("0"), legacyNet: null, splits: [], ...over,
});
const prov = (over: Partial<CostProvider> = {}): CostProvider => ({ cuit: "30718068750", name: "Prestador", activityCode: "791100", mode: "SINGLE", rateMap: null, ...over });
const obj = (m: Map<string, Prisma.Decimal>) => Object.fromEntries([...m].map(([k, v]) => [k, v.toString()]));

describe("reparto del costo de un prestador", () => {
    it("SINGLE: todo el neto (gravado + exento) a su actividad", () => {
        expect(obj(allocateCost(prov(), inv()).byActivity)).toEqual({ "791100": "1700" });
    });
    it("BY_VAT_RATE: 21 % a turismo, 10,5 % y exento no restan (transporte propio)", () => {
        const a = allocateCost(prov({ mode: "BY_VAT_RATE", rateMap: { "4": "", EXENTO: "" } }), inv());
        expect(obj(a.byActivity)).toEqual({ "791100": "1000", "": "700" });
    });
    it("BY_VAT_RATE con alícuota no mapeada → actividad por defecto; nota de crédito con signo", () => {
        const a = allocateCost(prov({ mode: "BY_VAT_RATE", rateMap: { "5": "960999" } }), inv({ sign: -1 }));
        expect(obj(a.byActivity)).toEqual({ "960999": "-1000", "791100": "-700" });
    });
    it("MANUAL sin reparto: pendiente y no resta; con reparto manda el reparto", () => {
        const pend = allocateCost(prov({ mode: "MANUAL" }), inv());
        expect(pend.pending).toBe(true);
        expect(pend.byActivity.size).toBe(0);
        const done = allocateCost(prov({ mode: "MANUAL" }), inv({ splits: [{ activityCode: "791100", amount: D("1200") }, { activityCode: "", amount: D("500") }] }));
        expect(done.manual).toBe(true);
        expect(obj(done.byActivity)).toEqual({ "791100": "1200", "": "500" });
    });
    it("el reparto manual manda aunque el prestador sea SINGLE; filas heredadas van a la actividad por defecto", () => {
        expect(obj(allocateCost(prov(), inv({ splits: [{ activityCode: "", amount: D("1700") }] })).byActivity)).toEqual({ "": "1700" });
        expect(obj(allocateCost(prov({ mode: "BY_VAT_RATE", rateMap: { "5": "" } }), inv({ legacyNet: D("900"), vatNets: [] })).byActivity)).toEqual({ "791100": "900" });
    });
    it("factura C: la parte sin IVA discriminado usa la clave SIN_IVA", () => {
        const a = allocateCost(prov({ mode: "BY_VAT_RATE", rateMap: { SIN_IVA: "" } }), inv({ vatNets: [], exemptAndNonTaxed: D("0"), withoutVat: D("3000") }));
        expect(obj(a.byActivity)).toEqual({ "": "3000" });
    });
});

describe("validaciones", () => {
    const codes = new Set(["791100", "492120"]);
    it("mapa por alícuota: claves conocidas, actividades de la ficha o «no resta»", () => {
        expect(parseRateMap({ "5": "791100", "4": "", EXENTO: "" }, codes).ok).toBe(true);
        expect(parseRateMap({ "7": "791100" }, codes).ok).toBe(false);
        expect(parseRateMap({ "5": "999999" }, codes).ok).toBe(false);
        expect(parseRateMap([], codes).ok).toBe(false);
    });
    it("reparto: suma igual al neto, positivos, sin repetir; vacío = quitar", () => {
        expect(parseSplits([{ activityCode: "791100", amount: "1.200,00" }, { activityCode: "", amount: "500" }], codes, D("1700")).ok).toBe(true);
        expect(parseSplits([{ activityCode: "791100", amount: "1200" }], codes, D("1700"))).toMatchObject({ ok: false, error: expect.stringContaining("1700.00") });
        expect(parseSplits([{ activityCode: "791100", amount: "-1" }], codes, D("1700")).ok).toBe(false);
        expect(parseSplits([{ activityCode: "791100", amount: "1" }, { activityCode: "791100", amount: "1" }], codes, D("2")).ok).toBe(false);
        expect(parseSplits([], codes, D("1700"))).toEqual({ ok: true, value: [] });
    });
    it("configuración de prestadores con modo", () => {
        const base = { principalCode: null, pos: [] };
        expect(buildActivityConfigInput({ ...base, providers: [{ cuit: "30718068750", name: "x", activityCode: "", mode: "BY_VAT_RATE", rateMap: { "5": "791100" } }] }, [...codes])).toMatchObject({ ok: true });
        expect(buildActivityConfigInput({ ...base, providers: [{ cuit: "30718068750", name: "x", activityCode: "", mode: "SINGLE" }] }, [...codes]).ok).toBe(false);
        expect(buildActivityConfigInput({ ...base, providers: [{ cuit: "30718068750", name: "x", activityCode: "791100", mode: "SINGLE", rateMap: { "5": "" } }] }, [...codes]).ok).toBe(false);
        expect(buildActivityConfigInput({ ...base, providers: [{ cuit: "30718068750", name: "x", activityCode: "791100", mode: "OTRO" }] }, [...codes]).ok).toBe(false);
        // Sin modo: SINGLE (compatibilidad con la versión anterior del formulario).
        expect(buildActivityConfigInput({ ...base, providers: [{ cuit: "30718068750", name: "x", activityCode: "791100" }] }, [...codes])).toMatchObject({ ok: true, value: { providers: [{ mode: "SINGLE", rateMap: null }] } });
    });
});
