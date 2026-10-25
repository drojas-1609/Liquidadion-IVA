import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de la migración de la ficha de clientes (contactos,
 * inscripción en Ingresos Brutos, jurisdicciones, actividades y alícuotas
 * informativas). NO aplicada a DEV ni PROD. Aditiva: columnas nullable en
 * Client, dos enums y tres tablas nuevas; ningún dato histórico se transforma.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20261025120000_client_profile_iibb_contacts";
/** Checksums de las migraciones previas: no deben cambiar. */
const PRIOR_SHA256: Record<string, string> = {
  "0_init": "563767d5f4bcb541b98b2a58b478f68f02d77d38877b8d4f61ffe94450cab80e",
  "20260907213357_float_to_decimal": "7185f475c21798ea25e2b41d379c8e4c333409efce3d8e87c4caa3e0695d60c9",
  "20260908021123_org_auth_base": "418543554a79cbf8a8fed61209c674880210b50a8d4040be64ec40830a03c6aa",
  "20260908204819_org_scope_and_audit": "0553ac56ebac85ca6ff46d9e3c366b99c162dbb14d374d22502b50c219cc91e1",
  "20260925030000_invoice_accounting_model_expand": "cada8178b87d401de090854e8881670f243d60b1590a1ba98fe55bff176fa005",
  "20260925210133_invoice_counterparty_turiva_variant_expand": "7d473da450713be42f8b1b3dd767e62a5698d33ccf16241e873f4ee0b4b93032",
  "20261009120000_period_close_reopen": "b86d020d7fe08f9e7f4e8f87b82084bd220230089040f016e8368d05936e30d9",
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
  it("es la última y no cambia las previas", () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(dirs).toEqual([...Object.keys(PRIOR_SHA256), MIGRATION]);
    for (const [name, sha] of Object.entries(PRIOR_SHA256)) {
      const got = createHash("sha256").update(readFileSync(migrationsDir + name + "/migration.sql")).digest("hex");
      expect(got, name).toBe(sha);
    }
  });

  it("transacción explícita con límites de espera", () => {
    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '60s'");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("aditiva: sin DROP, DELETE, UPDATE, RENAME, TRUNCATE ni cambios de tipo", () => {
    // Las cláusulas referenciales de las FK (ON DELETE / ON UPDATE) no son DML.
    const dml = code.replace(/ON (DELETE|UPDATE) (CASCADE|NO ACTION|RESTRICT)/g, "");
    expect(dml).not.toMatch(/\b(DROP|DELETE|UPDATE|RENAME|TRUNCATE)\b/i);
    expect(code).not.toMatch(/ALTER COLUMN/i);
  });

  it("Client: sólo columnas NUEVAS y nullable (los clientes históricos quedan sin clasificar)", () => {
    const alters = statements.filter((s) => /^ALTER TABLE "Client"/.test(s));
    expect(alters).toHaveLength(1);
    const added = alters[0].replace(/^ALTER TABLE "Client"\s*/, "").split(/,\s*/);
    expect(added).toEqual(['ADD COLUMN "contactEmail" TEXT', 'ADD COLUMN "iibbRegistration" "ClientIibbRegistration"', 'ADD COLUMN "phone" TEXT']);
    expect(alters[0]).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it("enums con las opciones exactas", () => {
    expect(code).toContain(`CREATE TYPE "ClientIibbRegistration" AS ENUM ('LOCAL', 'SIMPLIFICADO', 'EXENTO', 'NO_INSCRIPTO', 'CONVENIO_MULTILATERAL')`);
    expect(code).toContain(`CREATE TYPE "ActivityNomenclator" AS ENUM ('ARCA', 'NAES', 'PROVINCIAL', 'OTRO')`);
  });

  it("tablas nuevas con aislamiento por organización (FK compuestas a Client)", () => {
    for (const t of ["ClientJurisdiction", "ClientActivity", "ClientActivityRate"]) {
      expect(code).toContain(`CREATE TABLE "${t}"`);
      expect(code).toMatch(new RegExp(`CREATE INDEX "${t}_organizationId_idx"`));
    }
    expect(code).toMatch(/ALTER TABLE "ClientJurisdiction" ADD CONSTRAINT "\w+" FOREIGN KEY \("clientId", "organizationId"\) REFERENCES "Client"\("id", "organizationId"\) ON DELETE CASCADE/);
    expect(code).toMatch(/ALTER TABLE "ClientActivity" ADD CONSTRAINT "\w+" FOREIGN KEY \("clientId", "organizationId"\) REFERENCES "Client"\("id", "organizationId"\) ON DELETE CASCADE/);
    expect(code).toMatch(/ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "\w+" FOREIGN KEY \("activityId", "clientId", "organizationId"\) REFERENCES "ClientActivity"\("id", "clientId", "organizationId"\) ON DELETE CASCADE/);
    // Una jurisdicción con alícuotas no puede borrarse en silencio.
    expect(code).toMatch(/ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "\w+" FOREIGN KEY \("clientId", "organizationId", "jurisdictionCode"\) REFERENCES "ClientJurisdiction"\("clientId", "organizationId", "jurisdictionCode"\) ON DELETE NO ACTION/);
  });

  it("sin duplicados", () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX "\w+" ON "ClientJurisdiction"\("clientId", "jurisdictionCode"\)/);
    expect(code).toMatch(/CREATE UNIQUE INDEX "\w+" ON "ClientActivity"\("clientId", "nomenclator", "nomenclatorJurisdiction", "code"\)/);
    expect(code).toMatch(/CREATE UNIQUE INDEX "\w+" ON "ClientActivityRate"\("activityId", "jurisdictionCode"\)/);
  });

  it("CHECKs: códigos de jurisdicción 901–924, alícuota NULL (sin informar) o 0..100, textos no vacíos", () => {
    expect(code).toContain(`ADD CONSTRAINT "ClientJurisdiction_code_check" CHECK ("jurisdictionCode" ~ '^9(0[1-9]|1[0-9]|2[0-4])$')`);
    expect(code).toContain(`ADD CONSTRAINT "ClientActivityRate_code_check"`);
    expect(code).toMatch(/"ClientActivityRate_rate_check" CHECK \("rate" IS NULL OR \("rate" >= 0 AND "rate" <= 100\)\)/);
    expect(code).toMatch(/"ClientActivity_text_check"/);
    expect(code).toMatch(/"ClientActivity_nomenclator_jurisdiction_check"/);
    expect(code).toMatch(/"rate" DECIMAL\(9,6\)(?! NOT NULL)/);
  });

  it("schema.prisma conserva defaultIibbRate (alícuota usada por el cálculo actual)", () => {
    expect(schema).toMatch(/defaultIibbRate\s+Decimal\s+@default\(3\.000000\) @db\.Decimal\(9, 6\)/);
    expect(schema).toMatch(/phone\s+String\?/);
    expect(schema).toMatch(/contactEmail\s+String\?/);
    expect(schema).toMatch(/iibbRegistration\s+ClientIibbRegistration\?/);
  });
});

describe("formulario de la ficha — revisión estática", () => {
  const form = readFileSync(repo + "app/(app)/clients/_components/client-profile-form.tsx", "utf8");
  it("ninguna inscripción IIBB preseleccionada: la primera opción es 'Sin clasificar' (valor vacío)", () => {
    const select = form.slice(form.indexOf('id={id("iibbRegistration")}'));
    expect(select.match(/<option[^>]*>[^<]*<\/option>/)?.[0]).toBe('<option value="">Sin clasificar</option>');
  });
  it("la alícuota legada se muestra en la sección secundaria rotulada", () => {
    expect(form).toContain("Alícuota usada por el cálculo actual");
  });
  it("versión obsoleta: conserva el borrador, bloquea el reenvío y ofrece recuperación explícita", () => {
    expect(form).toContain("expectedUpdatedAt: initial.expectedUpdatedAt");
    expect(form).toContain("if (stale) return;");
    expect(form).toMatch(/disabled=\{loading \|\| pending !== null \|\| stale\}/);
    expect(form).toContain("Abrir la versión actual en otra pestaña");
    expect(form).toContain("Descartar mis cambios y recargar");
    // El token nunca se toma de la respuesta del servidor ni se reintenta.
    expect(form).not.toMatch(/setExpectedUpdatedAt|expectedUpdatedAt\s*=/);
    expect(form.match(/submitClientUpdate\(/g)).toHaveLength(1);
  });
  it("las quitas se confirman con el conjunto exacto calculado sobre lo guardado al abrir", () => {
    expect(form).toContain("summarizeStoredProfile(initial)");
    expect(form).toContain("unconfirmedRemovals(storedSummary, iibb)");
    expect(form).not.toMatch(/window\.confirm|\bconfirm\(/);
  });
  it("la consulta ARCA no se presenta como verificación oficial de IIBB y declara que no aporta contactos", () => {
    expect(form).toMatch(/no informa teléfono ni email|no aporta teléfono ni email/i);
  });
});
