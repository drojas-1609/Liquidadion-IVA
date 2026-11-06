import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de 20261107120000_vat_export_close_versions (ADITIVA). La
 * prueba real contra PostgreSQL está en tests/integration/vat-export-close-pg.test.ts.
 */
const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20261107120000_vat_export_close_versions";
const PREVIOUS = "20261106120000_vat_credit_adjustments";
const PREVIOUS_SHA256 = "5093b64d9a968a736455a3e03c79ebae1c3e075c3da00c9ebd685e5ade156151";

const sql = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe(`migración ${MIGRATION} — revisión estática`, () => {
  it("es la última y sigue a la de ajustes al crédito fiscal sin cambiarla", () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(dirs.at(-1)).toBe(MIGRATION);
    expect(dirs.at(-2)).toBe(PREVIOUS);
    expect(createHash("sha256").update(readFileSync(migrationsDir + PREVIOUS + "/migration.sql")).digest("hex")).toBe(PREVIOUS_SHA256);
  });

  it("transaccional, con timeouts y sin operaciones destructivas ni cambios de filas", () => {
    expect(code.startsWith("BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';")).toBe(true);
    expect(code.endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME|GRANT)\b|\bDELETE FROM\b|\bUPDATE "|\bINSERT INTO\b/i);
    expect(code).not.toMatch(/\bSET NOT NULL\b|\bALTER COLUMN\b/i);
  });

  it("clasificaciones de Invoice: nullable (sin inferir) salvo dación en pago false, y CHECK por categoría", () => {
    expect(code).toContain(`ALTER TABLE "Invoice" ADD COLUMN "activityCode" VARCHAR(6), ADD COLUMN "buyerType" "BuyerType", ADD COLUMN "dationInPayment" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "purchaseCreditConcept" "PurchaseCreditConcept", ADD COLUMN "saleOperationType" "SaleOperationType";`);
    expect(code).toContain(`CREATE TYPE "SaleOperationType" AS ENUM ('GOODS_SERVICES', 'CAPITAL_GOODS');`);
    expect(code).toContain(`CREATE TYPE "BuyerType" AS ENUM ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO');`);
    expect(code).toContain(`CREATE TYPE "PurchaseCreditConcept" AS ENUM ('GOODS', 'LEASES', 'SERVICES', 'CAPITAL_GOODS');`);
    expect(code).toContain(`"Invoice_export_classification_check"`);
    expect(code).toContain(`VALIDATE CONSTRAINT "Invoice_export_classification_check"`);
    expect(code).toContain(`"activityCode" ~ '^[0-9]{6}$'`);
  });

  it("libre disponibilidad anterior con default (sin reescritura) y CHECK >= 0", () => {
    expect(code).toContain(`ALTER TABLE "PeriodVatSettings" ADD COLUMN "previousFreeBalance" DECIMAL(18,2) NOT NULL DEFAULT 0, ADD COLUMN "previousFreeBalanceReference" VARCHAR(120);`);
    expect(code).toContain(`CHECK ("previousFreeBalance" >= 0)`);
  });

  it("detalle del F.2051 en TaxRecord: nullable, CHECK de formato y naturaleza, únicos parciales y FK RESTRICT al comprobante", () => {
    expect(code).toContain(`CREATE TYPE "TaxRecordNature" AS ENUM ('RETENTION', 'PERCEPTION', 'CUSTOMS_PERCEPTION');`);
    expect(code).toContain(`"taxCode" IN (767, 216)`);
    expect(code).toContain(`("invoiceId" IS NULL OR "nature" = 'PERCEPTION')`);
    expect(code).toContain(`CREATE UNIQUE INDEX "TaxRecord_invoice_key" ON "TaxRecord"("invoiceId") WHERE "invoiceId" IS NOT NULL;`);
    expect(code).toContain(`CREATE UNIQUE INDEX "TaxRecord_retention_certificate_key"`);
    expect(code).toContain(`CREATE UNIQUE INDEX "TaxRecord_perception_voucher_key"`);
    expect(code).toContain(`CREATE UNIQUE INDEX "TaxRecord_customs_perception_key"`);
    expect(code).toContain(`ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_invoiceId_organizationId_fkey" FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "Invoice"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;`);
  });

  it("versiones cerradas: una vigente por período, FK RESTRICT al período, CHECK de estado", () => {
    expect(code).toContain(`CREATE UNIQUE INDEX "PeriodLiquidationVersion_periodId_version_key" ON "PeriodLiquidationVersion"("periodId", "version");`);
    expect(code).toContain(`CREATE UNIQUE INDEX "PeriodLiquidationVersion_current_key" ON "PeriodLiquidationVersion"("periodId") WHERE "supersededAt" IS NULL;`);
    expect(code).toContain(`REFERENCES "Period"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE`);
    expect(code).toContain(`(("packageZip" IS NULL) = ("packageSha256" IS NULL))`);
    expect(code).toContain(`("supersededAt" IS NOT NULL OR ("supersededById" IS NULL AND "reopenReason" IS NULL))`);
  });

  it("Data API cerrada para la tabla nueva: RLS sin políticas y REVOKE a PUBLIC y a los roles de Supabase", () => {
    expect(code).toContain(`ALTER TABLE "PeriodLiquidationVersion" ENABLE ROW LEVEL SECURITY;`);
    expect(code).toContain(`REVOKE ALL ON TABLE "PeriodLiquidationVersion" FROM PUBLIC;`);
    expect(code).toMatch(/rolname IN \('anon', 'authenticated', 'service_role'\)/);
    expect(code).not.toMatch(/CREATE POLICY/i);
  });
});
