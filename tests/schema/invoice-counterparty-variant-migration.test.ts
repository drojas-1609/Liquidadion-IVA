import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de la migración expand del PR B (etapa 2).
 *
 * Además de la estructura, reproduce en JavaScript la lógica TRIVALENTE de
 * PostgreSQL: un CHECK se cumple cuando su expresión es TRUE **o NULL**. Cada
 * expresión SQL se verifica literalmente y su espejo JS se evalúa con NULL,
 * para demostrar que las combinaciones con operandos NULL quedan rechazadas.
 * La prueba real contra PostgreSQL (PGlite) se hace en la validación integral.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const SUFFIX = "_invoice_counterparty_turiva_variant_expand";
const M1 = "20260925030000_invoice_accounting_model_expand";
const PRIOR = [
  "0_init",
  "20260907213357_float_to_decimal",
  "20260908021123_org_auth_base",
  "20260908204819_org_scope_and_audit",
  M1,
];
/** Checksum aplicado en dev y producción (no debe cambiar). */
const M1_SHA256 = "cada8178b87d401de090854e8881670f243d60b1590a1ba98fe55bff176fa005";

const dirs = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const MIGRATION = dirs.find((d) => d.endsWith(SUFFIX)) ?? "";
const sql = MIGRATION ? readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8") : "";
/** SQL sin comentarios y con espacios normalizados. */
const code = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ")
  .trim();

const CHECKS = {
  Invoice_counterparty_vat_condition_check: `"counterpartyVatConditionCode" IS NULL OR "counterpartyVatConditionCode" IN (1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16)`,
  Invoice_turiva_relation_code_check: `"turivaRelationCode" IS NULL OR "turivaRelationCode" IN ('0001', '0002', '0003', '0004', '0005', '0006')`,
  Invoice_turiva_relation_voucher_check: `"turivaRelationCode" IS NULL OR ("voucherCode" IS NOT NULL AND "voucherCode" IN (195, 196, 197))`,
  Invoice_voucher_variant_check: `"voucherVariant" IS NULL OR "voucherVariant" IN ('NONE', 'PAGO_EN_CBU_INFORMADA')`,
  Invoice_voucher_variant_code_check: `"voucherVariant" IS NULL OR ("voucherCode" IS NOT NULL AND "voucherCode" IN (1, 2, 3))`,
  Invoice_voucher_variant_manual_check: `"voucherVariant" IS NULL OR ("source" IS NOT NULL AND "source" = 'MANUAL')`,
  Invoice_turiva_section_check: `"voucherCode" IS NULL OR "voucherCode" NOT IN (195, 196, 197) OR "lidSection" = 'TURIVA'`,
} as const;

// ── Lógica trivalente (espejo de PostgreSQL) ───────────────────────────────
type TV = boolean | null;
const or = (...xs: TV[]): TV => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const and = (...xs: TV[]): TV => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const isNull = (v: unknown): TV => v === null;
const isNotNull = (v: unknown): TV => v !== null;
const eq = (a: unknown, b: unknown): TV => (a === null || b === null ? null : a === b);
const inList = (a: unknown, list: readonly unknown[]): TV => (a === null ? null : list.includes(a));
const notIn = (a: unknown, list: readonly unknown[]): TV => (a === null ? null : !list.includes(a));
/** PostgreSQL: el CHECK se cumple salvo que la expresión sea FALSE. */
const passes = (v: TV) => v !== false;

interface Row {
  voucherCode: number | null;
  source: "MANUAL" | "IMPORT" | null;
  lidSection: "GENERAL" | "TURIVA";
  counterpartyVatConditionCode: number | null;
  turivaRelationCode: string | null;
  voucherVariant: string | null;
}

const MIRROR: Record<keyof typeof CHECKS, (r: Row) => TV> = {
  Invoice_counterparty_vat_condition_check: (r) =>
    or(isNull(r.counterpartyVatConditionCode), inList(r.counterpartyVatConditionCode, [1, 4, 5, 6, 7, 8, 9, 10, 13, 15, 16])),
  Invoice_turiva_relation_code_check: (r) =>
    or(isNull(r.turivaRelationCode), inList(r.turivaRelationCode, ["0001", "0002", "0003", "0004", "0005", "0006"])),
  Invoice_turiva_relation_voucher_check: (r) =>
    or(isNull(r.turivaRelationCode), and(isNotNull(r.voucherCode), inList(r.voucherCode, [195, 196, 197]))),
  Invoice_voucher_variant_check: (r) => or(isNull(r.voucherVariant), inList(r.voucherVariant, ["NONE", "PAGO_EN_CBU_INFORMADA"])),
  Invoice_voucher_variant_code_check: (r) => or(isNull(r.voucherVariant), and(isNotNull(r.voucherCode), inList(r.voucherCode, [1, 2, 3]))),
  Invoice_voucher_variant_manual_check: (r) => or(isNull(r.voucherVariant), and(isNotNull(r.source), eq(r.source, "MANUAL"))),
  Invoice_turiva_section_check: (r) => or(isNull(r.voucherCode), notIn(r.voucherCode, [195, 196, 197]), eq(r.lidSection, "TURIVA")),
};

const legacy: Row = {
  voucherCode: null,
  source: null,
  lidSection: "GENERAL",
  counterpartyVatConditionCode: null,
  turivaRelationCode: null,
  voucherVariant: null,
};
const failing = (r: Row) => (Object.keys(MIRROR) as (keyof typeof CHECKS)[]).filter((k) => !passes(MIRROR[k](r)));

describe("migración expand PR B — estructura", () => {
  it("carpeta nueva con timestamp de 14 dígitos, apilada después de M1", () => {
    expect(MIGRATION).toMatch(new RegExp(`^\\d{14}${SUFFIX}$`));
    expect(MIGRATION > M1).toBe(true);
    expect(dirs.filter((d) => d < MIGRATION)).toEqual([...PRIOR].sort());
  });

  it("no modifica migraciones anteriores: M1 conserva el checksum aplicado", () => {
    const m1 = readFileSync(migrationsDir + M1 + "/migration.sql");
    expect(createHash("sha256").update(m1).digest("hex")).toBe(M1_SHA256);
    for (const m of PRIOR) {
      expect(readFileSync(migrationsDir + m + "/migration.sql", "utf8")).not.toMatch(/voucherVariant|turivaRelationCode|counterpartyVatConditionCode/);
    }
  });

  it("atomicidad explícita: un único BEGIN … COMMIT", () => {
    expect(code.startsWith("BEGIN;")).toBe(true);
    expect(code.endsWith("COMMIT;")).toBe(true);
    expect(code.match(/\bBEGIN;/g)).toHaveLength(1);
    expect(code.match(/\bCOMMIT;/g)).toHaveLength(1);
  });

  it("tres columnas nuevas nullable, sin default y sin backfill", () => {
    expect(code).toContain(`ALTER TABLE "Invoice" ADD COLUMN "counterpartyVatConditionCode" INTEGER;`);
    expect(code).toContain(`ALTER TABLE "Invoice" ADD COLUMN "turivaRelationCode" VARCHAR(4);`);
    expect(code).toContain(`ALTER TABLE "Invoice" ADD COLUMN "voucherVariant" VARCHAR(32);`);
    expect(code).not.toMatch(/ADD COLUMN [^;]*(NOT NULL|DEFAULT)/i);
    expect(code).not.toMatch(/\bDEFAULT\b/i);
    expect(code).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });

  it("no borra ni altera objetos existentes ni toca el esquema auth", () => {
    expect(code).not.toMatch(/\bDROP\b|ALTER COLUMN|RENAME|TRUNCATE/i);
    expect(code).not.toMatch(/"auth"|auth\./);
  });
});

describe("migración expand PR B — CHECKs", () => {
  it.each(Object.entries(CHECKS))("%s con la expresión exacta", (name, expr) => {
    expect(code).toContain(`ADD CONSTRAINT "${name}" CHECK ( ${expr} )`);
  });

  it("sólo Invoice_turiva_section_check es NOT VALID; los demás son inmediatos", () => {
    expect(code.match(/NOT VALID/g)).toHaveLength(1);
    expect(code).toContain(`"lidSection" = 'TURIVA' ) NOT VALID;`);
    expect(code.match(/ADD CONSTRAINT/g)).toHaveLength(Object.keys(CHECKS).length);
  });

  it("la leyenda de retención no se almacena ni integra ningún CHECK; el 063 no aparece", () => {
    expect(sql).not.toMatch(/OPERACION_SUJETA_A_RETENCION/);
    expect(code).not.toMatch(/\b63\b/);
  });

  it("schema.prisma declara los tres campos con los tipos aprobados", () => {
    const schema = readFileSync(repo + "prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/counterpartyVatConditionCode\s+Int\?\n/);
    expect(schema).toMatch(/turivaRelationCode\s+String\?\s+@db\.VarChar\(4\)\n/);
    expect(schema).toMatch(/voucherVariant\s+String\?\s+@db\.VarChar\(32\)\n/);
    expect(schema).toContain(MIGRATION);
  });
});

describe("migración expand PR B — semántica NULL (lógica trivalente)", () => {
  it("fila heredada con los tres campos nuevos en NULL -> admitida por todos los CHECK", () => {
    expect(failing(legacy)).toEqual([]);
    expect(failing({ ...legacy, voucherCode: 1, source: "MANUAL" })).toEqual([]);
    expect(failing({ ...legacy, voucherCode: 195, source: "IMPORT", lidSection: "TURIVA" })).toEqual([]);
  });

  it("voucherVariant no NULL + voucherCode NULL -> rechazada", () => {
    expect(failing({ ...legacy, source: "MANUAL", voucherVariant: "NONE" })).toEqual(["Invoice_voucher_variant_code_check"]);
  });

  it("voucherVariant no NULL + source NULL -> rechazada", () => {
    expect(failing({ ...legacy, voucherCode: 1, voucherVariant: "PAGO_EN_CBU_INFORMADA" })).toEqual(["Invoice_voucher_variant_manual_check"]);
  });

  it("turivaRelationCode no NULL + voucherCode NULL -> rechazada, cualquiera sea source", () => {
    for (const source of ["MANUAL", "IMPORT", null] as const) {
      expect(failing({ ...legacy, source, turivaRelationCode: "0002" }), String(source)).toEqual(["Invoice_turiva_relation_voucher_check"]);
    }
  });

  it("por qué hace falta IS NOT NULL: la forma ingenua daría NULL y PostgreSQL la aceptaría", () => {
    const naive = (r: Row) => or(isNull(r.voucherVariant), inList(r.voucherCode, [1, 2, 3]));
    expect(naive({ ...legacy, voucherVariant: "NONE" })).toBeNull();
    expect(passes(naive({ ...legacy, voucherVariant: "NONE" }))).toBe(true);
  });

  it("relación TurIVA limitada a 195–197 en toda fila: MANUAL, IMPORT y source NULL", () => {
    for (const source of ["MANUAL", "IMPORT", null] as const) {
      expect(failing({ ...legacy, voucherCode: 195, source, lidSection: "TURIVA", turivaRelationCode: "0002" }), String(source)).toEqual([]);
      expect(failing({ ...legacy, voucherCode: 1, source, turivaRelationCode: "0002" }), String(source)).toEqual(["Invoice_turiva_relation_voucher_check"]);
    }
  });

  it("dominios: condición, relación y variante fuera de catálogo -> rechazadas", () => {
    expect(failing({ ...legacy, counterpartyVatConditionCode: 2 })).toEqual(["Invoice_counterparty_vat_condition_check"]);
    expect(
      failing({
        ...legacy,
        voucherCode: 195,
        source: "MANUAL",
        lidSection: "TURIVA",
        turivaRelationCode: "2",
      }),
    ).toEqual(["Invoice_turiva_relation_code_check"]);
    expect(failing({ ...legacy, voucherCode: 1, source: "MANUAL", voucherVariant: "OPERACION_SUJETA_A_RETENCION" })).toEqual(["Invoice_voucher_variant_check"]);
  });

  it("variante en 051–053 o importada -> rechazada", () => {
    expect(failing({ ...legacy, voucherCode: 51, source: "MANUAL", voucherVariant: "NONE" })).toEqual(["Invoice_voucher_variant_code_check"]);
    expect(failing({ ...legacy, voucherCode: 1, source: "IMPORT", voucherVariant: "NONE" })).toEqual(["Invoice_voucher_variant_manual_check"]);
  });

  it("sección TurIVA: 195–197 exigen TURIVA; 063 y voucherCode NULL no quedan alcanzados", () => {
    expect(failing({ ...legacy, voucherCode: 196, source: "MANUAL" })).toEqual(["Invoice_turiva_section_check"]);
    expect(failing({ ...legacy, voucherCode: 196, source: "MANUAL", lidSection: "TURIVA" })).toEqual([]);
    expect(failing({ ...legacy, voucherCode: 63, source: "IMPORT" })).toEqual([]);
  });
});
