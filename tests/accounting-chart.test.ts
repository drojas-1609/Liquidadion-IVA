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

describe("subcuentas y árbol del plan", () => {
    it("códigos de subcuenta: correlativos bajo la madre, sin alta directa", async () => {
        const { nextSubaccountCode, buildSubaccountCreate, parentCode } = await import("@/lib/accounting/chart-input");
        expect(nextSubaccountCode("1.01.02.01", [])).toBe("1.01.02.01.01");
        expect(nextSubaccountCode("1.01.02.01", ["1.01.02.01.01", "1.01.02.01.03", "1.01.02.02.07"])).toBe("1.01.02.01.04");
        expect(nextSubaccountCode("1.01.02.01", ["1.01.02.01.99"])).toBeNull();
        expect(nextSubaccountCode("1.01", [])).toBeNull();
        expect(parentCode("1.01.02.01.02")).toBe("1.01.02.01");
        expect(buildAccountCreate({ code: "1.01.02.01.01", name: "Banco Nación" })).toMatchObject({ ok: false, field: "code" });
        expect(buildSubaccountCreate({ name: "  Banco  Galicia c/c " })).toEqual({ ok: true, value: { name: "Banco Galicia c/c", moveLines: false } });
        expect(buildSubaccountCreate({ name: "X", moveLines: "si" })).toMatchObject({ ok: false, field: "moveLines" });
        expect(buildSubaccountCreate({ name: "X", code: "1" })).toMatchObject({ ok: false, field: "code" });
    });

    it("arma el árbol, cuenta y filtra conservando ancestros", async () => {
        const { buildChartTree } = await import("@/lib/accounting/chart-tree");
        const acc = (code: string, name: string, active = true, role: string | null = null) => ({ id: code, code, name, active, role });
        const rows = [
            acc("1", "ACTIVO"), acc("1.01", "Caja y Bancos"), acc("1.01.01.01", "Caja", true, "CASH"),
            acc("1.01.02.01", "Banco cuenta corriente"), acc("1.01.02.01.01", "Banco Galicia c/c", true, "BANK"), acc("1.01.02.01.02", "Banco Nación c/c"),
            acc("1.01.01.02", "Fondo fijo", false), acc("2", "PASIVO"),
        ];
        const all = buildChartTree(rows, { includeInactive: true });
        expect(all.map((n) => n.account.code)).toEqual(["1", "2"]);
        expect(all[0].count).toBe(5);
        const bank = all[0].children[0].children.find((c) => c.account.code === "1.01.02.01")!;
        expect(bank.children.map((c) => c.level)).toEqual(["subaccount", "subaccount"]);
        expect(buildChartTree(rows)[0].count).toBe(4); // sin inactivas
        const q = buildChartTree(rows, { query: "galicia", includeInactive: true });
        expect(q).toHaveLength(1);
        expect(q[0].children[0].children.map((c) => c.account.code)).toEqual(["1.01.02.01"]);
        expect(q[0].children[0].children[0].children.map((c) => c.account.code)).toEqual(["1.01.02.01.01"]);
        // Buscar por uso automático.
        expect(buildChartTree(rows, { query: "banco (cuenta", includeInactive: true })[0].children[0].children[0].children[0].account.code).toBe("1.01.02.01.01");
    });
});
