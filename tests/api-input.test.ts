import { describe, it, expect } from "vitest";
import {
  buildTaxInput,
  buildClientInput,
  buildClientUpdateInput,
  buildPeriodInput,
  buildTurivaSettingInput,
  buildInvoiceInputV2,
  INVOICE_CONTRACT_OUTDATED_MESSAGE,
  VOUCHER_INT_MAX,
} from "@/lib/api-input";

/** Cuerpo v2 válido (forma); la matriz y los documentos se evalúan en lib/manual-invoice. */
const v2Invoice = {
  contractVersion: 2,
  category: "SALES",
  periodId: "p1",
  date: "2026-01-15",
  voucherCode: 1,
  voucherVariant: "NONE",
  pointOfSale: 1,
  number: 1001,
  counterparty: { name: "Cliente Ejemplo SRL", docType: 80, docNumber: "30-99999999-5", vatConditionCode: 1 },
  turivaRelationCode: null,
  netAmount: "1000",
  vatRate: "21",
};

describe("lib/api-input", () => {
  it("buildPeriodInput: forma válida -> ok", () => {
    const r = buildPeriodInput({ clientId: "c1", month: "5", year: "2026" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ clientId: "c1", month: 5, year: 2026 });
  });

  it("buildPeriodInput: clientId vacío / mes fuera de 1-12 / año fuera de rango -> 422 con field", () => {
    for (const [body, field] of [
      [{ month: 5, year: 2026 }, "clientId"],
      [{ clientId: "c1", month: 0, year: 2026 }, "month"],
      [{ clientId: "c1", month: 13, year: 2026 }, "month"],
      [{ clientId: "c1", month: "3.5", year: 2026 }, "month"],
      [{ clientId: "c1", month: "  ", year: 2026 }, "month"],
      [{ clientId: "c1", month: 5, year: 1999 }, "year"],
      [{ clientId: "c1", month: 5, year: 9999 }, "year"],
    ] as const) {
      const r = buildPeriodInput(body);
      expect(r.ok, JSON.stringify(body)).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(422);
        expect(r.field).toBe(field);
      }
    }
  });

  it("taxes: monto validado como string; exceso de escala rechazado", () => {
    expect(buildTaxInput({ date: "2026-01-10", type: "RETENCION IVA", amount: "25000.00", periodId: "p1" }).ok).toBe(true);
    const bad = buildTaxInput({ date: "2026-01-10", type: "RETENCION IVA", amount: "25000.005", periodId: "p1" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe("amount");
  });

  it("clients: defaultIibbRate ausente -> 3; presente inválido -> 422", () => {
    const ok = buildClientInput({ name: "X SA", cuit: "30-11111111-8", condition: "Responsable Inscripto" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.defaultIibbRate.toString()).toBe("3");

    const ok2 = buildClientInput({ name: "X SA", cuit: "30-11111111-8", condition: "Responsable Inscripto", defaultIibbRate: "3.5" });
    if (ok2.ok) expect(ok2.data.defaultIibbRate.toString()).toBe("3.5");

    const bad = buildClientInput({ name: "X SA", cuit: "30-11111111-8", condition: "Responsable Inscripto", defaultIibbRate: "101" });
    expect(bad.ok).toBe(false);
  });
});

describe("buildClientInput / buildClientUpdateInput — condición fiscal", () => {
  const base = { name: "X SA", cuit: "30-11111111-8" };

  it.each([["Responsable Inscripto"], ["Monotributo"], ["Exento"], ["  Monotributo  "]])("%s -> admitida (se guarda sin espacios)", (condition) => {
    const res = buildClientInput({ ...base, condition });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.condition).toBe(condition.trim());
    const upd = buildClientUpdateInput({ condition });
    expect(upd.ok).toBe(true);
    if (upd.ok) expect(upd.data.condition).toBe(condition.trim());
  });

  it.each([["RI"], ["responsable inscripto"], ["Monotributista"], ["Consumidor Final"], ["IVA No Alcanzado"]])("%s -> 422 condition", (condition) => {
    for (const res of [buildClientInput({ ...base, condition }), buildClientUpdateInput({ condition })]) {
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.field).toBe("condition");
        expect(res.error).toBe("condición fiscal inválida (Responsable Inscripto, Monotributo, Exento)");
      }
    }
  });
});

describe("buildInvoiceInputV2 — fecha estricta AAAA-MM-DD", () => {
  const withDate = (date: unknown) => buildInvoiceInputV2({ ...v2Invoice, date });

  it.each([["2026-05-31"], ["1999-12-31"], ["2024-02-29"], ["2000-02-29"], ["0999-01-01"]])(
    "%s válida -> medianoche UTC del MISMO día y el mismo texto AAAA-MM-DD",
    (iso) => {
      const res = withDate(iso);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.date.toISOString()).toBe(`${iso}T00:00:00.000Z`);
        expect(res.data.dateIso).toBe(iso);
      }
    },
  );

  it.each([
    ["2026-02-30", "día inexistente"],
    ["2026-02-31", "día inexistente"],
    ["2025-02-29", "29/02 de un año no bisiesto"],
    ["2100-02-29", "2100 no es bisiesto"],
    ["2026-04-31", "abril tiene 30 días"],
    ["2026-13-01", "mes inexistente"],
    ["2026-00-10", "mes cero"],
    ["2026-05-00", "día cero"],
    ["2026-05-31T23:30:00-03:00", "con hora y zona"],
    ["2026-05-31T00:00:00Z", "con hora UTC"],
    ["2026-05-31T00:00:00.000Z", "ISO completo"],
    ["2026-5-3", "sin ceros a la izquierda"],
    ["May 31 2026", "formato textual"],
    ["31/12/1999", "formato DD/MM/AAAA"],
    ["2026/05/31", "separador /"],
    [" 2026-05-31", "espacio inicial"],
    ["2026-05-31 ", "espacio final"],
    ["+002026-05-31", "año extendido"],
  ])("%s (%s) -> 422 date", (date) => {
    const res = withDate(date);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(422);
      expect(res.field).toBe("date");
      expect(res.error).toBe("fecha inválida: debe ser AAAA-MM-DD y existir en el calendario");
    }
  });

  it("fecha ausente, vacía o no-texto -> 422 date (fecha requerida)", () => {
    for (const date of [undefined, "", "   ", 20260531, null]) {
      const res = withDate(date);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.field).toBe("date");
        expect(res.error).toBe("fecha requerida");
      }
    }
  });
});

describe("buildInvoiceInputV2 — forma del contrato v2", () => {
  const v2 = {
    contractVersion: 2,
    category: "SALES",
    periodId: "p1",
    date: "2026-05-10",
    voucherCode: 1,
    voucherVariant: "NONE",
    pointOfSale: 1,
    number: 1234,
    counterparty: { name: "  Cliente SA  ", docType: 80, docNumber: " 30-99999999-5 ", vatConditionCode: 1 },
    turivaRelationCode: null,
    netAmount: "1000.00",
    vatRate: "21",
  };

  it("forma válida -> datos tipados; nombre y documento sin espacios extremos", () => {
    const r = buildInvoiceInputV2(v2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toMatchObject({
        category: "SALES",
        periodId: "p1",
        dateIso: "2026-05-10",
        voucherCode: 1,
        voucherVariant: "NONE",
        pointOfSale: 1,
        number: 1234,
        counterparty: { name: "Cliente SA", docType: 80, docNumber: "30-99999999-5", vatConditionCode: 1 },
        turivaRelationCode: null,
      });
      expect(r.data.date.toISOString()).toBe("2026-05-10T00:00:00.000Z");
      expect(r.data.netAmount.toFixed(2)).toBe("1000.00");
    }
  });

  it.each([[undefined], [1], ["2"], [null], [3], [2.5], [true]])("contractVersion %s -> 422 contractVersion", (contractVersion) => {
    const body: Record<string, unknown> = { ...v2, contractVersion };
    if (contractVersion === undefined) delete body.contractVersion;
    expect(buildInvoiceInputV2(body)).toEqual({
      ok: false,
      status: 422,
      field: "contractVersion",
      error: INVOICE_CONTRACT_OUTDATED_MESSAGE,
    });
  });

  it("el contrato anterior completo (A/B/C/T) -> 422 contractVersion", () => {
    const legacyBody = {
      date: "2026-01-15",
      pointOfSale: "1",
      number: "1001",
      entityName: "Cliente Ejemplo SRL",
      entityCuit: "30-99999999-5",
      category: "SALES",
      periodId: "p1",
      netAmount: "1000",
      vatRate: "21",
    };
    for (const type of ["FC A", "FC B", "FC C", "FC T"]) {
      expect(buildInvoiceInputV2({ ...legacyBody, type })).toMatchObject({
        ok: false,
        field: "contractVersion",
      });
    }
  });

  it("cuerpo que no es objeto -> 422 body", () => {
    for (const body of [null, 5, "x", [v2]]) expect(buildInvoiceInputV2(body)).toMatchObject({ ok: false, field: "body" });
  });

  it.each([[63], [4], [999], [0], ["1"], [1.5], [null]])("voucherCode %s fuera del catálogo o no numérico -> 422 voucherCode", (voucherCode) => {
    expect(buildInvoiceInputV2({ ...v2, voucherCode })).toMatchObject({ ok: false, field: "voucherCode" });
  });

  it("variante: NONE, PAGO_EN_CBU_INFORMADA, null o ausente; OPERACION_SUJETA_A_RETENCION y otras -> 422", () => {
    const variantOf = (v: unknown) => {
      const r = buildInvoiceInputV2({ ...v2, voucherVariant: v });
      return r.ok ? r.data.voucherVariant : r.field;
    };
    expect(variantOf("NONE")).toBe("NONE");
    expect(variantOf("PAGO_EN_CBU_INFORMADA")).toBe("PAGO_EN_CBU_INFORMADA");
    expect(variantOf(null)).toBeNull();
    expect(variantOf(undefined)).toBeNull();
    for (const bad of ["OPERACION_SUJETA_A_RETENCION", "none", "", 1]) expect(variantOf(bad)).toBe("voucherVariant");
  });

  it("contraparte: objeto requerido y cada campo con su field", () => {
    const cp = v2.counterparty;
    for (const [counterparty, field] of [
      [undefined, "counterparty"],
      [null, "counterparty"],
      [[cp], "counterparty"],
      [{ ...cp, name: "  " }, "counterpartyName"],
      [{ ...cp, docType: "80" }, "counterpartyDocType"],
      [{ ...cp, docType: 80.5 }, "counterpartyDocType"],
      [{ ...cp, docNumber: 30999999995 }, "counterpartyDocNumber"],
      [{ ...cp, docNumber: " " }, "counterpartyDocNumber"],
      [{ ...cp, vatConditionCode: 2 }, "counterpartyVatConditionCode"],
      [{ ...cp, vatConditionCode: "1" }, "counterpartyVatConditionCode"],
      [{ ...cp, vatConditionCode: undefined }, "counterpartyVatConditionCode"],
    ] as const) {
      expect(buildInvoiceInputV2({ ...v2, counterparty }), JSON.stringify(counterparty)).toMatchObject({ ok: false, field });
    }
  });

  it("turivaRelationCode: null/ausente -> null; string se conserva (la matriz lo valida); no string -> 422", () => {
    const r = buildInvoiceInputV2({ ...v2, turivaRelationCode: "0001" });
    expect(r.ok && r.data.turivaRelationCode).toBe("0001");
    // Copia del fixture SIN la clave (ausente, no presente con undefined).
    const without: Partial<typeof v2> = { ...v2 };
    delete without.turivaRelationCode;
    expect(Object.prototype.hasOwnProperty.call(without, "turivaRelationCode")).toBe(false);
    const r2 = buildInvoiceInputV2(without);
    expect(r2.ok && r2.data.turivaRelationCode).toBeNull();
    expect(buildInvoiceInputV2({ ...v2, turivaRelationCode: 1 })).toMatchObject({ ok: false, field: "turivaRelationCode" });
  });

  it("importes, alícuota, fecha, categoría y período: mismas reglas estrictas", () => {
    for (const [patch, field] of [
      [{ netAmount: "1.234" }, "netAmount"],
      [{ netAmount: 1000 }, "netAmount"],
      [{ vatRate: "150" }, "vatRate"],
      [{ date: "2026-02-30" }, "date"],
      [{ date: "2026-05-10T00:00:00Z" }, "date"],
      [{ category: "OTHER" }, "category"],
      [{ periodId: "" }, "periodId"],
    ] as const) {
      expect(buildInvoiceInputV2({ ...v2, ...patch }), JSON.stringify(patch)).toMatchObject({ ok: false, status: 422, field });
    }
  });

  it("nota de crédito: neto negativo admitido por la forma (el signo lo decide el código)", () => {
    const r = buildInvoiceInputV2({ ...v2, voucherCode: 3, netAmount: "-1000.00" });
    expect(r.ok && r.data.netAmount.toFixed(2)).toBe("-1000.00");
  });

  it("VOUCHER_INT_MAX = máximo de integer de PostgreSQL (columna Int)", () => {
    expect(VOUCHER_INT_MAX).toBe(2 ** 31 - 1);
  });

  it.each([[1], [2], [9999], [99999999], [2147483647]])("pointOfSale / number %s (entero en 1..2147483647) -> aceptado", (n) => {
    const r = buildInvoiceInputV2({ ...v2, pointOfSale: n, number: n });
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.data.pointOfSale, r.data.number]).toEqual([n, n]);
  });

  it.each([
    ["0", 0],
    ["-1", -1],
    ["-0", -0],
    ["1.5", 1.5],
    ["2147483648 (fuera de la columna Int)", 2147483648],
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["MAX_SAFE + 1", Number.MAX_SAFE_INTEGER + 1],
    ["1e21", 1e21],
    ["texto '1'", "1"],
    ["texto '0001'", "0001"],
    ["texto '1e3'", "1e3"],
    ["texto 'abc'", "abc"],
    ["null", null],
    ["true", true],
    ["ausente", undefined],
  ])("pointOfSale / number %s -> 422 con su field", (_l, value) => {
    for (const field of ["pointOfSale", "number"] as const) {
      const body: Record<string, unknown> = { ...v2, [field]: value };
      if (value === undefined) delete body[field];
      expect(buildInvoiceInputV2(body), `${field}=${String(value)}`).toMatchObject({ ok: false, status: 422, field });
    }
  });

  it("claves derivadas o ajenas del body no pasan al resultado", () => {
    const r = buildInvoiceInputV2({
      ...v2,
      clientId: "c_x",
      organizationId: "org_x",
      clientCondition: 6,
      lidSection: "TURIVA",
      source: "IMPORT",
      vatAmount: "1",
      totalAmount: "1",
      legalClass: "M",
      mandatoryLegend: "X",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const k of ["clientId", "organizationId", "clientCondition", "lidSection", "source", "vatAmount", "totalAmount", "legalClass", "mandatoryLegend"]) {
        expect(r.data).not.toHaveProperty(k);
      }
    }
  });
});

describe("buildTurivaSettingInput", () => {
  it("acepta sólo booleanos JSON", () => {
    expect(buildTurivaSettingInput({ turivaIncluded: true })).toEqual({ ok: true, data: { turivaIncluded: true } });
    expect(buildTurivaSettingInput({ turivaIncluded: false })).toEqual({ ok: true, data: { turivaIncluded: false } });
  });

  it("string, número, null o clave ausente -> 422 turivaIncluded", () => {
    for (const v of ["true", "false", 1, 0, null, undefined]) {
      const res = buildTurivaSettingInput(v === undefined ? {} : { turivaIncluded: v });
      expect(res, String(v)).toMatchObject({ ok: false, status: 422, field: "turivaIncluded" });
    }
  });

  it("cuerpo que no es objeto -> 422 body", () => {
    for (const body of [null, true, 5, "x", [true]]) {
      expect(buildTurivaSettingInput(body), JSON.stringify(body)).toMatchObject({ ok: false, status: 422, field: "body" });
    }
  });

  it("otras claves se ignoran y no pasan al resultado", () => {
    expect(buildTurivaSettingInput({ turivaIncluded: true, organizationId: "x", creditProrationMode: "GLOBAL" })).toEqual({
      ok: true,
      data: { turivaIncluded: true },
    });
  });
});
