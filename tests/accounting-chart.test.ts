import { describe, expect, it } from "vitest";
import { ACCOUNT_ROLES, CHART_MODELS, chartModelAccounts, isAccountCode, isImputableCode, suggestedChartModel } from "@/lib/accounting/chart-models";
import { idcbComputablePercent, validateAccountingProfile } from "@/lib/accounting/profile";
import { buildAccountCreate, buildAccountUpdate, parentCode } from "@/lib/accounting/chart-input";

describe("planes de cuentas modelo", () => {
    for (const model of CHART_MODELS) {
        it(`${model}: códigos válidos y únicos, cada cuenta con su rubro, cada uso automático una sola vez`, () => {
            const accounts = chartModelAccounts(model);
            const codes = accounts.map((a) => a.code);
            expect(new Set(codes).size).toBe(codes.length);
            for (const a of accounts) {
                expect(isAccountCode(a.code), a.code).toBe(true);
                const parent = parentCode(a.code);
                if (parent) expect(codes, `${a.code} sin padre`).toContain(parent);
                if (a.role) expect(isImputableCode(a.code), a.code).toBe(true);
            }
            const roles = accounts.flatMap((a) => (a.role ? [a.role] : []));
            expect(new Set(roles).size).toBe(roles.length);
            // Todos los usos automáticos tienen una cuenta en el modelo.
            expect([...roles].sort()).toEqual([...ACCOUNT_ROLES].sort());
        });
    }

    it("billeteras virtuales, cuentas comitentes y FAL presentes", () => {
        const names = chartModelAccounts("COMMERCIAL").map((a) => a.name).join(" | ");
        expect(names).toMatch(/Billetera virtual/);
        expect(names).toMatch(/Cuenta comitente/);
        expect(names).toMatch(/Fondo de Asistencia Laboral \(FAL\) — uso restringido/);
    });

    it("modelo sugerido por la actividad principal (CLAE): comercio 45–47 → comercializadora", () => {
        expect(suggestedChartModel("471190")).toBe("COMMERCIAL");
        expect(suggestedChartModel("492110")).toBe("SERVICES");
        expect(suggestedChartModel(null)).toBeNull();
    });
});

describe("impuesto a los débitos y créditos computable en Ganancias", () => {
    const p = (mipymeCategory: string | null, extra: Partial<{ mipymeManufacturing: boolean; mipymeValidUntil: string | null }> = {}) =>
        ({ mipymeCategory: mipymeCategory as never, mipymeManufacturing: false, mipymeValidUntil: null, ...extra });
    it("micro y pequeña con certificado vigente: 100 %", () => {
        expect(idcbComputablePercent(p("MICRO"), "2026-10-31").percent).toBe(100);
        expect(idcbComputablePercent(p("PEQUENA", { mipymeValidUntil: "2027-04-30" }), "2026-10-31").percent).toBe(100);
    });
    it("certificado vencido o sin certificado: 33 %; alícuota reducida: 20 %", () => {
        expect(idcbComputablePercent(p("PEQUENA", { mipymeValidUntil: "2026-09-30" }), "2026-10-31").percent).toBe(33);
        expect(idcbComputablePercent(p(null), "2026-10-31").percent).toBe(33);
        expect(idcbComputablePercent(p(null), "2026-10-31", true).percent).toBe(20);
    });
    it("mediana tramo 1: 60 % sólo si es industria manufacturera; tramo 2: 33 %", () => {
        expect(idcbComputablePercent(p("MEDIANA_T1", { mipymeManufacturing: true }), "2026-10-31").percent).toBe(60);
        expect(idcbComputablePercent(p("MEDIANA_T1"), "2026-10-31").percent).toBe(33);
        expect(idcbComputablePercent(p("MEDIANA_T2"), "2026-10-31").percent).toBe(33);
    });
});

describe("validaciones", () => {
    it("perfil contable", () => {
        expect(validateAccountingProfile({ mipymeCategory: "PEQUENA", mipymeValidUntil: "2027-04-30", chartModel: "COMMERCIAL" })).toMatchObject({ ok: true });
        expect(validateAccountingProfile({ mipymeValidUntil: "2027-04-30" })).toMatchObject({ ok: false, field: "accounting.mipymeValidUntil" });
        expect(validateAccountingProfile({ mipymeCategory: "GRANDE" })).toMatchObject({ ok: false });
    });
    it("alta de cuenta: código y uso automático sólo en imputables", () => {
        expect(buildAccountCreate({ code: "1.01.05.02", name: "Billetera Ualá", role: null })).toMatchObject({ ok: true, value: { imputable: true } });
        expect(buildAccountCreate({ code: "1.01", name: "Caja", role: "CASH" })).toMatchObject({ ok: false, field: "role" });
        expect(buildAccountCreate({ code: "6.01", name: "X" })).toMatchObject({ ok: false, field: "code" });
        expect(buildAccountUpdate({})).toMatchObject({ ok: false });
    });
});
