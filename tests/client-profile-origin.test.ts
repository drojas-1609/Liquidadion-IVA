import { describe, it, expect } from "vitest";
import { validateIibbProfile } from "@/lib/client-profile";

const base = { registration: "CONVENIO_MULTILATERAL", jurisdictions: [{ code: "901", headquarters: true }, { code: "902", headquarters: false }] };
const act = (over: Record<string, unknown> = {}) => ({ nomenclator: "NAES", code: "620100", description: "Servicios de prueba", rates: [], ...over });
const ok = (activity: Record<string, unknown>) => validateIibbProfile({ ...base, activities: [act(activity)] });

describe("origen de la actividad", () => {
    it("sin origen: MANUAL sin catálogo (compatibilidad con cargas previas)", () => {
        const r = ok({});
        expect(r.ok && [r.value.activities[0].origin, r.value.activities[0].catalogId, r.value.activities[0].catalogVersion]).toEqual(["MANUAL", null, null]);
    });
    it("CATALOG exige catálogo y versión; se conservan como string", () => {
        const r = ok({ origin: "CATALOG", catalogId: "naes-rg-ca-19-2025", catalogVersion: "RG CA 19/2025", code: "011111" });
        expect(r.ok && r.value.activities[0]).toMatchObject({ origin: "CATALOG", catalogId: "naes-rg-ca-19-2025", catalogVersion: "RG CA 19/2025", code: "011111" });
        expect(ok({ origin: "CATALOG" })).toMatchObject({ ok: false, field: "iibb.activities[0].catalogId" });
        expect(ok({ origin: "CATALOG", catalogId: "naes-x" })).toMatchObject({ ok: false, field: "iibb.activities[0].catalogVersion" });
        expect(ok({ origin: "CATALOG", catalogId: "Mayúsculas Inválidas", catalogVersion: "v" })).toMatchObject({ ok: false });
    });
    it("MANUAL no lleva catálogo; OTRO no puede ser de catálogo; origen desconocido rechazado", () => {
        expect(ok({ origin: "MANUAL", catalogId: "naes-x" })).toMatchObject({ ok: false, field: "iibb.activities[0].origin" });
        expect(ok({ origin: "CATALOG", nomenclator: "OTRO", nomenclatorReference: "x", catalogId: "naes-x", catalogVersion: "v" })).toMatchObject({ ok: false, field: "iibb.activities[0].origin" });
        expect(ok({ origin: "IA" })).toMatchObject({ ok: false, field: "iibb.activities[0].origin" });
    });
});

describe("tratamiento y origen de la alícuota", () => {
    const rate = (over: Record<string, unknown>) => ok({ rates: [{ jurisdiction: "901", ...over }] });
    const first = (r: ReturnType<typeof rate>) => (r.ok ? r.value.activities[0].rates[0] : null);

    it("0 %, exento y sin informar son distintos", () => {
        expect(first(rate({ rate: "0", origin: "STUDIO_MANUAL" }))).toEqual({ jurisdiction: "901", rate: "0", treatment: "RATE", origin: "STUDIO_MANUAL", ruleRef: null });
        expect(first(rate({ treatment: "EXEMPT", origin: "STUDIO_MANUAL" }))).toEqual({ jurisdiction: "901", rate: null, treatment: "EXEMPT", origin: "STUDIO_MANUAL", ruleRef: null });
        expect(first(rate({ rate: null }))).toEqual({ jurisdiction: "901", rate: null, treatment: "RATE", origin: null, ruleRef: null });
    });
    it("exención con tasa, o dato ausente con origen: rechazados", () => {
        expect(rate({ treatment: "EXEMPT", rate: "0" })).toMatchObject({ ok: false, field: "iibb.activities[0].rates[0]" });
        expect(rate({ rate: "", origin: "STUDIO_MANUAL" })).toMatchObject({ ok: false });
        expect(rate({ treatment: "OTRO" })).toMatchObject({ ok: false });
    });
    it("sugerencia confirmada exige regla; la regla sólo acompaña a una sugerencia confirmada", () => {
        expect(first(rate({ rate: "3.5", origin: "CONFIRMED_SUGGESTION", ruleRef: "caba-2026#r1" }))).toMatchObject({ origin: "CONFIRMED_SUGGESTION", ruleRef: "caba-2026#r1" });
        expect(rate({ rate: "3.5", origin: "CONFIRMED_SUGGESTION" })).toMatchObject({ ok: false });
        expect(rate({ rate: "3.5", origin: "CONFIRMED_SUGGESTION", ruleRef: "sin-numeral" })).toMatchObject({ ok: false });
        expect(rate({ rate: "3.5", origin: "STUDIO_MANUAL", ruleRef: "caba-2026#r1" })).toMatchObject({ ok: false });
    });
    it("tasa manual confirmada por el estudio, con su origen", () => {
        expect(first(rate({ rate: "4.25", origin: "STUDIO_MANUAL" }))).toMatchObject({ rate: "4.25", origin: "STUDIO_MANUAL" });
    });
    it("tasa sin origen (carga previa) se conserva tal cual", () => {
        expect(first(rate({ rate: "3.5" }))).toMatchObject({ rate: "3.5", origin: null, ruleRef: null });
    });
});
