import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Revisión estática de la migración M1 (expand) de la Fase A.
 *
 * Además protege los objetos que Prisma 6.19 NO representa en schema.prisma
 * (índices únicos parciales y CHECKs): si una migración posterior los borra
 * —p. ej. aplicando sin revisar la salida de `prisma migrate diff`— cae un test.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDir = repo + "prisma/migrations/";
const MIGRATION = "20260925030000_invoice_accounting_model_expand";
const PRIOR = [
  "0_init",
  "20260907213357_float_to_decimal",
  "20260908021123_org_auth_base",
  "20260908204819_org_scope_and_audit",
];

const raw = readFileSync(migrationsDir + MIGRATION + "/migration.sql", "utf8");
/** SQL sin comentarios de línea, para no validar contra el texto explicativo. */
const sql = raw
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const oneLine = sql.replace(/\s+/g, " ");

const PRISMA_INVISIBLE = [
  "Invoice_sales_voucher_key",
  "Invoice_purchases_voucher_key",
  "Invoice_category_check",
  "Invoice_model_amounts_nonnegative_check",
  "Invoice_exchange_rate_check",
  "Invoice_direct_credit_check",
  "Invoice_sales_no_direct_credit_check",
  "Invoice_gross_income_base_sales_only_check",
  "InvoiceVatLine_amounts_nonnegative_check",
  "InvoiceVatLine_credit_allocation_check",
  "PeriodVatSettings_global_coefficient_range_check",
  "PeriodVatSettings_coefficient_status_check",
];

const NEW_COLUMNS = [
  "clientId",
  "source",
  "voucherCode",
  "numberTo",
  "voucherDate",
  "counterpartyDocType",
  "counterpartyDocNumber",
  "counterpartyName",
  "currencyCode",
  "exchangeRate",
  "taxedNetAmount",
  "totalVatAmount",
  "directComputableVatCreditAmount",
  "reportedComputableVatCreditAmount",
  "netWithoutVatBreakdownAmount",
  "nonTaxedAmount",
  "exemptAmount",
  "vatPerceptionAmount",
  "nationalPerceptionAmount",
  "iibbPerceptionAmount",
  "municipalPerceptionAmount",
  "internalTaxesAmount",
  "otherTaxesAmount",
  "grossIncomeTaxBaseAmount",
  "voucherTotalAmount",
  "turivaRefundAmount",
  "operationCode",
];

describe("migración M1 invoice_accounting_model_expand — estructura", () => {
  it("es una carpeta nueva apilada después de las 4 previas, sin modificarlas", () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs.filter((d) => d <= MIGRATION)).toEqual([...PRIOR, MIGRATION].sort());
    expect(MIGRATION > PRIOR[PRIOR.length - 1]).toBe(true);
    expect(readFileSync(migrationsDir + PRIOR[3] + "/migration.sql", "utf8")).toMatch(/CREATE TABLE "AuditLog"/);
    for (const m of PRIOR) {
      expect(readFileSync(migrationsDir + m + "/migration.sql", "utf8")).not.toMatch(/InvoiceVatLine|voucherCode/);
    }
  });

  it("atomicidad explícita: un único BEGIN … COMMIT que envuelve todo", () => {
    expect(sql.match(/^\s*BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT;/gm)).toHaveLength(1);
    expect(sql.trim().startsWith("BEGIN;")).toBe(true);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("NO referencia el esquema auth ni crea triggers/funciones persistentes", () => {
    expect(sql).not.toMatch(/"?auth"?\./i);
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION|PROCEDURE)/i);
  });

  it("columna lidSection: NOT NULL DEFAULT 'GENERAL' (única excepción aprobada, compatible)", () => {
    expect(oneLine).toMatch(/ADD COLUMN "lidSection" "LidSection" NOT NULL DEFAULT 'GENERAL'/);
  });

  it("enums nuevos con los valores exactos", () => {
    expect(oneLine).toMatch(/CREATE TYPE "InvoiceSource" AS ENUM \('MANUAL', 'IMPORT'\)/);
    expect(oneLine).toMatch(
      /CREATE TYPE "VatCreditAllocation" AS ENUM \('NOT_APPLICABLE', 'DIRECT_COMPUTABLE', 'DIRECT_NON_COMPUTABLE', 'GLOBAL_PRORATION'\)/,
    );
    expect(oneLine).toMatch(/CREATE TYPE "LidSection" AS ENUM \('GENERAL', 'TURIVA'\)/);
    expect(oneLine).toMatch(/CREATE TYPE "CreditProrationMode" AS ENUM \('NONE', 'DIRECT', 'GLOBAL', 'DIRECT_AND_GLOBAL'\)/);
    expect(oneLine).toMatch(/CREATE TYPE "CoefficientStatus" AS ENUM \('PROVISIONAL', 'DEFINITIVE'\)/);
  });

  it("no queda el nombre ambiguo computableVatCreditAmount", () => {
    expect(sql).not.toMatch(/"computableVatCreditAmount"/);
  });

  it("DML acotado: sólo UPDATE de Invoice, INSERT de InvoiceVatLine y la tabla temporal", () => {
    const updates = [...sql.matchAll(/UPDATE\s+"(\w+)"/g)].map((m) => m[1]);
    expect(new Set(updates)).toEqual(new Set(["Invoice"]));
    const inserts = [...sql.matchAll(/INSERT\s+INTO\s+"(\w+)"/g)].map((m) => m[1]);
    expect(inserts).toEqual(["InvoiceVatLine"]);
    const deletes = [...sql.matchAll(/DELETE\s+FROM\s+"(\w+)"/g)].map((m) => m[1]);
    expect(deletes).toEqual(["_fa_candidates"]); // sólo la tabla temporal
    expect(sql).toMatch(/CREATE TEMP TABLE "_fa_candidates" ON COMMIT DROP/);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
  });
});

describe("migración M1 — expand compatible con el código anterior", () => {
  it("columnas nuevas NULLABLE y SIN default (NULL = fila heredada)", () => {
    for (const c of NEW_COLUMNS) {
      const m = oneLine.match(new RegExp(`ADD COLUMN "${c}" ([^,;]+)[,;]`));
      // (lidSection se verifica aparte: default GENERAL aprobado)
      expect(m, c).not.toBeNull();
      expect(m![1], c).not.toMatch(/NOT NULL|DEFAULT/i);
    }
  });

  it("DROP NOT NULL sólo en columnas heredadas; importes heredados siguen NOT NULL", () => {
    const dropped = [...sql.matchAll(/ALTER COLUMN "(\w+)" DROP NOT NULL/g)].map((m) => m[1]).sort();
    expect(dropped).toEqual(["date", "entityCuit", "entityName", "type", "vatRate"]);
    expect(sql).not.toMatch(/SET NOT NULL/);
    for (const c of ["netAmount", "vatAmount", "totalAmount"]) {
      expect(sql).not.toMatch(new RegExp(`ALTER COLUMN "${c}"`));
    }
  });

  it("NO retira la FK anterior (periodId, organizationId): convive con la nueva", () => {
    expect(sql).not.toMatch(/DROP CONSTRAINT/i);
    expect(oneLine).toMatch(
      /ADD CONSTRAINT "Invoice_periodId_clientId_organizationId_fkey" FOREIGN KEY \("periodId", "clientId", "organizationId"\) REFERENCES "Period"\("id", "clientId", "organizationId"\) ON DELETE RESTRICT ON UPDATE CASCADE/,
    );
    expect(oneLine).toMatch(/CREATE UNIQUE INDEX "Period_id_clientId_organizationId_key"/);
  });

  it("líneas de IVA: FK compuesta por organización con ON DELETE CASCADE; unicidad por alícuota y atribución", () => {
    expect(oneLine).toMatch(
      /ADD CONSTRAINT "InvoiceVatLine_invoiceId_organizationId_fkey" FOREIGN KEY \("invoiceId", "organizationId"\) REFERENCES "Invoice"\("id", "organizationId"\) ON DELETE CASCADE/,
    );
    // CASCADE de borrado sólo en líneas (parte del comprobante) y configuración (parte del período)
    expect(sql.match(/ON DELETE CASCADE/g)).toHaveLength(2);
    expect(oneLine).toMatch(
      /CREATE UNIQUE INDEX "InvoiceVatLine_invoiceId_vatRateCode_creditAllocation_key" ON "InvoiceVatLine"\("invoiceId", "vatRateCode", "creditAllocation"\)/,
    );
    expect(sql).not.toMatch(/"InvoiceVatLine_invoiceId_vatRateCode_key"/);
    expect(oneLine).toMatch(/"creditAllocation" "VatCreditAllocation" NOT NULL/);
    expect(oneLine).toMatch(/"computableVatAmount" DECIMAL\(18,2\),/);
    expect(oneLine).toMatch(/"computableOverridden" BOOLEAN NOT NULL DEFAULT false/);
    expect(oneLine).toMatch(/CREATE UNIQUE INDEX "Invoice_id_organizationId_key"/);
  });

  it("PeriodVatSettings: tabla 1:1 con FK compuesta por organización, CASCADE con el período, autoría SET NULL", () => {
    expect(oneLine).toMatch(/CREATE TABLE "PeriodVatSettings"/);
    expect(oneLine).toMatch(/"creditProrationMode" "CreditProrationMode" NOT NULL DEFAULT 'NONE'/);
    expect(oneLine).toMatch(/"globalCoefficient" DECIMAL\(11,10\),/);
    expect(oneLine).toMatch(/"globalCoefficientStatus" "CoefficientStatus",/);
    expect(oneLine).toMatch(/"turivaIncluded" BOOLEAN NOT NULL DEFAULT false/);
    expect(oneLine).toMatch(/CREATE UNIQUE INDEX "PeriodVatSettings_periodId_key" ON "PeriodVatSettings"\("periodId"\)/);
    expect(oneLine).toMatch(/CREATE UNIQUE INDEX "PeriodVatSettings_periodId_organizationId_key"/);
    expect(oneLine).toMatch(
      /"PeriodVatSettings_periodId_organizationId_fkey" FOREIGN KEY \("periodId", "organizationId"\) REFERENCES "Period"\("id", "organizationId"\) ON DELETE CASCADE/,
    );
    expect(oneLine).toMatch(/"PeriodVatSettings_createdById_fkey" FOREIGN KEY \("createdById"\) REFERENCES "Profile"\("id"\) ON DELETE SET NULL/);
    expect(oneLine).toMatch(/"PeriodVatSettings_updatedById_fkey" FOREIGN KEY \("updatedById"\) REFERENCES "Profile"\("id"\) ON DELETE SET NULL/);
  });

  it("CHECK de category NOT VALID (no revalida filas heredadas)", () => {
    expect(oneLine).toMatch(/"Invoice_category_check" CHECK \("category" IN \('SALES', 'PURCHASES'\)\) NOT VALID/);
  });
});

describe("migración M1 — objetos que Prisma no representa", () => {
  it("índice único PARCIAL de ventas: (clientId, voucherCode, pointOfSale, number) WHERE SALES", () => {
    expect(oneLine).toMatch(
      /CREATE UNIQUE INDEX "Invoice_sales_voucher_key" ON "Invoice" \("clientId", "voucherCode", "pointOfSale", "number"\) WHERE "category" = 'SALES';/,
    );
  });

  it("índice único PARCIAL de compras: incluye el documento del vendedor, WHERE PURCHASES", () => {
    expect(oneLine).toMatch(
      /CREATE UNIQUE INDEX "Invoice_purchases_voucher_key" ON "Invoice" \("clientId", "counterpartyDocType", "counterpartyDocNumber", "voucherCode", "pointOfSale", "number"\) WHERE "category" = 'PURCHASES';/,
    );
  });

  it("ninguno de los dos índices incluye periodId (unicidad en TODOS los períodos del cliente)", () => {
    for (const name of ["Invoice_sales_voucher_key", "Invoice_purchases_voucher_key"]) {
      const def = oneLine.match(new RegExp(`"${name}" ON "Invoice" \\(([^)]*)\\)`))![1];
      expect(def, name).not.toMatch(/periodId/);
      expect(def, name).toMatch(/"clientId"/);
    }
  });

  it("CHECKs de importes, tipo de cambio, crédito computable y base IIBB", () => {
    for (const c of NEW_COLUMNS.filter((c) => c.endsWith("Amount"))) {
      expect(oneLine, c).toMatch(new RegExp(`\\("${c}" IS NULL OR "${c}" >= 0\\)`));
    }
    expect(oneLine).toMatch(/"exchangeRate" > 0 AND \("currencyCode" IS DISTINCT FROM 'PES' OR "exchangeRate" = 1\)/);
    expect(oneLine).toMatch(/"directComputableVatCreditAmount" <= "totalVatAmount"/);
    expect(oneLine).toMatch(
      /"category" <> 'SALES' OR "directComputableVatCreditAmount" IS NULL OR "directComputableVatCreditAmount" = 0/,
    );
    expect(oneLine).toMatch(/"category" = 'SALES' OR "grossIncomeTaxBaseAmount" IS NULL/);
    expect(oneLine).toMatch(/"InvoiceVatLine_amounts_nonnegative_check" CHECK \( "netAmount" >= 0 AND "vatAmount" >= 0 \)/);
  });

  it("CHECK de atribución por línea (DIRECT 0..IVA; NON_COMPUTABLE = 0; GLOBAL y NOT_APPLICABLE NULL)", () => {
    const def = oneLine.match(/"InvoiceVatLine_credit_allocation_check" CHECK \((.*?)\);/)![1];
    expect(def).toMatch(/"creditAllocation" = 'DIRECT_COMPUTABLE' AND "computableVatAmount" IS NOT NULL AND "computableVatAmount" >= 0 AND "computableVatAmount" <= "vatAmount"/);
    expect(def).toMatch(/"creditAllocation" = 'DIRECT_NON_COMPUTABLE' AND "computableVatAmount" = 0 AND NOT "computableOverridden"/);
    expect(def).toMatch(/"creditAllocation" IN \('GLOBAL_PRORATION', 'NOT_APPLICABLE'\) AND "computableVatAmount" IS NULL AND NOT "computableOverridden"/);
  });

  it("coeficiente global: 0..1 y va junto con su estado", () => {
    expect(oneLine).toMatch(/"globalCoefficient" IS NULL OR \("globalCoefficient" >= 0 AND "globalCoefficient" <= 1\)/);
    expect(oneLine).toMatch(/\("globalCoefficient" IS NULL\) = \("globalCoefficientStatus" IS NULL\)/);
  });

  it("todos los objetos invisibles para Prisma están creados en esta migración", () => {
    for (const name of PRISMA_INVISIBLE) {
      expect(sql, name).toMatch(new RegExp(`"${name}"`));
    }
  });

  it("NINGUNA migración posterior los borra (protección contra `migrate diff` sin revisar)", () => {
    const later = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name > MIGRATION)
      .map((d) => d.name);
    for (const m of later) {
      const s = readFileSync(migrationsDir + m + "/migration.sql", "utf8");
      for (const name of PRISMA_INVISIBLE) {
        expect(s, `${m} / ${name}`).not.toMatch(
          new RegExp(`DROP\\s+(INDEX|CONSTRAINT)\\s+(IF\\s+EXISTS\\s+)?"${name}"`, "i"),
        );
      }
    }
  });

  it("schema.prisma documenta que esos objetos viven sólo en migration.sql", () => {
    const schema = readFileSync(repo + "prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/Prisma 6\.19 NO representa/);
    for (const name of ["Invoice_sales_voucher_key", "Invoice_purchases_voucher_key"]) {
      expect(schema).toContain(name);
    }
  });
});

describe("migración M1 — backfill", () => {
  it("usa los códigos OFICIALES de alícuota (0004 = 10,5 %, 0008 = 5 %)", () => {
    expect(oneLine).toMatch(
      /\(3, 0::numeric\), \(4, 10\.5::numeric\), \(5, 21::numeric\), \(6, 27::numeric\), \(8, 5::numeric\), \(9, 2\.5::numeric\)/,
    );
  });

  it("mapea las etiquetas heredadas a los códigos oficiales de comprobante", () => {
    for (const [label, code, sign] of [
      ["FC A", 1, 1], ["ND A", 2, 1], ["NC A", 3, -1],
      ["FC B", 6, 1], ["ND B", 7, 1], ["NC B", 8, -1],
      ["FC C", 11, 1], ["ND C", 12, 1], ["NC C", 13, -1],
    ] as const) {
      expect(oneLine, label).toMatch(new RegExp(`\\('${label}', ${code}, +${sign},`));
    }
  });

  it("sólo representa filas con signo coherente y total = neto + IVA (NC positiva queda heredada)", () => {
    expect(oneLine).toMatch(/vt\."sign" = 1 AND i\."netAmount" >= 0/);
    expect(oneLine).toMatch(/vt\."sign" = -1 AND i\."netAmount" <= 0/);
    expect(oneLine).toMatch(/i\."totalAmount" = i\."netAmount" \+ i\."vatAmount"/);
  });

  it("compras B/C: sin líneas y con el neto en netWithoutVatBreakdownAmount; con IVA quedan heredadas", () => {
    expect(oneLine).toMatch(/\(i\."category" = 'PURCHASES' AND vt\."letter" IN \('B', 'C'\)\) AS "noBreakdown"/);
    expect(oneLine).toMatch(/"netWithoutVatBreakdownAmount" = CASE WHEN c\."noBreakdown" THEN abs\(i\."netAmount"\) ELSE 0 END/);
    expect(oneLine).toMatch(/WHERE NOT c\."noBreakdown";/);
    expect(oneLine).toMatch(/AND \(i\."vatRate" <> 0 OR i\."vatAmount" <> 0\)/);
  });

  it("importes nuevos positivos (abs) y signo sólo por código; base IIBB = neto en ventas", () => {
    expect(oneLine).toMatch(/"voucherTotalAmount" = abs\(i\."totalAmount"\)/);
    expect(oneLine).toMatch(/"grossIncomeTaxBaseAmount" = CASE WHEN i\."category" = 'SALES' THEN abs\(i\."netAmount"\) ELSE NULL END/);
    expect(oneLine).toMatch(
      /"directComputableVatCreditAmount" = CASE WHEN i\."category" = 'PURCHASES' AND NOT c\."noBreakdown" THEN abs\(i\."vatAmount"\) ELSE 0 END/,
    );
    expect(oneLine).toMatch(/"reportedComputableVatCreditAmount" = NULL/);
    expect(oneLine).toMatch(/"turivaRefundAmount" = 0/);
  });

  it("fecha: cast directo a DATE (sin AT TIME ZONE, que dependería de la sesión)", () => {
    expect(oneLine).toMatch(/"voucherDate" = i\."date"::date/);
    expect(sql).not.toMatch(/AT TIME ZONE/i);
  });

  it("líneas del backfill: compras DIRECT_COMPUTABLE con computable = IVA; ventas NOT_APPLICABLE con NULL", () => {
    expect(oneLine).toMatch(
      /CASE WHEN i\."category" = 'PURCHASES' THEN 'DIRECT_COMPUTABLE' ELSE 'NOT_APPLICABLE' END::"VatCreditAllocation"/,
    );
    expect(oneLine).toMatch(/CASE WHEN i\."category" = 'PURCHASES' THEN abs\(i\."vatAmount"\) ELSE NULL END, false/);
  });

  it("duplicados: sólo se representa el más antiguo por clave de unicidad", () => {
    expect(oneLine).toMatch(/ROW_NUMBER\(\) OVER \( PARTITION BY c2\."clientId", i\."category", c2\."voucherCode", i\."pointOfSale", i\."number"/);
    expect(oneLine).toMatch(/d\."rn" > 1/);
  });

  it("verificación posterior aborta si líneas, total o liquidación no cuadran", () => {
    for (const msg of [
      "líneas de IVA que no suman el encabezado",
      "cuyo total no cumple la fórmula",
      "líneas de IVA en compras B/C",
      "cuya liquidación cambiaría",
      "atribución incompatible con la categoría",
    ]) {
      expect(sql).toContain(msg);
    }
    expect(sql.match(/RAISE EXCEPTION/g)!.length).toBeGreaterThanOrEqual(5);
    // el crédito directo del encabezado = Σ computable de las líneas DIRECT_COMPUTABLE
    expect(oneLine).toMatch(/i\."directComputableVatCreditAmount" <> COALESCE\(l\.direct, 0\)/);
  });

  it("el NOTICE sólo informa conteos (sin datos fiscales ni identificadores)", () => {
    const notice = oneLine.match(/RAISE NOTICE '([^']*)', ([^;]*);/)!;
    expect(notice[1]).toMatch(/comprobantes=%, representados=%, heredados para revisión=%/);
    expect(notice[2].replace(/\s/g, "")).toBe("n_total,n_modeled,n_legacy");
  });
});
