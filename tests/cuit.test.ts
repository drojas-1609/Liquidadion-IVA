import { describe, it, expect } from "vitest";
import { normalizeCuit, cuitCheckDigit } from "@/lib/cuit";
import { buildClientInput, buildInvoiceInput } from "@/lib/api-input";

// CUIT ficticios con dígito verificador válido (sin datos reales).
const CANON = "30-11111111-8";

function expectOk(input: unknown, value: string) {
  const r = normalizeCuit(input);
  expect(r, String(input)).toEqual({ ok: true, value });
}
function expectFail(input: unknown, match: RegExp) {
  const r = normalizeCuit(input);
  expect(r.ok, String(input)).toBe(false);
  if (!r.ok) expect(r.error).toMatch(match);
}

describe("lib/cuit — normalizeCuit", () => {
  it("acepta el formato con guiones y lo devuelve canónico", () => {
    expectOk("30-11111111-8", CANON);
    expectOk("20-00000000-1", "20-00000000-1");
  });

  it("acepta 11 dígitos sin separadores", () => {
    expectOk("30111111118", CANON);
    expectOk("20000000001", "20-00000000-1");
  });

  it("acepta espacios y puntos como separadores, y trim en los extremos", () => {
    expectOk("30 11111111 8", CANON);
    expectOk("30.11111111.8", CANON);
    expectOk("30.111.111.11-8", CANON);
    expectOk("  30-11111111-8  ", CANON);
  });

  it("formatos equivalentes producen exactamente el mismo valor canónico", () => {
    const variants = ["20-00000000-1", "20000000001", "20 00000000 1", "20.00000000.1", " 20-00000000-1 "];
    const values = variants.map((v) => {
      const r = normalizeCuit(v);
      return r.ok ? r.value : `ERROR:${v}`;
    });
    expect(new Set(values)).toEqual(new Set(["20-00000000-1"]));
  });

  it("rechaza longitud menor o mayor a 11 dígitos", () => {
    expectFail("30-1", /11 dígitos/);
    expectFail("3011111111", /11 dígitos/); // 10
    expectFail("301111111180", /11 dígitos/); // 12
    expectFail("30-11111111-80", /11 dígitos/);
  });

  it("rechaza letras (no las descarta)", () => {
    expectFail("30-1111111A-8", /solo se admiten/);
    expectFail("CUIT 30111111118", /solo se admiten/);
    expectFail("30111111118x", /solo se admiten/);
  });

  it("rechaza símbolos no permitidos", () => {
    for (const s of ["30/11111111/8", "30_11111111_8", "30,11111111,8", "+30111111118", "30\t11111111\t8", "30\n11111111-8"]) {
      expectFail(s, /solo se admiten/);
    }
  });

  it("rechaza dígito verificador incorrecto", () => {
    expectFail("30-11111111-1", /verificador/);
    expectFail("20-00000000-0", /verificador/);
    // resultado 10 del módulo 11: no existe CUIT válido para esa base
    expect(cuitCheckDigit("3033333333")).toBeNull();
    for (let d = 0; d <= 9; d++) expectFail(`30-33333333-${d}`, /verificador/);
  });

  it("rechaza vacío y tipos no string", () => {
    for (const v of ["", "   ", "---", undefined, null, 30111111118, {}]) {
      expect(normalizeCuit(v).ok, String(v)).toBe(false);
    }
  });

  it("algoritmo oficial módulo 11 (pesos 5,4,3,2,7,6,5,4,3,2)", () => {
    expect(cuitCheckDigit("2000000000")).toBe(1);
    expect(cuitCheckDigit("3011111111")).toBe(8);
    expect(cuitCheckDigit("3000000000")).toBe(7);
    expect(cuitCheckDigit("3044444444")).toBe(0); // resto 11 -> 0
  });
});

describe("lib/api-input — normalización de CUIT antes de persistir", () => {
  const client = { name: "X SA", condition: "Responsable Inscripto" };

  it("buildClientInput guarda el CUIT canónico", () => {
    for (const cuit of ["30111111118", "30 11111111 8", "30.11111111.8", "30-11111111-8"]) {
      const r = buildClientInput({ ...client, cuit });
      expect(r.ok, cuit).toBe(true);
      if (r.ok) expect(r.data.cuit).toBe(CANON);
    }
  });

  it("buildClientInput rechaza CUIT inválido con 422 field=cuit", () => {
    for (const cuit of ["30-1", "30-11111111-1", "30-1111111A-8", "30/11111111/8", ""]) {
      const r = buildClientInput({ ...client, cuit });
      expect(r, cuit).toMatchObject({ ok: false, status: 422, field: "cuit" });
    }
  });

  const invoice = {
    date: "2026-01-15",
    type: "FC A",
    pointOfSale: "1",
    number: "1001",
    entityName: "Proveedor SA",
    netAmount: "1000",
    vatRate: "21",
    category: "PURCHASES",
    periodId: "p1",
  };

  it("buildInvoiceInput normaliza entityCuit", () => {
    for (const entityCuit of ["30999999995", "30 99999999 5", "30.99999999.5", "30-99999999-5"]) {
      const r = buildInvoiceInput({ ...invoice, entityCuit });
      expect(r.ok, entityCuit).toBe(true);
      if (r.ok) expect(r.data.entityCuit).toBe("30-99999999-5");
    }
  });

  it("buildInvoiceInput rechaza entityCuit inválido con 422 field=entityCuit", () => {
    for (const entityCuit of ["30-1", "30-99999999-1", "30-9999999X-5", undefined]) {
      const r = buildInvoiceInput({ ...invoice, entityCuit });
      expect(r, String(entityCuit)).toMatchObject({ ok: false, status: 422, field: "entityCuit" });
    }
  });
});
