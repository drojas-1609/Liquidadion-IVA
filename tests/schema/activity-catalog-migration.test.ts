import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de la migración de origen de actividades (catálogo/manual)
 * y tratamiento/origen de alícuotas informativas. NO aplicada en DEV ni PROD.
 * Aditiva: tres enums, columnas con DEFAULT constante o nullable y CHECKs; sin
 * transformar datos.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20261027120000_activity_catalog_rate_origin";
/** Aplicadas en PROD: no deben cambiar nunca. */
const APPLIED_SHA256: Record<string, string> = {
  "0_init": "563767d5f4bcb541b98b2a58b478f68f02d77d38877b8d4f61ffe94450cab80e",
  "20260907213357_float_to_decimal": "7185f475c21798ea25e2b41d379c8e4c333409efce3d8e87c4caa3e0695d60c9",
  "20260908021123_org_auth_base": "418543554a79cbf8a8fed61209c674880210b50a8d4040be64ec40830a03c6aa",
  "20260908204819_org_scope_and_audit": "0553ac56ebac85ca6ff46d9e3c366b99c162dbb14d374d22502b50c219cc91e1",
  "20260925030000_invoice_accounting_model_expand": "cada8178b87d401de090854e8881670f243d60b1590a1ba98fe55bff176fa005",
  "20260925210133_invoice_counterparty_turiva_variant_expand": "7d473da450713be42f8b1b3dd767e62a5698d33ccf16241e873f4ee0b4b93032",
  "20261009120000_period_close_reopen": "b86d020d7fe08f9e7f4e8f87b82084bd220230089040f016e8368d05936e30d9",
  "20261025120000_client_profile_iibb_contacts": "9a8be750cc3f6e73b508b02b3087678c4d201c461181558db4cd7b1d07e71293",
};

const sql = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();
const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
const schema = readFileSync(repo + "prisma/schema.prisma", "utf8");

describe(`migración ${MIGRATION} — revisión estática`, () => {
  it("es la última y no cambia las aplicadas (checksums de PROD)", () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(dirs).toEqual([...Object.keys(APPLIED_SHA256), MIGRATION]);
    for (const [name, sha] of Object.entries(APPLIED_SHA256)) {
      expect(createHash("sha256").update(readFileSync(migrationsDir + name + "/migration.sql")).digest("hex"), name).toBe(sha);
    }
  });

  it("transacción explícita con límites", () => {
    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '60s'");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("aditiva: sin DROP, DELETE, UPDATE, RENAME, TRUNCATE ni cambios de tipo", () => {
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE|INSERT)\b/i);
    expect(code).not.toMatch(/ALTER COLUMN/i);
  });

  it("DDL idéntico al diff de Prisma (enums y columnas) más tres CHECK", () => {
    expect(statements).toEqual(
      expect.arrayContaining([
        `CREATE TYPE "ActivityOrigin" AS ENUM ('CATALOG', 'MANUAL')`,
        `CREATE TYPE "RateTreatment" AS ENUM ('RATE', 'EXEMPT')`,
        `CREATE TYPE "RateOrigin" AS ENUM ('STUDIO_MANUAL', 'CONFIRMED_SUGGESTION')`,
        `ALTER TABLE "ClientActivity" ADD COLUMN "catalogId" TEXT, ADD COLUMN "catalogVersion" TEXT, ADD COLUMN "origin" "ActivityOrigin" NOT NULL DEFAULT 'MANUAL'`,
        `ALTER TABLE "ClientActivityRate" ADD COLUMN "rateOrigin" "RateOrigin", ADD COLUMN "ruleRef" TEXT, ADD COLUMN "treatment" "RateTreatment" NOT NULL DEFAULT 'RATE'`,
      ]),
    );
    expect(statements.filter((s) => s.startsWith("ALTER TABLE") && s.includes("ADD CONSTRAINT"))).toHaveLength(3);
  });

  it("CHECKs: copia de catálogo completa, exención sin tasa, regla sólo con sugerencia confirmada, dato ausente sin origen", () => {
    expect(code).toContain(`("origin" = 'CATALOG' AND "catalogId" IS NOT NULL`);
    expect(code).toContain(`("origin" = 'MANUAL' AND "catalogId" IS NULL AND "catalogVersion" IS NULL)`);
    expect(code).toContain(`CHECK ("treatment" = 'RATE' OR "rate" IS NULL)`);
    // IS NOT DISTINCT FROM: con rateOrigin NULL la igualdad no puede quedar en NULL (que el CHECK aceptaría).
    expect(code).toContain(`("rateOrigin" IS NOT DISTINCT FROM 'CONFIRMED_SUGGESTION') = ("ruleRef" IS NOT NULL)`);
    expect(code).toContain(`NOT ("treatment" = 'RATE' AND "rate" IS NULL AND "rateOrigin" IS NOT NULL)`);
  });

  it("schema.prisma: defaults coherentes y defaultIibbRate intacto", () => {
    expect(schema).toMatch(/origin\s+ActivityOrigin\s+@default\(MANUAL\)/);
    expect(schema).toMatch(/treatment\s+RateTreatment\s+@default\(RATE\)/);
    expect(schema).toMatch(/rateOrigin\s+RateOrigin\?/);
    expect(schema).toMatch(/defaultIibbRate\s+Decimal\s+@default\(3\.000000\) @db\.Decimal\(9, 6\)/);
  });
});

describe("formulario de la ficha — alícuota heredada y accesibilidad (revisión estática)", () => {
  const form = readFileSync(repo + "app/(app)/clients/_components/client-profile-form.tsx", "utf8");
  const errorsUi = readFileSync(repo + "app/(app)/clients/_components/form-errors.tsx", "utf8");

  it("alícuota del cálculo actual: editable en la ficha, enviada sólo si cambió, con su alcance y estado de revisión", () => {
    expect(form).toContain("Alícuota del cálculo actual (%)");
    expect(form).toMatch(/name="defaultIibbRate"/);
    expect(form).toContain("const legacyChanged = legacyRate !== initial.defaultIibbRate;");
    expect(form).toContain("...(legacyChanged ? { defaultIibbRate: legacyRate } : {})");
    expect(form).toContain("valor predeterminado, pendiente de confirmación.");
    expect(form).toContain("Sin constancia de revisión");
    expect(form).toContain("El cálculo y las exportaciones todavía usan este único valor.");
    expect(form).toContain("No se obtiene automáticamente de las actividades");
    expect(form).toContain("no representa una liquidación por jurisdicción");
  });
  it("sin pantalla separada para la alícuota del cálculo actual", () => {
    expect(existsSync(repo + "app/(app)/client/[id]/calculo-heredado/page.tsx")).toBe(false);
    expect(form).not.toContain("/calculo-heredado");
  });
  it("errores: resumen con enlaces, aria-invalid/aria-describedby, foco en el primero, texto e ícono", () => {
    expect(errorsUi).toContain('"aria-invalid"');
    expect(errorsUi).toContain('"aria-describedby"');
    expect(errorsUi).toMatch(/href=\{`#\$\{domIdFor\(baseId, e\.key\)\}`\}/);
    expect(errorsUi).toContain("Error: {err.message}");
    expect(form).toContain("setFocusRequest((n) => n + 1)");
    expect(form).toContain("noValidate");
  });
  it("concurrencia del PR #17 conservada", () => {
    expect(form).toContain("expectedUpdatedAt: initial.expectedUpdatedAt");
    expect(form).toContain("if (stale) return;");
    expect(form).toMatch(/disabled=\{loading \|\| pending !== null \|\| stale\}/);
    expect(form).toContain("Descartar mis cambios y recargar");
  });
});
