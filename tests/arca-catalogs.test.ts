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
  VAT_CONDITIONS,
  TURIVA_RELATIONS,
  VOUCHER_VARIANTS,
  SOURCE_TIPOS_RESPONSABLES,
  SOURCE_ARCA_COMPROBANTES,
  SOURCE_RG_1415,
  SOURCE_RG_5003,
  SOURCE_RG_1575,
  SOURCE_RG_4627,
  SOURCE_RG_5762,
  SOURCE_RGC_3971,
  SOURCE_DEC_1043,
  SOURCE_TURIVA_F8089,
  SOURCE_LEY_26565,
  SOURCE_MONOTRIBUTO_PROMOVIDO,
  SOURCE_FE_TABLA_COMPROBANTES,
  type OfficialSource,
} from "@/lib/arca/catalogs";

const OFFICIAL_HOSTS = new Set(["www.arca.gob.ar", "www.afip.gob.ar", "biblioteca.afip.gob.ar"]);

function expectOfficial(source: OfficialSource, what: string) {
  const url = new URL(source.url);
  expect(url.protocol, what).toBe("https:");
  expect(OFFICIAL_HOSTS.has(url.host), `${what}: ${url.host}`).toBe(true);
  expect(source.retrievedAt, what).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(source.document.length, what).toBeGreaterThan(10);
}

describe("lib/arca/catalogs — fuentes oficiales", () => {
  it("toda entrada y regla registra documento, URL oficial de ARCA y fecha de consulta", () => {
    for (const e of [...VAT_RATES, ...VOUCHER_TYPES, ...DOCUMENT_TYPES, ...CURRENCIES, ...VAT_CONDITIONS, ...TURIVA_RELATIONS]) {
      expectOfficial(e.source, `código ${String(e.code)}`);
    }
    for (const v of VOUCHER_VARIANTS) {
      expect(v.sources.length, v.code).toBeGreaterThan(0);
      for (const s of v.sources) expectOfficial(s, `variante ${v.code}`);
    }
    for (const s of [
      SOURCE_TIPOS_RESPONSABLES, SOURCE_ARCA_COMPROBANTES, SOURCE_RG_1415, SOURCE_RG_5003, SOURCE_RG_1575,
      SOURCE_RG_4627, SOURCE_RG_5762, SOURCE_RGC_3971, SOURCE_DEC_1043, SOURCE_TURIVA_F8089, SOURCE_LEY_26565,
      SOURCE_MONOTRIBUTO_PROMOVIDO, SOURCE_FE_TABLA_COMPROBANTES,
    ]) {
      expectOfficial(s, s.document);
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
      ["condiciones", VAT_CONDITIONS],
      ["relaciones TurIVA", TURIVA_RELATIONS],
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

  it("comprobantes: 001–003, 006–008, 011–013, 019–021, 051–053 y clase T 195–197 (sin FCE, 063 ni otros no verificados)", () => {
    expect(VOUCHER_TYPES.map((v) => v.code)).toEqual([1, 2, 3, 6, 7, 8, 11, 12, 13, 19, 20, 21, 51, 52, 53, 195, 196, 197]);
    for (const v of VOUCHER_TYPES) {
      expect(["A", "B", "C", "E", "M", "T"]).toContain(v.letter);
      expect(["INVOICE", "DEBIT_NOTE", "CREDIT_NOTE"]).toContain(v.kind);
    }
    for (const v of VOUCHER_TYPES.filter((x) => ["A", "B", "C", "M"].includes(x.letter))) {
      expect(v.label).toMatch(/^(FACTURAS|NOTAS DE DEBITO|NOTAS DE CREDITO) [ABCM]$/);
    }
    expect(VOUCHER_TYPES.map((v) => v.code)).not.toContain(63);
  });

  it("019–021 y 051–053: denominación técnica literal de la Tabla 3 y SIN etiqueta heredada", () => {
    const pick = (codes: number[]) => VOUCHER_TYPES.filter((v) => codes.includes(v.code)).map((v) => [v.code, v.letter, v.kind, v.label, v.legacyLabel]);
    expect(pick([19, 20, 21])).toEqual([
      [19, "E", "INVOICE", "FACTURAS DE EXPORTACION", null],
      [20, "E", "DEBIT_NOTE", "NOTAS DE DEBITO POR OPERACIONES CON EL EXTERIOR", null],
      [21, "E", "CREDIT_NOTE", "NOTAS DE CREDITO POR OPERACIONES CON EL EXTERIOR", null],
    ]);
    expect(pick([51, 52, 53])).toEqual([
      [51, "M", "INVOICE", "FACTURAS M", null],
      [52, "M", "DEBIT_NOTE", "NOTAS DE DEBITO M", null],
      [53, "M", "CREDIT_NOTE", "NOTAS DE CREDITO M", null],
    ]);
    // Los códigos admitidos por el contrato anterior conservan su etiqueta.
    for (const v of VOUCHER_TYPES.filter((x) => ["A", "B", "C", "T"].includes(x.letter))) {
      expect(typeof v.legacyLabel, String(v.code)).toBe("string");
    }
  });

  it("documentos: incluye 91 C I EXTRANJERA y 94 PASAPORTE (Tabla Tipo de Documento)", () => {
    expect(DOCUMENT_TYPES.map((d) => d.code)).toEqual([80, 86, 91, 94, 96, 99]);
    expect(DOCUMENT_TYPES.find((d) => d.code === 91)?.label).toBe("C I EXTRANJERA");
    expect(DOCUMENT_TYPES.find((d) => d.code === 94)?.label).toBe("PASAPORTE");
  });

  it("condiciones frente al IVA: tabla oficial exacta (11 códigos, descripciones literales)", () => {
    expect(VAT_CONDITIONS.map((c) => [c.code, c.label])).toEqual([
      [1, "IVA Responsable Inscripto"],
      [4, "IVA Sujeto Exento"],
      [5, "Consumidor Final"],
      [6, "Responsable Monotributo"],
      [7, "Sujeto no Categorizado"],
      [8, "Proveedor del Exterior"],
      [9, "Cliente del Exterior"],
      [10, "IVA Liberado – Ley Nº 19.640"],
      [13, "Monotributista Social"],
      [15, "IVA No Alcanzado"],
      [16, "Monotributo Trabajador Independiente Promovido"],
    ]);
  });

  it("relaciones TurIVA 0001–0006 como texto de 4 caracteres (conserva ceros)", () => {
    expect(TURIVA_RELATIONS.map((r) => r.code)).toEqual(["0001", "0002", "0003", "0004", "0005", "0006"]);
    for (const r of TURIVA_RELATIONS) expect(r.code).toMatch(/^\d{4}$/);
    expect(TURIVA_RELATIONS.find((r) => r.code === "0006")?.label).toBe("Agencia de Viaje Residente a Agencia de Viaje Residente");
  });

  it("variantes: dominio inicial NONE y PAGO_EN_CBU_INFORMADA; la leyenda de retención NO integra el dominio", () => {
    expect(VOUCHER_VARIANTS.map((v) => v.code)).toEqual(["NONE", "PAGO_EN_CBU_INFORMADA"]);
    expect(JSON.stringify(VOUCHER_VARIANTS)).not.toMatch(/OPERACION_SUJETA_A_RETENCION/);
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
      // 019–021 (clase E) tienen denominaciones oficiales que no terminan en la letra.
      if (["A", "B", "C", "M"].includes(v.letter)) expect(v.label.endsWith(v.letter), String(v.code)).toBe(true);
    }
  });

  it("etiquetas heredadas únicas (compatibilidad con la columna `type`)", () => {
    // Sólo las etiquetas no nulas son resolubles; NULL marca códigos fuera del contrato anterior.
    const labels = VOUCHER_TYPES.map((v) => v.legacyLabel).filter((l): l is string => l !== null);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(expect.arrayContaining(["FC A", "FC B", "FC C", "NC A"]));
  });

  it("monedas: sólo PES hasta ampliar el catálogo", () => {
    expect(CURRENCIES.map((c) => c.code)).toEqual(["PES"]);
  });

  it("regla oficial compras B/C: letras exactamente B y C", () => {
    expect([...RULE_PURCHASES_BC_NO_VAT_LINES.letters]).toEqual(["B", "C"]);
  });
});
