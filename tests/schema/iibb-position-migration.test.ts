import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const dir = "prisma/migrations/";
const pos = readFileSync(dir + "20261119120000_period_iibb_position/migration.sql", "utf8");
const base = readFileSync(dir + "20261119120100_iibb_base_includes_exempt/migration.sql", "utf8");

describe("migraciones de la DDJJ de IIBB — revisión estática", () => {
    it("PeriodIibbPosition: importes >= 0, 1:1 con el período por FK compuesta, RLS", () => {
        expect(pos).toMatch(/"previousBalance" >= 0 AND "paymentsOnAccount" >= 0 AND "otherCredits" >= 0 AND "otherDebits" >= 0/);
        expect(pos).toMatch(/UNIQUE INDEX "PeriodIibbPosition_periodId_key"/);
        expect(pos).toMatch(/FOREIGN KEY \("periodId", "organizationId"\) REFERENCES "Period"\("id", "organizationId"\) ON DELETE CASCADE/);
        expect(pos).toMatch(/ENABLE ROW LEVEL SECURITY/);
    });

    it("base de IIBB: sólo ventas de períodos ABIERTOS (los cerrados conservan lo presentado), sin borrar nada", () => {
        expect(base).toMatch(/p\."status" = 'OPEN'/);
        expect(base).toMatch(/i\."category" = 'SALES'/);
        expect(base).toMatch(/COALESCE\(i\."nonTaxedAmount", 0\) \+ COALESCE\(i\."exemptAmount", 0\)/);
        expect(base).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
    });
});
