import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de 20261106120000_vat_credit_adjustments (ADITIVA). La
 * prueba real contra PostgreSQL está en tests/integration/vat-position-pg.test.ts.
 */
const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20261106120000_vat_credit_adjustments";
const PREVIOUS = "20261104230000_add_operator_role";
const PREVIOUS_SHA256 = "1bd8d2ce8a29934399a36871687e5946d7e776c8fb252d9dc2e4de96a438416f";

const sql = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe(`migración ${MIGRATION} — revisión estática`, () => {
  it("sigue a la del rol Operador sin cambiarla; sólo la sigue la de exportación y cierre (y ella misma no cambia: aplicada en DEV)", () => {
    const allDirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
        expect(allDirs.slice(-3)).toEqual(["20261110190000_supplier_purchase_account", "20261111100000_arca_sync", "20261111120000_arca_client_credential"]);
        const dirs = allDirs.slice(0, -3);
    expect(dirs.at(-1)).toBe("20261108120000_invoice_import_deletions");
    expect(dirs.at(-2)).toBe("20261107120000_vat_export_close_versions");
    expect(dirs.at(-3)).toBe(MIGRATION);
    expect(dirs.at(-4)).toBe(PREVIOUS);
    expect(createHash("sha256").update(readFileSync(migrationsDir + MIGRATION + "/migration.sql")).digest("hex")).toBe("5093b64d9a968a736455a3e03c79ebae1c3e075c3da00c9ebd685e5ade156151");
    expect(createHash("sha256").update(readFileSync(migrationsDir + PREVIOUS + "/migration.sql")).digest("hex")).toBe(PREVIOUS_SHA256);
  });

  it("transaccional, con timeouts y sin operaciones destructivas ni cambios de filas", () => {
    expect(code.startsWith("BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';")).toBe(true);
    expect(code.endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME|GRANT)\b|\bDELETE FROM\b|\bUPDATE "|\bINSERT INTO\b/i);
    expect(code).not.toMatch(/\bSET NOT NULL\b|\bALTER COLUMN\b/i);
  });

  it("columnas nuevas de PeriodVatSettings con default (sin reescritura) y CHECK >= 0", () => {
    expect(code).toContain(`ALTER TABLE "PeriodVatSettings" ADD COLUMN "previousTechnicalBalance" DECIMAL(18,2) NOT NULL DEFAULT 0, ADD COLUMN "previousTechnicalBalanceReference" VARCHAR(120);`);
    expect(code).toContain(`CHECK ("previousTechnicalBalance" >= 0)`);
  });

  it("tabla de ajustes: régimen cerrado, un ajuste por régimen, FK compuesta en cascada y CHECK de importes", () => {
    expect(code).toContain(`CREATE TYPE "VatCreditAdjustmentRegime" AS ENUM ('LEY_27541_ANEXO_I', 'LEY_27467_ART_91');`);
    expect(code).toContain(`CREATE UNIQUE INDEX "PeriodVatCreditAdjustment_periodId_regime_key" ON "PeriodVatCreditAdjustment"("periodId", "regime");`);
    expect(code).toContain(`FOREIGN KEY ("periodId", "organizationId") REFERENCES "Period"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE`);
    expect(code).toContain(`CHECK ("contributionsAmount" >= 0 AND "computableAmount" >= 0 AND "computableAmount" <= "contributionsAmount")`);
  });

  it("Data API cerrada para la tabla nueva: RLS sin políticas y REVOKE a PUBLIC y a los roles de Supabase", () => {
    expect(code).toContain(`ALTER TABLE "PeriodVatCreditAdjustment" ENABLE ROW LEVEL SECURITY;`);
    expect(code).toContain(`REVOKE ALL ON TABLE "PeriodVatCreditAdjustment" FROM PUBLIC;`);
    expect(code).toMatch(/rolname IN \('anon', 'authenticated', 'service_role'\)/);
    expect(code).not.toMatch(/CREATE POLICY/i);
  });
});
