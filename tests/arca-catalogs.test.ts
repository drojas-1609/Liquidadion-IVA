import { describe, it, expect } from "vitest";
import {
  VAT_RATES,
  VOUCHER_TYPES,
  DOCUMENT_TYPES,
  CURRENCIES,
  SOURCE_LID_TABLAS,
  SOURCE_LID_ESPECIFICACIONES,
  RULE_PURCHASES_BC_NO_VAT_LINES,
  RULE_COMPUTABLE_CREDIT_DEFAULT,
  RULE_CREDIT_PRORATION_MODES,
  RULE_TURIVA,
  OPERATION_CODES,
  type OfficialSource,
} from "@/lib/arca/catalogs";

const OFFICIAL_HOSTS = new Set(["www.arca.gob.ar", "www.afip.gob.ar"]);

function expectOfficial(source: OfficialSource, what: string) {
  const url = new URL(source.url);
  expect(url.protocol, what).toBe("https:");
  expect(OFFICIAL_HOSTS.has(url.host), `${what}: ${url.host}`).toBe(true);
  expect(source.retrievedAt, what).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(source.document.length, what).toBeGreaterThan(10);
}

describe("lib/arca/catalogs — fuentes oficiales", () => {
  it("toda entrada y regla registra documento, URL oficial de ARCA y fecha de consulta", () => {
    for (const e of [...VAT_RATES, ...VOUCHER_TYPES, ...DOCUMENT_TYPES, ...CURRENCIES]) {
      expectOfficial(e.source, `código ${String(e.code)}`);
    }
    expectOfficial(RULE_PURCHASES_BC_NO_VAT_LINES.source, "regla B/C");
    expectOfficial(RULE_COMPUTABLE_CREDIT_DEFAULT.source, "crédito computable");
    expectOfficial(RULE_CREDIT_PRORATION_MODES.source, "modalidades de prorrateo");
    expectOfficial(RULE_TURIVA.source, "TurIVA");
    expect(SOURCE_LID_ESPECIFICACIONES.document).toMatch(/Revisión 30\/07\/2025/);
    expect(SOURCE_LID_TABLAS.url).toMatch(/Tablas-del-Sistema\.pdf$/);
  });

  it("códigos únicos dentro de cada catálogo", () => {
    for (const [name, list] of [
      ["alícuotas", VAT_RATES],
      ["comprobantes", VOUCHER_TYPES],
      ["documentos", DOCUMENT_TYPES],
      ["monedas", CURRENCIES],
    ] as const) {
      const codes = list.map((e) => e.code);
      expect(new Set(codes).size, name).toBe(codes.length);
    }
  });
});

describe("lib/arca/catalogs — contenido verificado", () => {
  it("alícuotas: tabla oficial exacta (0004 = 10,5 %, 0008 = 5 %)", () => {
    expect(VAT_RATES.map((r) => [r.code, r.rate])).toEqual([
      [3, "0"],
      [4, "10.5"],
      [5, "21"],
      [6, "27"],
      [8, "5"],
      [9, "2.5"],
    ]);
  });

  it("comprobantes: 001–003, 006–008, 011–013 y clase T 195–197 (sin FCE, M, 063 ni otros no verificados)", () => {
    expect(VOUCHER_TYPES.map((v) => v.code)).toEqual([1, 2, 3, 6, 7, 8, 11, 12, 13, 195, 196, 197]);
    for (const v of VOUCHER_TYPES) {
      expect(["A", "B", "C", "T"]).toContain(v.letter);
      expect(["INVOICE", "DEBIT_NOTE", "CREDIT_NOTE"]).toContain(v.kind);
    }
    for (const v of VOUCHER_TYPES.filter((x) => x.letter !== "T")) {
      expect(v.label).toMatch(/^(FACTURAS|NOTAS DE DEBITO|NOTAS DE CREDITO) [ABC]$/);
    }
    expect(VOUCHER_TYPES.map((v) => v.code)).not.toContain(63);
  });

  it("clase T (TurIVA): denominaciones oficiales y clase por código", () => {
    const t = VOUCHER_TYPES.filter((v) => v.letter === "T");
    expect(t.map((v) => [v.code, v.kind, v.label])).toEqual([
      [195, "INVOICE", "FACTURA CLASE “T”"],
      [196, "DEBIT_NOTE", "NOTA DE DÉBITO CLASE “T”"],
      [197, "CREDIT_NOTE", "NOTA DE CRÉDITO CLASE “T”"],
    ]);
  });

  it("códigos de operación oficiales, incluidos T (Reintegro Decreto 1043/2016) y D (Devol. IVA Turistas)", () => {
    expect(OPERATION_CODES.map((o) => o.code)).toEqual(["0", "A", "C", "D", "E", "N", "T", "X", "Z"]);
    expect(OPERATION_CODES.find((o) => o.code === "T")?.salesLabel).toBe("Reintegro Decreto 1043/2016");
    for (const o of OPERATION_CODES) expectOfficial(o.source, `operación ${o.code}`);
  });

  it("clase de cada comprobante coherente con su denominación oficial", () => {
    for (const v of VOUCHER_TYPES.filter((x) => x.letter !== "T")) {
      const expected = v.label.startsWith("FACTURAS")
        ? "INVOICE"
        : v.label.startsWith("NOTAS DE DEBITO")
          ? "DEBIT_NOTE"
          : "CREDIT_NOTE";
      expect(v.kind, String(v.code)).toBe(expected);
      expect(v.label.endsWith(v.letter), String(v.code)).toBe(true);
    }
  });

  it("etiquetas heredadas únicas (compatibilidad con la columna `type`)", () => {
    const labels = VOUCHER_TYPES.map((v) => v.legacyLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(expect.arrayContaining(["FC A", "FC B", "FC C", "NC A"]));
  });

  it("documentos: 80 CUIT, 86 CUIL, 96 DNI, 99 sin identificar", () => {
    expect(DOCUMENT_TYPES.map((d) => d.code)).toEqual([80, 86, 96, 99]);
  });

  it("monedas: sólo PES hasta ampliar el catálogo", () => {
    expect(CURRENCIES.map((c) => c.code)).toEqual(["PES"]);
  });

  it("regla oficial compras B/C: letras exactamente B y C", () => {
    expect([...RULE_PURCHASES_BC_NO_VAT_LINES.letters]).toEqual(["B", "C"]);
  });
});
