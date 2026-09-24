import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";

const MIGRATION = "20260908204819_org_scope_and_audit";
const PRIOR = ["0_init", "20260907213357_float_to_decimal", "20260908021123_org_auth_base"];

const sql = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");

describe("migración org_scope_and_audit — revisión estática (Tarea 3B, NO aplicada)", () => {
  it("es UNA sola carpeta nueva, apilada después de las 3 previas", () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...PRIOR, MIGRATION].sort());
    // el timestamp es posterior al de org_auth_base
    expect(MIGRATION > "20260908021123_org_auth_base").toBe(true);
  });

  it("NO modifica ninguna migración previa", () => {
    for (const m of PRIOR) {
      const prev = readFileSync(migrationsDir + m + "/migration.sql", "utf8");
      expect(prev).not.toMatch(/CREATE TABLE "AuditLog"/);
      expect(prev).not.toMatch(/organizationId.*REFERENCES "Period"/);
    }
    // firmas conocidas de cada previa intactas
    expect(readFileSync(migrationsDir + "0_init/migration.sql", "utf8")).toMatch(/CREATE TABLE "Client"/);
    expect(readFileSync(migrationsDir + "20260907213357_float_to_decimal/migration.sql", "utf8")).toMatch(
      /DECIMAL\(18, ?2\)/i,
    );
    expect(readFileSync(migrationsDir + "20260908021123_org_auth_base/migration.sql", "utf8")).toMatch(
      /CREATE TYPE "Role"/,
    );
  });

  it("agrega organizationId como NULLABLE, hace BACKFILL y recién después SET NOT NULL", () => {
    for (const t of ["Period", "Invoice", "TaxRecord"]) {
      // ADD COLUMN sin NOT NULL inline
      expect(sql, t).toMatch(new RegExp(`ALTER TABLE "${t}" ADD COLUMN "organizationId" TEXT;`));
      expect(sql, t).not.toMatch(
        new RegExp(`ALTER TABLE "${t}" ADD COLUMN\\s+"organizationId" TEXT NOT NULL`),
      );
      // SET NOT NULL explícito posterior
      expect(sql, t).toMatch(
        new RegExp(`ALTER TABLE "${t}" ALTER COLUMN "organizationId" SET NOT NULL;`),
      );
    }
    // backfill desde el padre
    expect(sql).toMatch(/UPDATE "Period" AS p\s+SET "organizationId" = c\."organizationId"\s+FROM "Client" AS c\s+WHERE c\."id" = p\."clientId"/);
    expect(sql).toMatch(/UPDATE "Invoice" AS i\s+SET "organizationId" = pe\."organizationId"\s+FROM "Period" AS pe\s+WHERE pe\."id" = i\."periodId"/);
    expect(sql).toMatch(/UPDATE "TaxRecord" AS t\s+SET "organizationId" = pe\."organizationId"\s+FROM "Period" AS pe\s+WHERE pe\."id" = t\."periodId"/);

    // orden: ADD COLUMN Period  <  UPDATE Period  <  SET NOT NULL Period
    const iAdd = sql.indexOf('ALTER TABLE "Period" ADD COLUMN "organizationId" TEXT;');
    const iUpd = sql.indexOf('UPDATE "Period" AS p');
    const iNn = sql.indexOf('ALTER TABLE "Period" ALTER COLUMN "organizationId" SET NOT NULL;');
    expect(iAdd).toBeGreaterThanOrEqual(0);
    expect(iAdd).toBeLessThan(iUpd);
    expect(iUpd).toBeLessThan(iNn);
    // Invoice/TaxRecord se backfillean DESPUÉS de que Period tenga su valor
    expect(sql.indexOf('UPDATE "Invoice" AS i')).toBeGreaterThan(iUpd);
    expect(sql.indexOf('UPDATE "TaxRecord" AS t')).toBeGreaterThan(iUpd);
  });

  it("crea los índices EXPLÍCITOS de las FK compuestas", () => {
    expect(sql).toMatch(
      /CREATE INDEX "Period_clientId_organizationId_idx" ON "Period"\("clientId", "organizationId"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "Invoice_periodId_organizationId_idx" ON "Invoice"\("periodId", "organizationId"\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX "TaxRecord_periodId_organizationId_idx" ON "TaxRecord"\("periodId", "organizationId"\)/,
    );
  });

  it("crea los índices por organizationId y los UNIQUE (id, organizationId)", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Client_id_organizationId_key" ON "Client"\("id", "organizationId"\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Period_id_organizationId_key" ON "Period"\("id", "organizationId"\)/);
    for (const t of ["Period", "Invoice", "TaxRecord"]) {
      expect(sql, t).toMatch(new RegExp(`CREATE INDEX "${t}_organizationId_idx" ON "${t}"\\("organizationId"\\)`));
    }
  });

  it("NO retira los índices simples previos (se hará en una migración posterior tras confirmar en dev)", () => {
    expect(sql).not.toMatch(/DROP INDEX "Period_clientId_idx"/);
    expect(sql).not.toMatch(/DROP INDEX "Invoice_periodId_idx"/);
    expect(sql).not.toMatch(/DROP INDEX "TaxRecord_periodId_idx"/);
  });

  it("reemplaza las FK simples por FK COMPUESTAS que impiden relaciones cross-org", () => {
    expect(sql).toMatch(/ALTER TABLE "Period" DROP CONSTRAINT "Period_clientId_fkey"/);
    expect(sql).toMatch(/ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_periodId_fkey"/);
    expect(sql).toMatch(/ALTER TABLE "TaxRecord" DROP CONSTRAINT "TaxRecord_periodId_fkey"/);

    expect(sql).toMatch(
      /ADD CONSTRAINT "Period_clientId_organizationId_fkey" FOREIGN KEY \("clientId", "organizationId"\) REFERENCES "Client"\("id", "organizationId"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "Invoice_periodId_organizationId_fkey" FOREIGN KEY \("periodId", "organizationId"\) REFERENCES "Period"\("id", "organizationId"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "TaxRecord_periodId_organizationId_fkey" FOREIGN KEY \("periodId", "organizationId"\) REFERENCES "Period"\("id", "organizationId"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
    );
  });

  it("crea AuditLog con FK organization ON DELETE RESTRICT y FK actor ON DELETE SET NULL", () => {
    expect(sql).toMatch(/CREATE TABLE "AuditLog"/);
    expect(sql).toMatch(/"metadata" JSONB NOT NULL/);
    expect(sql).toMatch(/CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"\("organizationId", "createdAt"\)/);
    expect(sql).toMatch(/CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"\("targetType", "targetId"\)/);
    expect(sql).toMatch(
      /ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY \("organizationId"\) REFERENCES "Organization"\("id"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "AuditLog_actorProfileId_fkey" FOREIGN KEY \("actorProfileId"\) REFERENCES "Profile"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/,
    );
    // NO cascada sobre organization
    expect(sql).not.toMatch(/"AuditLog_organizationId_fkey"[\s\S]*?ON DELETE CASCADE/);
  });

  it("NO referencia el esquema auth, NO crea triggers ni funciones", () => {
    expect(sql).not.toMatch(/auth\./);
    expect(sql).not.toMatch(/CREATE TRIGGER/i);
    expect(sql).not.toMatch(/REFERENCES\s+"?auth"?\./i);
    expect(sql).not.toMatch(/CREATE\s+(OR REPLACE\s+)?FUNCTION/i);
  });

  it("el ÚNICO DML es el backfill de organizationId (sin INSERT ni DELETE de filas)", () => {
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    const updates = sql.match(/\bUPDATE\s+"[A-Za-z]+"/g) ?? [];
    expect(updates.sort()).toEqual(['UPDATE "Invoice"', 'UPDATE "Period"', 'UPDATE "TaxRecord"']);
  });

  it("NO toca los tipos Decimal de Tarea 2", () => {
    expect(sql).not.toMatch(/ALTER COLUMN[\s\S]*?(DECIMAL|NUMERIC|DOUBLE PRECISION)/i);
    expect(sql).not.toMatch(/"netAmount"|"vatRate"|"vatAmount"|"totalAmount"|"defaultIibbRate"/);
  });

  it("migration_lock.toml sigue en postgresql", () => {
    const lock = readFileSync(migrationsDir + "migration_lock.toml", "utf8");
    expect(lock).toMatch(/provider\s*=\s*"postgresql"/);
  });
});
