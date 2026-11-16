import { describe, it, expect } from "vitest";
import { parseInitialData, storedInitialData, usesPortalIva } from "@/lib/arca-sync/initial-data";

const none = { nonTaxedOrExempt: false, creditComputation: null, definitiveImports: false, serviceImports: false, turiva: false, usedGoods: false };

describe("datos iniciales de IVA Simple", () => {
    it("acepta la elección completa y exige la forma de cómputo sólo con operaciones no gravadas o exentas", () => {
        expect(parseInitialData(none)).toEqual({ ok: true, value: none });
        expect(parseInitialData({ ...none, nonTaxedOrExempt: true, creditComputation: "GLOBAL" })).toMatchObject({ ok: true });
        expect(parseInitialData({ ...none, nonTaxedOrExempt: true })).toMatchObject({ ok: false });
        expect(parseInitialData({ ...none, creditComputation: "DIRECT" })).toMatchObject({ ok: false });
    });

    it.each([[null], [[]], [{ ...none, turiva: "si" }], [{ ...none, otra: true }], [{ nonTaxedOrExempt: false }]])("rechaza %j", (raw) => {
        expect(parseInitialData(raw).ok).toBe(false);
    });

    it("lo guardado inválido cuenta como ausente", () => {
        expect(storedInitialData({ turiva: true })).toBeNull();
        expect(storedInitialData(none)).toEqual(none);
    });

    it("sólo Monotributo consulta Mis Comprobantes", () => {
        expect(usesPortalIva("Monotributo")).toBe(false);
        expect(usesPortalIva("Responsable Inscripto")).toBe(true);
        expect(usesPortalIva("Exento")).toBe(true);
    });
});
