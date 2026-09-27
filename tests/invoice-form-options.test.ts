import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// checkCounterpartyDocument envuelto (delega en el real) para verificar que el
// formulario NUNCA lo invoca: sin número real no se valida ningún documento.
vi.mock("@/lib/arca/document-rules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/arca/document-rules")>();
  return { ...actual, checkCounterpartyDocument: vi.fn(actual.checkCounterpartyDocument) };
});
import {
  EMPTY_SELECTION,
  resolveInvoiceFormOptions,
  type InvoiceFormContext,
  type InvoiceFormSelection,
} from "@/lib/invoice-form-options";
import { VAT_CONDITIONS, VOUCHER_TYPES, VOUCHER_VARIANTS, DOCUMENT_TYPES, TURIVA_RELATIONS, type VoucherVariant } from "@/lib/arca/catalogs";
import { CODES_T, TURIVA_PARTIAL_VALIDATION_MESSAGE, checkVoucherCombination, type Direction } from "@/lib/arca/voucher-matrix";
import { allowedDocumentRule, checkCounterpartyDocument, pendingDocumentRules } from "@/lib/arca/document-rules";
import { LEGEND_OPERACION_SUJETA_A_RETENCION } from "@/lib/arca/voucher-legal-class";

const ctx = (over: Partial<InvoiceFormContext> = {}): InvoiceFormContext => ({
  direction: "SALES",
  clientConditionCode: 1,
  turivaIncluded: false,
  period: { month: 5, year: 2026 },
  ...over,
});
const sel = (over: Partial<InvoiceFormSelection> = {}): InvoiceFormSelection => ({ ...EMPTY_SELECTION, date: "2026-05-10", ...over });
const values = <T,>(opts: Array<{ value: T }>) => opts.map((o) => o.value);
const codesOf = (o: ReturnType<typeof resolveInvoiceFormOptions>) => o.notices.map((n) => n.code);

describe("frontera: módulo puro apto para el cliente", () => {
  it("sólo importa módulos puros (sin server-only, Prisma, Decimal, invoice-model ni api-input)", () => {
    const src = readFileSync(new URL("../lib/invoice-form-options.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual([
      "./arca/catalogs",
      "./arca/document-rules",
      "./arca/voucher-legal-class",
      "./arca/voucher-matrix",
      "./invoice-rules",
      "./period",
    ]);
    // Sin validación de número ni número documental embebido.
    expect(src).not.toMatch(/checkCounterpartyDocument\s*\(/);
    expect(src).not.toMatch(/["'`]\d{7,}["'`]/);
    // Y ninguno de ellos (ni lib/cuit, que usa document-rules) es server-only.
    for (const rel of ["arca/catalogs", "arca/document-rules", "arca/voucher-legal-class", "arca/voucher-matrix", "invoice-rules", "period", "cuit"]) {
      const dep = readFileSync(new URL(`../lib/${rel}.ts`, import.meta.url), "utf8");
      expect(dep, rel).not.toMatch(/^import\s+["']server-only["']/m);
      expect(dep, rel).not.toMatch(/from\s+["'](@prisma\/client|\.\.?\/(decimal|invoice-model|api-input|validation\/decimal))["']/);
    }
  });
});

describe("sin número documental: opciones y derivados no dependen de ningún número", () => {
  beforeEach(() => {
    vi.mocked(checkCounterpartyDocument).mockClear();
  });

  it("resolver opciones y derivados (incluidos CUIT País y TurIVA) nunca invoca checkCounterpartyDocument", () => {
    const cases: Array<[InvoiceFormContext, InvoiceFormSelection]> = [
      [ctx(), sel({ counterpartyCondition: 1, voucherCode: 1, voucherVariant: "NONE", docType: 80 })],
      [ctx(), sel({ counterpartyCondition: 5, voucherCode: 6, docType: 96 })],
      [ctx(), sel({ counterpartyCondition: 9, voucherCode: 19, docType: 80 })],
      [ctx({ turivaIncluded: true }), sel({ counterpartyCondition: 5, voucherCode: 195, docType: 94, turivaRelationCode: "0001" })],
      [ctx({ direction: "PURCHASES", turivaIncluded: true }), sel({ counterpartyCondition: 1, voucherCode: 197, docType: 80, turivaRelationCode: "0002" })],
    ];
    for (const [c, s] of cases) expect(resolveInvoiceFormOptions(c, s).derived).not.toBeNull();
    expect(checkCounterpartyDocument).not.toHaveBeenCalled();
  });

  it("InvoiceFormSelection no tiene número de documento", () => {
    expect(Object.keys(EMPTY_SELECTION).sort()).toEqual(
      ["counterpartyCondition", "date", "docType", "turivaRelationCode", "vatRate", "voucherCode", "voucherVariant"].sort(),
    );
  });

  it("la validación parcial proviene de la metadata de la fila documental (CUIT País) y de la matriz (TurIVA)", () => {
    const e = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 9, voucherCode: 19, docType: 80 }));
    const meta = allowedDocumentRule("SALES", 1, 9, 19, 80);
    expect(meta).toMatchObject({ cuitPais: true, partialValidation: true });
    expect(e.derived?.partialValidation).toBe(true);
    expect(e.notices.find((n) => n.code === "PARTIAL_VALIDATION")?.message).toBe(`Validación parcial del documento: ${meta?.basis}`);

    const t = resolveInvoiceFormOptions(ctx({ turivaIncluded: true }), sel({ counterpartyCondition: 9, voucherCode: 195, docType: 80, turivaRelationCode: "0001" }));
    expect(t.derived).toMatchObject({ partialValidation: true, requiresTurivaSection: true });

    const full = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 5, voucherCode: 6, docType: 96 }));
    expect(full.derived?.partialValidation).toBe(false);
    expect(codesOf(full)).not.toContain("PARTIAL_VALIDATION");
  });

  it("aviso de pendientes con los documentos de la fila o, sin código de documento, con su fundamento", () => {
    const cf = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 5, voucherCode: 6 }));
    expect(cf.notices.find((n) => n.code === "DOCUMENT_PENDING")?.message).toMatch(/99 – SIN IDENTIFICAR/);
    const exp = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 9, voucherCode: 19 }));
    expect(exp.notices.find((n) => n.code === "DOCUMENT_PENDING")?.message).toContain(pendingDocumentRules("SALES", 1, 9, 19)[0].basis);
    expect(codesOf(resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1, voucherCode: 1 })))).not.toContain("DOCUMENT_PENDING");
  });
});

describe("contexto y fecha", () => {
  it("condición del cliente no admitida -> aviso bloqueante (mensaje de la matriz) y ninguna opción", () => {
    const o = resolveInvoiceFormOptions(ctx({ clientConditionCode: null }), sel({ counterpartyCondition: 1, voucherCode: 1 }));
    expect(o.notices).toEqual([expect.objectContaining({ code: "CLIENT_CONDITION_UNSUPPORTED", level: "blocking" })]);
    expect(o.notices[0].message).toMatch(/condición fiscal del cliente/);
    expect(o.counterpartyConditions).toEqual([]);
    expect(o.selection).toEqual({ ...EMPTY_SELECTION, date: "2026-05-10" });
    expect(o.derived).toBeNull();
  });

  it("límites de fecha: ventas dentro del mes; compras sólo con máximo", () => {
    expect(resolveInvoiceFormOptions(ctx(), sel()).dateBounds).toEqual({ min: "2026-05-01", max: "2026-05-31" });
    expect(resolveInvoiceFormOptions(ctx({ direction: "PURCHASES" }), sel()).dateBounds).toEqual({ min: null, max: "2026-05-31" });
  });

  it("sin fecha: ninguna opción ni aviso; fecha inexistente o fuera del período: aviso bloqueante sin opciones", () => {
    const none = resolveInvoiceFormOptions(ctx(), sel({ date: null, counterpartyCondition: 1 }));
    expect(none.counterpartyConditions).toEqual([]);
    expect(none.notices).toEqual([]);
    expect(none.selection.counterpartyCondition).toBeNull();

    for (const date of ["2026-02-30", "2026-5-3"]) {
      expect(codesOf(resolveInvoiceFormOptions(ctx(), sel({ date })))).toEqual(["DATE_INVALID"]);
    }
    const outside = resolveInvoiceFormOptions(ctx(), sel({ date: "2026-06-01" }));
    expect(outside.notices[0]).toMatchObject({ code: "DATE_INVALID", message: "la fecha de una venta debe pertenecer al período 05/2026" });
    expect(outside.counterpartyConditions).toEqual([]);
  });

  it("compra de un período anterior: advertencia de invoice-rules y opciones calculadas con esa fecha", () => {
    const o = resolveInvoiceFormOptions(ctx({ direction: "PURCHASES" }), sel({ date: "2026-04-15" }));
    expect(o.notices).toContainEqual(expect.objectContaining({ code: "PURCHASE_PRIOR_PERIOD", level: "warning" }));
    expect(o.counterpartyConditions.length).toBeGreaterThan(0);
  });
});

describe("opciones por paso", () => {
  it("condiciones de la contraparte: sólo las que admiten algún comprobante; 8 y 10 nunca; etiquetas del catálogo", () => {
    const o = resolveInvoiceFormOptions(ctx(), sel());
    expect(values(o.counterpartyConditions)).toEqual([1, 4, 5, 6, 7, 9, 13, 15, 16]);
    for (const opt of o.counterpartyConditions) {
      expect(opt.label).toBe(VAT_CONDITIONS.find((c) => c.code === opt.value)?.label);
    }
  });

  it("comprobantes: etiqueta del catálogo con código de 3 dígitos; 063 nunca", () => {
    const o = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1 }));
    expect(values(o.voucherCodes)).toEqual([1, 2, 3, 51, 52, 53]);
    expect(o.voucherCodes[0].label).toBe(`001 – ${VOUCHER_TYPES[0].label}`);
    expect(values(o.voucherCodes)).not.toContain(63);
  });

  it("195–197: excluidos si el período no está incluido en TurIVA (con aviso); ofrecidos si lo está", () => {
    const off = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 5 }));
    expect(values(off.voucherCodes)).toEqual([6, 7, 8]);
    expect(codesOf(off)).toContain("TURIVA_NOT_INCLUDED");

    const on = resolveInvoiceFormOptions(ctx({ turivaIncluded: true }), sel({ counterpartyCondition: 5 }));
    expect(values(on.voucherCodes)).toEqual([6, 7, 8, 195, 196, 197]);
    expect(codesOf(on)).not.toContain("TURIVA_NOT_INCLUDED");

    // Contraparte sin T posible: sin aviso TurIVA.
    expect(codesOf(resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 6 })))).not.toContain("TURIVA_NOT_INCLUDED");
  });

  it("195–197 no se ofrecen antes del 01/04/2017 aunque TurIVA esté incluido", () => {
    const o = resolveInvoiceFormOptions(ctx({ direction: "PURCHASES", turivaIncluded: true }), sel({ date: "2017-03-31", counterpartyCondition: 1 }));
    expect(values(o.voucherCodes).some((c) => (CODES_T as readonly number[]).includes(c))).toBe(false);
    const later = resolveInvoiceFormOptions(ctx({ direction: "PURCHASES", turivaIncluded: true }), sel({ date: "2017-04-01", counterpartyCondition: 1 }));
    expect(values(later.voucherCodes)).toEqual(expect.arrayContaining([195, 196, 197]));
  });

  it("combinaciones PENDING no se ofrecen y se explican con el mensaje de la matriz", () => {
    const o = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 9 }));
    expect(values(o.voucherCodes)).toEqual([19, 20, 21]);
    const notice = o.notices.find((n) => n.code === "VOUCHER_PENDING");
    expect(notice?.message).toMatch(/pendiente de confirmación normativa/);
    expect(notice?.message).toMatch(/006 – FACTURAS B/);
  });

  it("documentos: consumidor final sin 99 (pendiente, con aviso); etiquetas del catálogo", () => {
    const o = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 5, voucherCode: 6 }));
    expect(values(o.docTypes)).toEqual([80, 86, 91, 94, 96]);
    expect(o.docTypes[0].label).toBe(`80 – ${DOCUMENT_TYPES.find((d) => d.code === 80)?.label}`);
    const notice = o.notices.find((n) => n.code === "DOCUMENT_PENDING");
    expect(notice?.message).toMatch(/99 – SIN IDENTIFICAR/);
  });

  it("documentos: 87 nunca se ofrece", () => {
    for (const [cp, code] of [[5, 6], [1, 1], [9, 19]]) {
      expect(values(resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: cp, voucherCode: code })).docTypes)).not.toContain(87);
    }
  });

  it("variantes: A en 2026 -> NONE y CBU sin preselección; etiquetas del catálogo", () => {
    const o = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1, voucherCode: 1 }));
    expect(values(o.variants)).toEqual(["NONE", "PAGO_EN_CBU_INFORMADA"]);
    expect(o.variants.map((v) => v.label)).toEqual(VOUCHER_VARIANTS.map((v) => v.label));
    expect(o.selection.voucherVariant).toBeNull();
  });

  it("variantes: única válida (compra A de 06/2020) -> preseleccionada; OPERACION_SUJETA_A_RETENCION nunca", () => {
    const o = resolveInvoiceFormOptions(ctx({ direction: "PURCHASES" }), sel({ date: "2020-06-10", counterpartyCondition: 1, voucherCode: 1 }));
    expect(values(o.variants)).toEqual(["NONE"]);
    expect(o.selection.voucherVariant).toBe("NONE");
    const forced = resolveInvoiceFormOptions(
      ctx({ direction: "PURCHASES" }),
      sel({ date: "2020-06-10", counterpartyCondition: 1, voucherCode: 1, voucherVariant: "PAGO_EN_CBU_INFORMADA" }),
    );
    expect(forced.selection.voucherVariant).toBe("NONE");
    expect(values(o.variants)).not.toContain("OPERACION_SUJETA_A_RETENCION");
  });

  it("variante se recalcula al cambiar una selección anterior (fecha o comprobante)", () => {
    const c = ctx({ direction: "PURCHASES" });
    const first = resolveInvoiceFormOptions(c, sel({ date: "2020-06-10", counterpartyCondition: 1, voucherCode: 1 }));
    expect(first.selection.voucherVariant).toBe("NONE");
    // Otra fecha con dos variantes: la preseleccionada sigue siendo válida y se conserva.
    const later = resolveInvoiceFormOptions(c, { ...first.selection, date: "2026-05-10" });
    expect(values(later.variants)).toEqual(["NONE", "PAGO_EN_CBU_INFORMADA"]);
    expect(later.selection.voucherVariant).toBe("NONE");
    // Otro comprobante sin variante: se descarta.
    const m = resolveInvoiceFormOptions(c, { ...later.selection, voucherCode: 51 });
    expect(m.variants).toEqual([]);
    expect(m.selection.voucherVariant).toBeNull();
  });

  it("no preselecciona documento, relación TurIVA ni alícuota aunque haya una sola opción", () => {
    const o = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1, voucherCode: 1 }));
    expect(values(o.docTypes)).toEqual([80]);
    expect(o.selection.docType).toBeNull();
    const b = resolveInvoiceFormOptions(ctx({ direction: "PURCHASES", clientConditionCode: 4 }), sel({ counterpartyCondition: 1, voucherCode: 6 }));
    expect(values(b.vatRates)).toEqual(["0"]);
    expect(b.selection.vatRate).toBeNull();
    const t = resolveInvoiceFormOptions(ctx({ direction: "PURCHASES", turivaIncluded: true }), sel({ counterpartyCondition: 1, voucherCode: 195 }));
    expect(t.selection.turivaRelationCode).toBeNull();
  });

  it("relaciones TurIVA filtradas por emisor/receptor con etiquetas del catálogo", () => {
    const toCf = resolveInvoiceFormOptions(ctx({ turivaIncluded: true }), sel({ counterpartyCondition: 5, voucherCode: 195 }));
    expect(values(toCf.turivaRelations)).toEqual(["0001", "0003", "0004", "0005"]);
    expect(toCf.turivaRelations[0].label).toBe(`0001 – ${TURIVA_RELATIONS[0].label}`);
    const toRi = resolveInvoiceFormOptions(ctx({ turivaIncluded: true }), sel({ counterpartyCondition: 1, voucherCode: 196 }));
    expect(values(toRi.turivaRelations)).toEqual(["0002", "0006"]);
    const purchase = resolveInvoiceFormOptions(ctx({ direction: "PURCHASES", turivaIncluded: true }), sel({ counterpartyCondition: 1, voucherCode: 197 }));
    expect(values(purchase.turivaRelations)).toEqual(["0002", "0006"]);
    // Código no T: sin relaciones y la elegida se descarta.
    const a = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1, voucherCode: 1, turivaRelationCode: "0002" }));
    expect(a.turivaRelations).toEqual([]);
    expect(a.selection.turivaRelationCode).toBeNull();
  });

  it("alícuotas: compras B/C sólo 0; ventas B y compras A todas las de la tabla", () => {
    const purchC = resolveInvoiceFormOptions(ctx({ direction: "PURCHASES" }), sel({ counterpartyCondition: 6, voucherCode: 11, vatRate: "21" }));
    expect(values(purchC.vatRates)).toEqual(["0"]);
    expect(purchC.selection.vatRate).toBeNull();
    const all = ["0", "10.5", "21", "27", "5", "2.5"];
    expect(values(resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 5, voucherCode: 6 })).vatRates)).toEqual(all);
    expect(values(resolveInvoiceFormOptions(ctx({ direction: "PURCHASES" }), sel({ counterpartyCondition: 1, voucherCode: 1 })).vatRates)).toEqual(all);
  });
});

describe("derivados", () => {
  it("null hasta completar documento, variante (001–003) y relación (195–197)", () => {
    const c = ctx({ turivaIncluded: true });
    expect(resolveInvoiceFormOptions(c, sel({ counterpartyCondition: 1, voucherCode: 1 })).derived).toBeNull();
    expect(resolveInvoiceFormOptions(c, sel({ counterpartyCondition: 1, voucherCode: 1, docType: 80 })).derived).toBeNull();
    expect(resolveInvoiceFormOptions(c, sel({ counterpartyCondition: 1, voucherCode: 1, voucherVariant: "NONE" })).derived).toBeNull();
    expect(resolveInvoiceFormOptions(c, sel({ counterpartyCondition: 1, voucherCode: 1, voucherVariant: "NONE", docType: 80 })).derived).toEqual({
      legalClass: "A",
      mandatoryLegend: null,
      partialValidation: false,
      requiresTurivaSection: false,
    });
    expect(resolveInvoiceFormOptions(c, sel({ counterpartyCondition: 5, voucherCode: 195, docType: 94 })).derived).toBeNull();
    const t = resolveInvoiceFormOptions(c, sel({ counterpartyCondition: 5, voucherCode: 195, docType: 94, turivaRelationCode: "0001" }));
    expect(t.derived).toEqual({ legalClass: "T", mandatoryLegend: null, partialValidation: true, requiresTurivaSection: true });
    expect(t.notices).toContainEqual(expect.objectContaining({ code: "PARTIAL_VALIDATION", message: TURIVA_PARTIAL_VALIDATION_MESSAGE }));
  });

  it("051 desde 01/12/2025: clase jurídica A con leyenda derivada", () => {
    const o = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1, voucherCode: 51, docType: 80 }));
    expect(o.derived).toMatchObject({ legalClass: "A", mandatoryLegend: LEGEND_OPERACION_SUJETA_A_RETENCION });
  });

  it("exportación con CUIT País: validación parcial explicada con el fundamento de la regla documental", () => {
    const o = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 9, voucherCode: 19, docType: 80 }));
    expect(o.derived).toMatchObject({ legalClass: "E", partialValidation: true, requiresTurivaSection: false });
    expect(o.notices.find((n) => n.code === "PARTIAL_VALIDATION")?.message).toMatch(/CUIT País/);
  });
});

describe("normalización", () => {
  it("cambio de contraparte descarta comprobante, documento, variante, relación y alícuota que dejan de valer", () => {
    const full = resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1, voucherCode: 1, voucherVariant: "NONE", docType: 80, vatRate: "21" }));
    expect(full.derived).not.toBeNull();
    const changed = resolveInvoiceFormOptions(ctx(), { ...full.selection, counterpartyCondition: 5 });
    expect(changed.selection).toEqual({ ...EMPTY_SELECTION, date: "2026-05-10", counterpartyCondition: 5 });
    expect(changed.derived).toBeNull();
  });

  it("valores fuera de las opciones (063, 87, 99, condición 8, variante no válida) se descartan", () => {
    expect(resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 8 })).selection.counterpartyCondition).toBeNull();
    expect(resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1, voucherCode: 63 })).selection.voucherCode).toBeNull();
    for (const docType of [87, 99]) {
      expect(resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 5, voucherCode: 6, docType })).selection.docType).toBeNull();
    }
    expect(
      resolveInvoiceFormOptions(ctx(), sel({ counterpartyCondition: 1, voucherCode: 1, voucherVariant: "OPERACION_SUJETA_A_RETENCION" as VoucherVariant }))
        .selection.voucherVariant,
    ).toBeNull();
  });

  it("determinista e idempotente: resolver el resultado otra vez devuelve exactamente lo mismo", () => {
    const inputs: Array<[InvoiceFormContext, InvoiceFormSelection]> = [
      [ctx(), sel()],
      [ctx(), sel({ counterpartyCondition: 1, voucherCode: 1, voucherVariant: "PAGO_EN_CBU_INFORMADA", docType: 80, vatRate: "21" })],
      [ctx({ direction: "PURCHASES" }), sel({ date: "2020-06-10", counterpartyCondition: 1, voucherCode: 1, docType: 96 })],
      [ctx({ turivaIncluded: true }), sel({ counterpartyCondition: 5, voucherCode: 195, docType: 94, turivaRelationCode: "0002" })],
      [ctx({ clientConditionCode: null }), sel({ counterpartyCondition: 1 })],
      [ctx(), sel({ date: "2026-02-30", counterpartyCondition: 1 })],
      [ctx(), sel({ counterpartyCondition: 8, voucherCode: 63, docType: 87 })],
    ];
    for (const [c, s] of inputs) {
      const once = resolveInvoiceFormOptions(c, s);
      const twice = resolveInvoiceFormOptions(c, once.selection);
      expect(twice).toEqual(once);
      expect(resolveInvoiceFormOptions(c, s)).toEqual(once); // misma entrada, mismo resultado
    }
  });
});

describe("barrido de coherencia con la autoridad (matriz + documentos)", () => {
  const DATES = ["2015-06-10", "2017-03-31", "2019-11-20", "2021-03-10", "2022-08-01", "2026-05-10"];
  const DIRECTIONS: Direction[] = ["SALES", "PURCHASES"];
  const CLIENTS = [1, 4, 6];
  // Números reales de prueba por formato: sólo para consultar a la AUTORIDAD
  // (checkCounterpartyDocument) en el test; el formulario no usa ninguno.
  const REAL: Record<number, string> = { 80: "30999999995", 86: "20123456786", 91: "AB12345", 94: "P1234567", 96: "12345678", 99: "0" };
  const isT = (c: number) => (CODES_T as readonly number[]).includes(c);
  const periodOf = (d: string) => ({ year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) });

  const authorityAccepts = (c: InvoiceFormContext, s: InvoiceFormSelection) =>
    checkVoucherCombination({
      direction: c.direction,
      clientCondition: c.clientConditionCode,
      counterpartyCondition: s.counterpartyCondition,
      voucherCode: s.voucherCode as number,
      dateIso: s.date as string,
      voucherVariant: s.voucherVariant,
      turivaRelationCode: s.turivaRelationCode,
      counterpartyDocType: s.docType,
    }).ok &&
    checkCounterpartyDocument({
      direction: c.direction,
      clientCondition: c.clientConditionCode,
      counterpartyCondition: s.counterpartyCondition,
      voucherCode: s.voucherCode as number,
      docType: s.docType as number,
      docNumber: REAL[s.docType as number],
    }).ok;

  it("todo lo que el formulario ofrece lo acepta la autoridad (nunca PENDING, nunca rechazado)", () => {
    let offered = 0;
    for (const direction of DIRECTIONS) for (const client of CLIENTS) for (const date of DATES) for (const turivaIncluded of [false, true]) {
      const c = ctx({ direction, clientConditionCode: client, turivaIncluded, period: periodOf(date) });
      const base = resolveInvoiceFormOptions(c, sel({ date }));
      for (const cp of values(base.counterpartyConditions)) {
        for (const code of values(resolveInvoiceFormOptions(c, sel({ date, counterpartyCondition: cp })).voucherCodes)) {
          if (!turivaIncluded) expect(isT(code)).toBe(false);
          const step = resolveInvoiceFormOptions(c, sel({ date, counterpartyCondition: cp, voucherCode: code }));
          const variants = step.variants.length ? values(step.variants) : [null];
          const relations = step.turivaRelations.length ? values(step.turivaRelations) : [null];
          for (const docType of values(step.docTypes)) for (const voucherVariant of variants) for (const turivaRelationCode of relations) {
            for (const vatRate of values(step.vatRates)) {
              const s = sel({ date, counterpartyCondition: cp, voucherCode: code, docType, voucherVariant, turivaRelationCode, vatRate });
              const r = resolveInvoiceFormOptions(c, s);
              const tag = JSON.stringify({ direction, client, ...s });
              expect(r.selection, tag).toEqual(s);
              expect(r.derived, tag).not.toBeNull();
              expect(authorityAccepts(c, s), tag).toBe(true);
              offered++;
            }
          }
        }
      }
    }
    expect(offered).toBeGreaterThan(1000);
  });

  it("todo lo que la autoridad acepta se ofrece (salvo 195–197 con el período fuera de TurIVA)", () => {
    let accepted = 0;
    for (const direction of DIRECTIONS) for (const client of CLIENTS) for (const date of DATES) for (const turivaIncluded of [false, true]) {
      const c = ctx({ direction, clientConditionCode: client, turivaIncluded, period: periodOf(date) });
      for (const cp of VAT_CONDITIONS.map((v) => v.code)) for (const vt of VOUCHER_TYPES) {
        const variants: (VoucherVariant | null)[] = vt.letter === "A" ? ["NONE", "PAGO_EN_CBU_INFORMADA"] : [null];
        const relations: (string | null)[] = isT(vt.code) ? TURIVA_RELATIONS.map((r) => r.code) : [null];
        for (const voucherVariant of variants) for (const turivaRelationCode of relations) for (const d of DOCUMENT_TYPES) {
          const s = sel({ date, counterpartyCondition: cp, voucherCode: vt.code, voucherVariant, turivaRelationCode, docType: d.code, vatRate: "0" });
          if (!authorityAccepts(c, s)) continue;
          accepted++;
          const r = resolveInvoiceFormOptions(c, s);
          const tag = JSON.stringify({ direction, client, turivaIncluded, ...s });
          if (isT(vt.code) && !turivaIncluded) {
            expect(r.selection.voucherCode, tag).toBeNull();
          } else {
            expect(r.selection, tag).toEqual(s);
            expect(r.derived, tag).not.toBeNull();
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(1000);
  });
});
