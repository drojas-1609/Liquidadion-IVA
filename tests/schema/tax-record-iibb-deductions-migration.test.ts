import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Deducciones de IIBB informadas por el fisco: columnas opcionales, restricción
// de valores y unicidad por período, jurisdicción e identidad. Aditiva.
const sql = readFileSync("prisma/migrations/20261118140000_tax_record_iibb_deductions/migration.sql", "utf8");

describe("migración: deducciones de IIBB importadas", () => {
    it("sólo agrega columnas opcionales (no cambia registros)", () => {
        for (const c of ["importSource", "importIdentity", "agentName", "baseAmount", "voucherKind", "voucherLetter", "pointOfSale", "cbu", "bankExtra"]) {
            expect(sql).toMatch(new RegExp(`ADD COLUMN "${c}"\\s+[A-Z]+(\\(\\d+(,\\d+)?\\))?[,;]`));
        }
        expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|DROP COLUMN|ALTER COLUMN/);
        for (const line of sql.split("\n").filter((l) => l.includes("ADD COLUMN"))) expect(line).not.toMatch(/NOT NULL|DEFAULT/);
    });
    it("valida tipo, letra, CBU de 22 dígitos e identidad con origen y jurisdicción", () => {
        expect(sql).toContain(`"voucherKind" IN ('F', 'R', 'C', 'D', 'X')`);
        expect(sql).toContain(`"voucherLetter" IN ('A', 'B', 'C', 'M', 'T')`);
        expect(sql).toContain(`"cbu" ~ '^[0-9]{22}$'`);
        expect(sql).toContain(`("importIdentity" IS NULL OR ("importSource" IS NOT NULL AND "jurisdictionCode" IS NOT NULL))`);
        expect(sql).toContain('VALIDATE CONSTRAINT "TaxRecord_iibb_deduction_check"');
    });
    it("una deducción se registra una sola vez por período y jurisdicción", () => {
        expect(sql).toContain(`CREATE UNIQUE INDEX "TaxRecord_iibb_import_key" ON "TaxRecord"("periodId", "jurisdictionCode", "importIdentity")`);
        expect(sql).toContain(`WHERE "importIdentity" IS NOT NULL`);
    });
});
