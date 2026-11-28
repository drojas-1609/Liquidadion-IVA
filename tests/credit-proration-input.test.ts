import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildCreditProrationInput } from "@/lib/credit-proration-input";

describe("prorrateo del crédito fiscal: validación", () => {
    it("global con coeficiente en formato argentino; normaliza ceros", () => {
        expect(buildCreditProrationInput({ creditProrationMode: "GLOBAL", globalCoefficient: "0,51320", globalCoefficientStatus: "PROVISIONAL" }))
            .toEqual({ ok: true, data: { creditProrationMode: "GLOBAL", globalCoefficient: "0.5132", globalCoefficientStatus: "PROVISIONAL" } });
        expect(buildCreditProrationInput({ creditProrationMode: "GLOBAL", globalCoefficient: "1", globalCoefficientStatus: "DEFINITIVE" })).toMatchObject({ ok: true, data: { globalCoefficient: "1" } });
        expect(buildCreditProrationInput({ creditProrationMode: "GLOBAL" })).toMatchObject({ ok: true, data: { globalCoefficient: null, globalCoefficientStatus: null } });
    });
    it("rechaza: fuera de rango, más de 10 decimales, sin estado, coeficiente sin prorrateo global, modalidad desconocida", () => {
        expect(buildCreditProrationInput({ creditProrationMode: "GLOBAL", globalCoefficient: "1,2", globalCoefficientStatus: "PROVISIONAL" })).toMatchObject({ ok: false, field: "globalCoefficient" });
        expect(buildCreditProrationInput({ creditProrationMode: "GLOBAL", globalCoefficient: "0.12345678901", globalCoefficientStatus: "PROVISIONAL" })).toMatchObject({ ok: false, field: "globalCoefficient" });
        expect(buildCreditProrationInput({ creditProrationMode: "GLOBAL", globalCoefficient: "0.5" })).toMatchObject({ ok: false, field: "globalCoefficientStatus" });
        expect(buildCreditProrationInput({ creditProrationMode: "NONE", globalCoefficient: "0.5", globalCoefficientStatus: "PROVISIONAL" })).toMatchObject({ ok: false, field: "globalCoefficient" });
        expect(buildCreditProrationInput({ creditProrationMode: "OTRO" })).toMatchObject({ ok: false, field: "creditProrationMode" });
        expect(buildCreditProrationInput([])).toMatchObject({ ok: false, field: "body" });
    });
    it("la ruta escribe bajo el bloqueo del período, audita y bloquea quitar el prorrateo global con compras prorrateadas", () => {
        const src = readFileSync("app/api/periods/[id]/credit-proration/route.ts", "utf8");
        expect(src).toMatch(/lockPeriodForWrite\(tx, id, organizationId\)/);
        expect(src).toMatch(/"period\.vat_settings_change"/);
        expect(src).toMatch(/PRORATION_HAS_GLOBAL_LINES_MESSAGE/);
        expect(src).toMatch(/\{ maxWait: 5000, timeout: 10000 \}/);
        expect(src).not.toMatch(/^export const (?!PUT)/m);
    });
});
