import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de la migración EXPAND de cierre y reapertura de períodos
 * (NO aplicada a DEV ni PROD). Aditiva: un enum, tres columnas (status NOT NULL
 * DEFAULT 'OPEN', closedAt y closedById nullable), la FK de closedById y un
 * CHECK de coherencia. La prueba real contra PostgreSQL se hace en DEV.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20261009120000_period_close_reopen";
/** Checksums de las migraciones previas (aplicadas): no deben cambiar. */
const PRIOR_SHA256: Record<string, string> = {
  "0_init": "563767d5f4bcb541b98b2a58b478f68f02d77d38877b8d4f61ffe94450cab80e",
  "20260907213357_float_to_decimal": "7185f475c21798ea25e2b41d379c8e4c333409efce3d8e87c4caa3e0695d60c9",
  "20260908021123_org_auth_base": "418543554a79cbf8a8fed61209c674880210b50a8d4040be64ec40830a03c6aa",
  "20260908204819_org_scope_and_audit": "0553ac56ebac85ca6ff46d9e3c366b99c162dbb14d374d22502b50c219cc91e1",
  "20260925030000_invoice_accounting_model_expand": "cada8178b87d401de090854e8881670f243d60b1590a1ba98fe55bff176fa005",
  "20260925210133_invoice_counterparty_turiva_variant_expand": "7d473da450713be42f8b1b3dd767e62a5698d33ccf16241e873f4ee0b4b93032",
};

const sql = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");
/** SQL sin comentarios y con espacios normalizados. */
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
const schema = readFileSync(repo + "prisma/schema.prisma", "utf8");

describe(`migración ${MIGRATION} — revisión estática`, () => {
  it("es la última migración y las previas no cambiaron (checksum)", () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...Object.keys(PRIOR_SHA256), MIGRATION].sort());
    expect(dirs[dirs.length - 1]).toBe(MIGRATION);
    for (const [m, sha] of Object.entries(PRIOR_SHA256)) {
      const hash = createHash("sha256").update(readFileSync(migrationsDir + m + "/migration.sql")).digest("hex");
      expect(hash, m).toBe(sha);
    }
  });

  /** Las 4 operaciones aditivas, sin cambios respecto del diff de Prisma (+ CHECK). */
  const OPERATIONS = [
    `CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED')`,
    `ALTER TABLE "Period" ADD COLUMN "closedAt" TIMESTAMP(3), ADD COLUMN "closedById" UUID, ADD COLUMN "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN'`,
    `ALTER TABLE "Period" ADD CONSTRAINT "Period_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
    `ALTER TABLE "Period" ADD CONSTRAINT "Period_closed_state_check" CHECK (("status" = 'CLOSED') = ("closedAt" IS NOT NULL))`,
  ];

  it("transacción explícita con límites exactos que envuelve las 4 operaciones aditivas, en orden", () => {
    expect(statements).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL statement_timeout = '60s'",
      ...OPERATIONS,
      "COMMIT",
    ]);
  });

  it("control de transacción único: un BEGIN al inicio, un COMMIT al final, sin ROLLBACK, SAVEPOINT ni SET fuera de LOCAL", () => {
    expect(statements.filter((s) => /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(s))).toEqual(["BEGIN", "COMMIT"]);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(statements.filter((s) => /^SET\b/i.test(s)).every((s) => /^SET LOCAL /.test(s))).toBe(true);
    expect(code).not.toMatch(/\b(ROLLBACK|SAVEPOINT|CONCURRENTLY)\b/i);
  });

  it("sin operaciones destructivas, backfill ni cambios fuera de Period", () => {
    // Las acciones referenciales de la FK no son DML: se excluyen antes de buscar.
    const dml = code.replace(/ON DELETE SET NULL ON UPDATE CASCADE/g, "");
    expect(dml).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME|UPDATE|INSERT)\b/i);
    expect(code).not.toMatch(/ALTER COLUMN/i);
    expect(code).not.toMatch(/ALTER TABLE "(?!Period")/);
  });

  it("closedById es UUID como Profile.id (verificado en el schema) y la FK usa SET NULL", () => {
    expect(schema).toMatch(/model Profile \{\s*id\s+String\s+@id @db\.Uuid/);
    expect(schema).toMatch(/closedById String\?\s+@db\.Uuid/);
    expect(schema).toMatch(/closedBy\s+Profile\?\s+@relation\("PeriodClosedBy", fields: \[closedById\], references: \[id\], onDelete: SetNull\)/);
    expect(schema).toMatch(/status\s+PeriodStatus @default\(OPEN\)/);
    expect(schema).toMatch(/enum PeriodStatus \{\s*OPEN\s*CLOSED\s*\}/);
  });

  it("CHECK de coherencia: espejo trivalente — nunca NULL; filas existentes (OPEN, closedAt NULL) lo cumplen", () => {
    // status es NOT NULL e "IS NOT NULL" nunca es NULL: la expresión es TRUE o FALSE.
    const check = (status: "OPEN" | "CLOSED", closedAt: Date | null) => (status === "CLOSED") === (closedAt !== null);
    expect(check("OPEN", null)).toBe(true);
    expect(check("CLOSED", new Date())).toBe(true);
    expect(check("OPEN", new Date())).toBe(false);
    expect(check("CLOSED", null)).toBe(false);
  });

  it("documenta el alcance: no congela la liquidación frente a defaultIibbRate", () => {
    expect(sql).toMatch(/NO congela la liquidación/);
    expect(sql).toMatch(/defaultIibbRate/);
  });
});
