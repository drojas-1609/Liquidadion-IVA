import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de la migración de controles de ARCA en producción. NO
 * aplicada en DEV ni PROD. Aditiva: columnas nullable en la tabla técnica
 * ArcaWsaaTicket y cuatro tablas técnicas nuevas con RLS y sin privilegios API.
 */
const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20261102120000_arca_production_controls";
/** Migración previa de ARCA (aplicada en DEV el 28/10/2026): no debe cambiar. */
const PREVIOUS_ARCA_SHA256 = "a5c214cc74826994411c44953983addda81e88e4076a742a33db437609ec743d";
const NEW_TABLES = ["ArcaPadronControl", "ArcaPadronOrganization", "ArcaLookupQuota", "ArcaLookupQuotaEvent"];

const sql = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");
const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join(" ").replace(/\s+/g, " ").trim();

describe(`migración ${MIGRATION} — revisión estática`, () => {
    it("sigue a la migración ARCA previa sin cambiarla; sólo la siguen migraciones posteriores conocidas", () => {
        const allDirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
        expect(allDirs.slice(-2)).toEqual(["20261110190000_supplier_purchase_account", "20261111100000_arca_sync"]);
        const dirs = allDirs.slice(0, -2);
        // Posteriores, revisadas en su propio test (tests/schema/*).
        const LATER = ["20261104120000_studio_users_permissions", "20261104230000_add_operator_role", "20261106120000_vat_credit_adjustments", "20261107120000_vat_export_close_versions", "20261108120000_invoice_import_deletions"];
        expect(dirs.slice(-1 - LATER.length)).toEqual([MIGRATION, ...LATER]);
        expect(dirs.at(-2 - LATER.length)).toBe("20261028120000_arca_wsaa_ticket_cache");
        expect(createHash("sha256").update(readFileSync(migrationsDir + "20261028120000_arca_wsaa_ticket_cache/migration.sql")).digest("hex")).toBe(PREVIOUS_ARCA_SHA256);
    });
    it("transaccional, con timeouts y sin operaciones destructivas", () => {
        expect(code.startsWith("BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s';")).toBe(true);
        expect(code.endsWith("COMMIT;")).toBe(true);
        expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME|GRANT)\b|\bDELETE FROM\b|\bUPDATE "/i);
        expect(code).not.toMatch(/\bSET NOT NULL\b|\bALTER COLUMN\b/i);
    });
    it("sólo altera la tabla técnica ArcaWsaaTicket, con columnas nullable", () => {
        const alters = [...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
        expect(new Set(alters)).toEqual(new Set(["ArcaWsaaTicket"]));
        expect(code).toContain('ALTER TABLE "ArcaWsaaTicket" ADD COLUMN "leaseId" TEXT, ADD COLUMN "leaseUntil" TIMESTAMPTZ(3);');
        expect(code).toContain('CHECK (("leaseId" IS NULL) = ("leaseUntil" IS NULL))');
    });
    it("crea sólo las tablas técnicas; el interruptor nace apagado", () => {
        expect([...code.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])).toEqual(NEW_TABLES);
        expect(code).toContain(`INSERT INTO "ArcaPadronControl" ("id", "enabled") VALUES ('global', false);`);
        expect([...code.matchAll(/INSERT INTO/g)]).toHaveLength(1);
        expect(code).toContain(`CHECK ("id" = 'global')`);
        expect(code).toMatch(/"enabled" BOOLEAN NOT NULL DEFAULT false[\s\S]*"enabled" BOOLEAN NOT NULL DEFAULT false/);
    });
    it("RLS sin políticas y sin privilegios para PUBLIC ni roles API, también en la secuencia", () => {
        expect(code).toContain(`FOREACH t IN ARRAY ARRAY['ArcaPadronControl', 'ArcaPadronOrganization', 'ArcaLookupQuota', 'ArcaLookupQuotaEvent']`);
        expect(code).toContain("ENABLE ROW LEVEL SECURITY");
        expect(code).toContain("REVOKE ALL ON TABLE %I FROM PUBLIC");
        expect(code).toContain("REVOKE ALL ON SEQUENCE %I FROM %I");
        expect(code).not.toMatch(/CREATE POLICY/i);
    });
    it("las claves de cupo no admiten datos en claro fuera del formato u:/o:/c:", () => {
        expect(code).toContain(`CHECK ("key" ~ '^[uoc]:[A-Za-z0-9_-]{1,80}$')`);
    });
});
