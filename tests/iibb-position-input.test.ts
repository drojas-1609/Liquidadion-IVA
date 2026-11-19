import { describe, expect, it } from "vitest";
import { buildIibbPositionInput, iibbPositionChangedFields } from "@/lib/iibb-position-input";

describe("PUT iibb-position: entrada", () => {
    it("acepta los renglones de la DDJJ y la DDJJ presentada; vacíos = 0 / null", () => {
        const r = buildIibbPositionInput({ previousBalance: "754164.22", paymentsOnAccount: "", filedVerifier: " 983689 ", filedDate: "2026-11-18", filedBalanceDgr: "55696.60" });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.data.previousBalance.toFixed(2)).toBe("754164.22");
        expect(r.data.paymentsOnAccount.toFixed(2)).toBe("0.00");
        expect(r.data.filedVerifier).toBe("983689");
        expect(r.data.filedDate?.toISOString().slice(0, 10)).toBe("2026-11-18");
        expect(r.data.filedTaxAmount).toBeNull();
    });

    it("rechaza negativos, campos desconocidos y fechas inválidas, con el campo", () => {
        expect(buildIibbPositionInput({ previousBalance: "-1" })).toMatchObject({ ok: false, field: "previousBalance" });
        expect(buildIibbPositionInput({ foo: 1 })).toMatchObject({ ok: false, field: "foo" });
        expect(buildIibbPositionInput({ filedDate: "2026-02-30" })).toMatchObject({ ok: false, field: "filedDate" });
    });

    it("sin cambios respecto de lo guardado: no hay campos modificados", () => {
        const a = buildIibbPositionInput({ previousBalance: "10" });
        if (!a.ok) throw new Error();
        expect(iibbPositionChangedFields(a.data, a.data)).toEqual([]);
        const empty = buildIibbPositionInput({});
        if (!empty.ok) throw new Error();
        expect(iibbPositionChangedFields(null, empty.data)).toEqual([]);
        expect(iibbPositionChangedFields(null, a.data)).toEqual(["previousBalance"]);
    });
});
