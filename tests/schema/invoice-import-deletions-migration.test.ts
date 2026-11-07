import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de 20261108120000_invoice_import_deletions (ADITIVA: una
 * tabla nueva vacía). La prueba real contra PostgreSQL está en
 * tests/integration/imported-invoice-edit-pg.test.ts.
 */
const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20261108120000_invoice_import_deletions";
const PREVIOUS = "20261107120000_vat_export_close_versions";
/** Checksum aplicado en DEV (esyfpakajthdifhnhcew) el 06/11/2026. */
const PREVIOUS_SHA256 = "e2f768ad2b81ba05e856fed098e48ae5201dee187875d36188875b8692fc5f73";

const sql = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

describe(`migración ${MIGRATION} — revisión estática`, () => {
  it("es la última y sigue a la de exportación y cierre sin cambiarla", () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(dirs.at(-1)).toBe(MIGRATION);
    expect(dirs.at(-2)).toBe(PREVIOUS);
    expect(createHash("sha256").update(readFileSync(migrationsDir + PREVIOUS + "/migration.sql")).digest("hex")).toBe(PREVIOUS_SHA256);
  });

  it("transaccional, con timeouts, sólo una tabla nueva y sin tocar filas existentes", () => {
    expect(code.startsWith("BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';")).toBe(true);
    expect(code.endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME|GRANT)\b|\bDELETE FROM\b|\bUPDATE "|\bINSERT INTO\b|\bALTER TABLE "Invoice"/i);
    expect(code.match(/CREATE TABLE/g)).toHaveLength(1);
    expect(code).toContain(`CREATE TABLE "InvoiceImportDeletion"`);
  });

  it("sin datos de la contraparte: huella SHA-256 de la clave, tipo, punto de venta y número", () => {
    expect(code).toContain(`"keyHash" CHAR(64) NOT NULL`);
    expect(code).toContain(`"keyHash" ~ '^[0-9a-f]{64}$'`);
    expect(code).not.toMatch(/counterparty|Doc(Type|Number)|entityCuit|"name"/i);
    expect(code).toContain(`CREATE UNIQUE INDEX "InvoiceImportDeletion_organizationId_clientId_keyHash_key" ON "InvoiceImportDeletion"("organizationId", "clientId", "keyHash");`);
    expect(code).toContain(`"category" IN ('SALES', 'PURCHASES')`);
  });

  it("FK compuesta al cliente (CASCADE) y al perfil (SET NULL); RLS sin políticas y sin privilegios para la API", () => {
    expect(code).toContain(`FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE`);
    expect(code).toContain(`FOREIGN KEY ("deletedById") REFERENCES "Profile"("id") ON DELETE SET NULL`);
    expect(code).toContain(`ALTER TABLE "InvoiceImportDeletion" ENABLE ROW LEVEL SECURITY;`);
    expect(code).toContain(`REVOKE ALL ON TABLE "InvoiceImportDeletion" FROM PUBLIC;`);
    expect(code).toContain(`rolname IN ('anon', 'authenticated', 'service_role')`);
    expect(code).not.toMatch(/CREATE POLICY/i);
  });
});
