import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";

const NEW_MIGRATION = "20260908021123_org_auth_base";
const PRIOR_MIGRATIONS = ["0_init", "20260907213357_float_to_decimal"];

const sql = readFileSync(migrationsDir + NEW_MIGRATION + "/migration.sql", "utf8");

describe("migración org_auth_base — revisión estática (Tarea 3A, NO aplicada)", () => {
  it("la migración de 3A y las previas siguen presentes (pueden convivir con migraciones posteriores)", () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    // 3A + previas deben existir. Tarea 3B (y siguientes) apilan carpetas
    // nuevas DESPUÉS de esta sin modificar ninguna de las anteriores.
    for (const m of [...PRIOR_MIGRATIONS, NEW_MIGRATION]) {
      expect(dirs, m).toContain(m);
    }
    // ninguna carpeta previa a 3A quedó eliminada.
    expect(dirs.filter((d) => d <= NEW_MIGRATION).sort()).toEqual(
      [...PRIOR_MIGRATIONS, NEW_MIGRATION].sort(),
    );
  });

  it("no modifica las migraciones previas (hash de contenido estable)", () => {
    // Snapshot del tamaño+primeras líneas: si alguien edita una migración
    // previa, este test lo delata sin necesitar la BD.
    for (const m of PRIOR_MIGRATIONS) {
      const prev = readFileSync(migrationsDir + m + "/migration.sql", "utf8");
      expect(prev.length).toBeGreaterThan(0);
      // 0_init crea las tablas base; float_to_decimal altera tipos a Decimal.
      if (m === "0_init") expect(prev).toMatch(/CREATE TABLE "Client"/);
      if (m === "20260907213357_float_to_decimal")
        expect(prev).toMatch(/DECIMAL\(18, ?2\)/i);
      // Ninguna migración previa debe contener artefactos de 3A.
      expect(prev).not.toMatch(/CREATE TABLE "Profile"/);
      expect(prev).not.toMatch(/CREATE TYPE "Role"/);
    }
  });

  it("crea enum Role y las 4 tablas nuevas", () => {
    expect(sql).toMatch(/CREATE TYPE "Role" AS ENUM \('OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'\)/);
    for (const t of ["Profile", "Organization", "Membership", "OrgSetting"]) {
      expect(sql, t).toMatch(new RegExp(`CREATE TABLE "${t}"`));
    }
  });

  it("intercambia el índice único de cuit: DROP global -> CREATE compuesto", () => {
    expect(sql).toMatch(/DROP INDEX "Client_cuit_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "Client_organizationId_cuit_key" ON "Client"\("organizationId", "cuit"\)/);
  });

  it("agrega organizationId NOT NULL y autoría a Client", () => {
    expect(sql).toMatch(/ALTER TABLE "Client" ADD COLUMN\s+"createdById" UUID/);
    expect(sql).toMatch(/ADD COLUMN\s+"organizationId" TEXT NOT NULL/);
    expect(sql).toMatch(/ADD COLUMN\s+"updatedById" UUID/);
  });

  it("agrega autoría + timestamps a Period / Invoice / TaxRecord", () => {
    for (const t of ["Period", "Invoice", "TaxRecord"]) {
      const re = new RegExp(
        `ALTER TABLE "${t}" ADD COLUMN[\\s\\S]*?"createdAt" TIMESTAMP\\(3\\)[\\s\\S]*?"createdById" UUID[\\s\\S]*?"updatedAt" TIMESTAMP\\(3\\)[\\s\\S]*?"updatedById" UUID`,
      );
      expect(sql, t).toMatch(re);
    }
  });

  it("FKs de autoría con ON DELETE SET NULL; Client->Organization con RESTRICT; Membership/OrgSetting con CASCADE", () => {
    expect(sql).toMatch(/"Client_organizationId_fkey"[\s\S]*?ON DELETE RESTRICT/);
    expect(sql).toMatch(/"Membership_profileId_fkey"[\s\S]*?ON DELETE CASCADE/);
    expect(sql).toMatch(/"Membership_organizationId_fkey"[\s\S]*?ON DELETE CASCADE/);
    expect(sql).toMatch(/"OrgSetting_organizationId_fkey"[\s\S]*?ON DELETE CASCADE/);
    for (const fk of [
      "Client_createdById_fkey",
      "Client_updatedById_fkey",
      "Period_createdById_fkey",
      "Period_updatedById_fkey",
      "Invoice_createdById_fkey",
      "Invoice_updatedById_fkey",
      "TaxRecord_createdById_fkey",
      "TaxRecord_updatedById_fkey",
    ]) {
      expect(sql, fk).toMatch(new RegExp(`"${fk}"[\\s\\S]*?ON DELETE SET NULL`));
    }
  });

  it("NO referencia el esquema auth ni crea triggers ni FK cross-schema", () => {
    expect(sql).not.toMatch(/auth\./);
    expect(sql).not.toMatch(/CREATE TRIGGER/i);
    expect(sql).not.toMatch(/REFERENCES\s+"?auth"?\./i);
    expect(sql).not.toMatch(/CREATE\s+(OR REPLACE\s+)?FUNCTION/i);
  });

  it("NO contiene DML (solo DDL): sin INSERT / UPDATE / DELETE de filas", () => {
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"[A-Za-z]/);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
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
