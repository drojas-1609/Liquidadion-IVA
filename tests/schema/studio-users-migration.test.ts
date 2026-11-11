import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de la migración EXPAND de Usuarios del estudio (NO
 * aplicada a DEV ni PROD). La prueba real contra PostgreSQL está en
 * tests/integration/users-permissions-pg.test.ts (scripts/pg-local-regression.sh).
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20261104120000_studio_users_permissions";
const PREVIOUS = "20261102120000_arca_production_controls";
const PREVIOUS_SHA256 = "1546bb960aee01bb4ad26871a3a22d4ba7f844b0215f64b293e5ef7f8ea2ca36";

const sql = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
const schema = readFileSync(repo + "prisma/schema.prisma", "utf8");

describe(`migración ${MIGRATION} — revisión estática`, () => {
  it("sigue a la de ARCA sin cambiarla", () => {
    const allDirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
        expect(allDirs.slice(-3)).toEqual(["20261110190000_supplier_purchase_account", "20261111100000_arca_sync", "20261111120000_arca_client_credential"]);
        const dirs = allDirs.slice(0, -3);
    expect(dirs.at(-1)).toBe("20261108120000_invoice_import_deletions");
    expect(dirs.at(-2)).toBe("20261107120000_vat_export_close_versions");
    expect(dirs.at(-3)).toBe("20261106120000_vat_credit_adjustments");
    expect(dirs.at(-4)).toBe("20261104230000_add_operator_role");
    expect(dirs.at(-5)).toBe(MIGRATION);
    expect(dirs.at(-6)).toBe(PREVIOUS);
    expect(createHash("sha256").update(readFileSync(migrationsDir + PREVIOUS + "/migration.sql")).digest("hex")).toBe(PREVIOUS_SHA256);
  });

  it("transaccional, con timeouts y sin operaciones destructivas sobre datos existentes", () => {
    expect(code.startsWith("BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';")).toBe(true);
    expect(code.endsWith("COMMIT;")).toBe(true);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME|GRANT)\b|\bDELETE FROM\b|\bUPDATE "|\bINSERT INTO\b/i);
    expect(code).not.toMatch(/\bSET NOT NULL\b|\bALTER COLUMN\b/i);
  });

  it("compatibilidad: las membresías existentes conservan su acceso (ACTIVE, ALL, todos los módulos)", () => {
    expect(code).toContain(`ADD COLUMN "clientScope" "ClientScope" NOT NULL DEFAULT 'ALL'`);
    expect(code).toContain(`ADD COLUMN "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE'`);
    expect(code).toContain(`ADD COLUMN "modules" "AppModule"[] DEFAULT ARRAY['CLIENTS', 'IVA', 'ARCA_PADRON']::"AppModule"[]`);
    expect(code).toContain(`ADD COLUMN "disabledAt" TIMESTAMP(3)`);
    expect(code).toContain(`ADD COLUMN "seatLimit" INTEGER NOT NULL DEFAULT 5`);
    expect(schema).toMatch(/modules\s+AppModule\[\]\s+@default\(\[CLIENTS, IVA, ARCA_PADRON\]\)/);
  });

  it("integridad: FKs compuestas, índice parcial de pendientes, CHECKs y trigger del propietario", () => {
    expect(code).toContain(`FOREIGN KEY ("membershipId", "organizationId") REFERENCES "Membership"("id", "organizationId") ON DELETE CASCADE`);
    expect(code).toContain(`FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE`);
    expect(code).toContain(`CREATE UNIQUE INDEX "OrganizationInvitation_pending_email_key" ON "OrganizationInvitation"("organizationId", "email") WHERE "status" = 'PENDING'`);
    expect(code).toContain(`CHECK ("seatLimit" >= 1)`);
    expect(code).toContain(`CHECK ("role" <> 'OWNER')`);
    expect(code).toContain(`CHECK ("email" = lower(btrim("email")) AND length("email") > 0)`);
    expect(code).toContain(`BEFORE UPDATE OF "role", "status", "organizationId" OR DELETE ON "Membership"`);
    expect(code).not.toMatch(/\bauth\./);
  });

  it("tablas nuevas con RLS sin políticas y sin privilegios para PUBLIC ni roles de la API", () => {
    expect(code).toContain(`FOREACH t IN ARRAY ARRAY['MembershipClient', 'OrganizationInvitation']`);
    expect(code).toContain("ENABLE ROW LEVEL SECURITY");
    expect(code).toContain("REVOKE ALL ON TABLE %I FROM PUBLIC");
    expect(code).not.toMatch(/CREATE POLICY/i);
  });

  it("cierre de la Data API: RLS + REVOKE en todo public y en los privilegios por defecto, sin FORCE ni GRANT", () => {
    const block = code.slice(code.indexOf("DO $data_api$"), code.indexOf("$data_api$;") + 11);
    expect(block.length).toBeGreaterThan(100);
    expect(block).toContain("WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')");
    expect(block).toContain("ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY");
    expect(block).toContain("REVOKE ALL ON %s public.%I FROM PUBLIC");
    expect(block).toContain("REVOKE ALL ON FUNCTION %s FROM PUBLIC");
    expect(block).toContain("rolname IN ('anon', 'authenticated', 'service_role')");
    for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
      expect(block).toContain(`ALTER DEFAULT PRIVILEGES REVOKE ALL ON ${kind} FROM %I`);
      expect(block).toContain(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ${kind} FROM %I`);
    }
    expect(block).toContain("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;");
    expect(code).not.toMatch(/FORCE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY/i);
    // Va dentro de la misma transacción (antes del COMMIT final).
    expect(code.indexOf("$data_api$;")).toBeLessThan(code.lastIndexOf("COMMIT;"));
  });
});
