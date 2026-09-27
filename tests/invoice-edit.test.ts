import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  CHANGED_FIELDS_ORDER,
  INVOICE_NOT_EDITABLE_MESSAGES,
  changedFieldsOf,
  invoiceDeletability,
  invoiceEditInitialState,
  invoiceEditability,
  invoiceRowActions,
  invoiceScope,
  type EditableInvoiceRow,
} from "@/lib/invoice-edit";
import { buildInvoiceInputV2 } from "@/lib/api-input";
import { resolveManualInvoice } from "@/lib/manual-invoice";

const D = (v: string) => new Prisma.Decimal(v);

/** Fila MANUAL editable: FC A de compra, 1000 al 21 %. */
const base: EditableInvoiceRow = {
  category: "PURCHASES",
  source: "MANUAL",
  voucherCode: 1,
  voucherDate: new Date("2026-05-10T00:00:00.000Z"),
  pointOfSale: 1,
  number: 1001,
  counterpartyDocType: 80,
  counterpartyDocNumber: "30999999995",
  counterpartyName: "Proveedor SA",
  counterpartyVatConditionCode: 1,
  voucherVariant: "NONE",
  turivaRelationCode: null,
  taxedNetAmount: D("1000"),
  netWithoutVatBreakdownAmount: D("0"),
  vatRateCodes: [5],
};
const row = (over: Partial<EditableInvoiceRow> = {}): EditableInvoiceRow => ({ ...base, ...over });

const body = {
  contractVersion: 2,
  category: "PURCHASES",
  periodId: "p_a",
  date: "2026-05-10",
  voucherCode: 1,
  voucherVariant: "NONE",
  pointOfSale: 1,
  number: 1001,
  counterparty: { name: "Proveedor SA", docType: 80, docNumber: "30-99999999-5", vatConditionCode: 1 },
  turivaRelationCode: null,
  netAmount: "1000",
  vatRate: "21",
};
/** Lo que el servidor normalizaría para `over` (cliente RI = condición 1). */
function after(over: Record<string, unknown> = {}) {
  const parsed = buildInvoiceInputV2({ ...body, ...over });
  if (!parsed.ok) throw new Error(parsed.error);
  const resolved = resolveManualInvoice(parsed.data, 1);
  if (!resolved.ok) throw new Error(resolved.error);
  return { input: parsed.data, resolved: resolved.data };
}

describe("invoiceScope / invoiceDeletability", () => {
  it("MANUAL con código y una línea -> ok", () => {
    expect(invoiceScope(base)).toEqual({ ok: true });
  });
  it("MANUAL sin líneas (neto sin discriminar) -> ok", () => {
    expect(invoiceScope(row({ vatRateCodes: [] }))).toEqual({ ok: true });
  });
  it.each([
    ["IMPORT", { source: "IMPORT" }, "IMPORTED"],
    ["source nulo", { source: null }, "LEGACY"],
    ["source desconocido", { source: "OTHER" }, "LEGACY"],
    ["sin código", { voucherCode: null }, "LEGACY"],
    ["dos líneas", { vatRateCodes: [5, 4] }, "MULTI_RATE"],
    ["IMPORT + sin código + dos líneas", { source: "IMPORT", voucherCode: null, vatRateCodes: [5, 4] }, "IMPORTED"],
    ["source nulo + dos líneas", { source: null, vatRateCodes: [5, 4] }, "LEGACY"],
  ] as const)("%s -> %s (precedencia IMPORTED > LEGACY > MULTI_RATE)", (_l, over, reason) => {
    expect(invoiceScope(row(over))).toEqual({ ok: false, reason });
    expect(invoiceDeletability(row(over))).toEqual({ ok: false, reason });
  });
  it("eliminabilidad NO exige datos imprescindibles", () => {
    expect(invoiceDeletability(row({ counterpartyName: null, voucherDate: null, taxedNetAmount: null }))).toEqual({ ok: true });
  });
});

describe("invoiceEditability", () => {
  it("fila completa -> ok sin campos a completar", () => {
    expect(invoiceEditability(base)).toEqual({ ok: true, requiresCounterpartyCondition: false, requiresVoucherVariant: false });
  });
  it("el alcance manda antes que los datos", () => {
    expect(invoiceEditability(row({ source: "IMPORT", counterpartyName: null }))).toEqual({ ok: false, reason: "IMPORTED" });
  });
  it.each([
    ["sin fecha", { voucherDate: null }],
    ["código fuera del catálogo", { voucherCode: 99999 }],
    ["sin tipo de documento", { counterpartyDocType: null }],
    ["sin número de documento", { counterpartyDocNumber: null }],
    ["documento en blanco", { counterpartyDocNumber: "  " }],
    ["sin nombre", { counterpartyName: null }],
    ["nombre en blanco", { counterpartyName: " " }],
    ["sin neto gravado", { taxedNetAmount: null }],
    ["sin neto sin discriminar", { netWithoutVatBreakdownAmount: null }],
    ["alícuota fuera de la tabla", { vatRateCodes: [7] }],
    ["T sin relación TurIVA", { voucherCode: 195, voucherVariant: null, turivaRelationCode: null }],
  ])("%s -> INSUFFICIENT_DATA", (_l, over) => {
    expect(invoiceEditability(row(over as Partial<EditableInvoiceRow>))).toEqual({ ok: false, reason: "INSUFFICIENT_DATA" });
  });
  it("T con relación TurIVA -> ok", () => {
    expect(invoiceEditability(row({ voucherCode: 195, voucherVariant: null, turivaRelationCode: "0001" })).ok).toBe(true);
  });
  it("excepción: condición de la contraparte nula -> requiresCounterpartyCondition", () => {
    expect(invoiceEditability(row({ counterpartyVatConditionCode: null }))).toEqual({
      ok: true,
      requiresCounterpartyCondition: true,
      requiresVoucherVariant: false,
    });
  });
  it.each([1, 2, 3])("excepción: variante nula en %i -> requiresVoucherVariant", (code) => {
    expect(invoiceEditability(row({ voucherCode: code, voucherVariant: null }))).toEqual({
      ok: true,
      requiresCounterpartyCondition: false,
      requiresVoucherVariant: true,
    });
  });
  it("variante nula fuera de 001–003 no requiere variante", () => {
    // Compra B (006) con la estructura del modelo: sin líneas.
    expect(invoiceEditability(row({ voucherCode: 6, voucherVariant: null, vatRateCodes: [] }))).toMatchObject({ ok: true, requiresVoucherVariant: false });
  });
});

describe("estructura de líneas del modelo manual (purchaseHasNoVatBreakdown)", () => {
  /** Compra B/C sin IVA discriminado, como la escribe modelFromVoucher: cero líneas, neto sin discriminar. */
  const purchaseBC = (voucherCode: 6 | 11, over: Partial<EditableInvoiceRow> = {}) =>
    row({ voucherCode, voucherVariant: null, vatRateCodes: [], taxedNetAmount: D("0"), netWithoutVatBreakdownAmount: D("500"), ...over });

  it.each([6, 11] as const)("compra %i sin líneas -> editable y alícuota inicial '0'", (code) => {
    expect(invoiceEditability(purchaseBC(code))).toEqual({ ok: true, requiresCounterpartyCondition: false, requiresVoucherVariant: false });
    const s = invoiceEditInitialState(purchaseBC(code));
    expect(s.selection.vatRate).toBe("0");
    expect(s.fields.netAmount).toBe("500.00");
  });

  it.each([
    ["compra FC A (001)", { category: "PURCHASES", voucherCode: 1 }],
    ["venta FC A (001)", { category: "SALES", voucherCode: 1 }],
    ["venta FC B (006): en ventas B sí hay línea", { category: "SALES", voucherCode: 6, voucherVariant: null }],
    ["venta T (195)", { category: "SALES", voucherCode: 195, voucherVariant: null, turivaRelationCode: "0001" }],
  ] as const)("%s sin línea -> no editable (INSUFFICIENT_DATA), pero eliminable", (_l, over) => {
    const r = row({ ...over, vatRateCodes: [] });
    expect(invoiceEditability(r)).toEqual({ ok: false, reason: "INSUFFICIENT_DATA" });
    expect(invoiceDeletability(r)).toEqual({ ok: true });
  });

  it.each([6, 11] as const)("compra %i con una línea (incompatible con el modelo) -> no editable, pero eliminable", (code) => {
    const r = purchaseBC(code, { vatRateCodes: [3] });
    expect(invoiceEditability(r)).toEqual({ ok: false, reason: "INSUFFICIENT_DATA" });
    expect(invoiceDeletability(r)).toEqual({ ok: true });
    expect(invoiceRowActions("OWNER", r)).toEqual({ canEdit: false, canDelete: true });
    expect(invoiceRowActions("ACCOUNTANT", r)).toEqual({ canEdit: false, canDelete: false });
  });

  it("categoría fuera de SALES/PURCHASES -> INSUFFICIENT_DATA (sin llamar al catálogo con datos inválidos)", () => {
    expect(invoiceEditability(row({ category: "OTRA" }))).toEqual({ ok: false, reason: "INSUFFICIENT_DATA" });
  });

  it("código fuera del catálogo con cero líneas -> INSUFFICIENT_DATA (no lanza)", () => {
    expect(invoiceEditability(row({ voucherCode: 99999, vatRateCodes: [] }))).toEqual({ ok: false, reason: "INSUFFICIENT_DATA" });
  });
});

describe("INVOICE_NOT_EDITABLE_MESSAGES", () => {
  it("un mensaje distinto y no vacío por razón", () => {
    const msgs = Object.values(INVOICE_NOT_EDITABLE_MESSAGES);
    expect(Object.keys(INVOICE_NOT_EDITABLE_MESSAGES).sort()).toEqual(["IMPORTED", "INSUFFICIENT_DATA", "LEGACY", "MULTI_RATE"]);
    expect(new Set(msgs).size).toBe(msgs.length);
    for (const m of msgs) expect(m.length).toBeGreaterThan(10);
  });
});

describe("changedFieldsOf", () => {
  it("sin cambios -> []", () => {
    expect(changedFieldsOf(base, after())).toEqual([]);
  });
  it("documento con otro formato -> [] (compara el normalizado)", () => {
    expect(changedFieldsOf(base, after({ counterparty: { ...body.counterparty, docNumber: "30 99999999 5" } }))).toEqual([]);
  });
  it("neto con otro formato decimal -> []", () => {
    expect(changedFieldsOf(base, after({ netAmount: "1000.00" }))).toEqual([]);
  });
  it("FC -> NC del mismo nominal -> exactamente voucherCode, netAmount", () => {
    expect(changedFieldsOf(base, after({ voucherCode: 3 }))).toEqual(["voucherCode", "netAmount"]);
    expect(changedFieldsOf(base, after({ voucherCode: 3, netAmount: "-1000" }))).toEqual(["voucherCode", "netAmount"]);
  });
  it("NC -> ND del mismo nominal -> voucherCode, netAmount", () => {
    expect(changedFieldsOf(row({ voucherCode: 3 }), after({ voucherCode: 2 }))).toEqual(["voucherCode", "netAmount"]);
  });
  it("FC -> ND del mismo nominal -> sólo voucherCode (mismo signo)", () => {
    expect(changedFieldsOf(base, after({ voucherCode: 2 }))).toEqual(["voucherCode"]);
  });
  it("NC con '-1000' o '1000' frente a NC guardada -> []", () => {
    const nc = row({ voucherCode: 3 });
    expect(changedFieldsOf(nc, after({ voucherCode: 3, netAmount: "-1000" }))).toEqual([]);
    expect(changedFieldsOf(nc, after({ voucherCode: 3, netAmount: "1000" }))).toEqual([]);
  });
  it("completar condición y variante nulas -> las incluye", () => {
    expect(changedFieldsOf(row({ counterpartyVatConditionCode: null, voucherVariant: null }), after())).toEqual([
      "voucherVariant",
      "counterpartyVatConditionCode",
    ]);
  });
  it("alícuota -> vatRate (sin netAmount)", () => {
    expect(changedFieldsOf(base, after({ vatRate: "10.5" }))).toEqual(["vatRate"]);
  });
  it("todos los campos comparables en orden fijo", () => {
    const before = row({
      voucherDate: new Date("2026-05-01T00:00:00.000Z"),
      voucherCode: 2,
      voucherVariant: null,
      pointOfSale: 9,
      number: 9,
      counterpartyVatConditionCode: null,
      counterpartyDocType: 86,
      counterpartyDocNumber: "20111111112",
      counterpartyName: "Otro",
      turivaRelationCode: "0001",
      taxedNetAmount: D("5"),
      vatRateCodes: [4],
    });
    expect(changedFieldsOf(before, after())).toEqual([...CHANGED_FIELDS_ORDER]);
  });
  it("nunca devuelve campos derivados", () => {
    const names = changedFieldsOf(row({ taxedNetAmount: D("5") }), after());
    expect(names).toEqual(["netAmount"]);
    for (const n of names) expect(CHANGED_FIELDS_ORDER).toContain(n);
  });
});

describe("invoiceEditInitialState — valores guardados en la forma del formulario", () => {
  it("fila completa -> selección y campos exactos (neto nominal con 2 decimales)", () => {
    expect(invoiceEditInitialState(base)).toEqual({
      selection: {
        date: "2026-05-10",
        counterpartyCondition: 1,
        voucherCode: 1,
        voucherVariant: "NONE",
        docType: 80,
        turivaRelationCode: null,
        vatRate: "21",
      },
      fields: { counterpartyName: "Proveedor SA", docNumber: "30999999995", pointOfSale: "1", number: "1001", netAmount: "1000.00" },
    });
  });

  it("NC: el neto es el nominal positivo (el signo lo da el código)", () => {
    expect(invoiceEditInitialState(row({ voucherCode: 3 })).fields.netAmount).toBe("1000.00");
  });

  it("sin líneas (compra B/C sin IVA discriminado) -> alícuota '0' y neto sin discriminar", () => {
    const s = invoiceEditInitialState(row({ voucherCode: 6, voucherVariant: null, vatRateCodes: [], taxedNetAmount: D("0"), netWithoutVatBreakdownAmount: D("500.5") }));
    expect(s.selection.vatRate).toBe("0");
    expect(s.fields.netAmount).toBe("500.50");
  });

  it("alícuota desde el código de la línea (10,5 %)", () => {
    expect(invoiceEditInitialState(row({ vatRateCodes: [4] })).selection.vatRate).toBe("10.5");
  });

  it("excepciones antiguas: condición y variante nulas quedan null (sin inferir)", () => {
    const s = invoiceEditInitialState(row({ counterpartyVatConditionCode: null, voucherVariant: null }));
    expect(s.selection.counterpartyCondition).toBeNull();
    expect(s.selection.voucherVariant).toBeNull();
  });

  it("variante fuera del catálogo -> null", () => {
    expect(invoiceEditInitialState(row({ voucherVariant: "OTRA" })).selection.voucherVariant).toBeNull();
  });

  it("T: conserva la relación TurIVA", () => {
    expect(invoiceEditInitialState(row({ voucherCode: 195, voucherVariant: null, turivaRelationCode: "0001" })).selection.turivaRelationCode).toBe("0001");
  });
});

describe("invoiceRowActions — rol + editabilidad / eliminabilidad", () => {
  it.each([
    ["OWNER", true, true],
    ["ADMIN", true, true],
    ["ACCOUNTANT", true, false],
    ["VIEWER", false, false],
  ] as const)("%s sobre fila editable -> editar %s, eliminar %s", (role, canEdit, canDelete) => {
    expect(invoiceRowActions(role, base)).toEqual({ canEdit, canDelete });
  });

  it("fila MANUAL no editable (datos insuficientes) pero eliminable -> OWNER/ADMIN sólo eliminar; ACCOUNTANT nada", () => {
    const r = row({ counterpartyName: null });
    expect(invoiceRowActions("OWNER", r)).toEqual({ canEdit: false, canDelete: true });
    expect(invoiceRowActions("ADMIN", r)).toEqual({ canEdit: false, canDelete: true });
    expect(invoiceRowActions("ACCOUNTANT", r)).toEqual({ canEdit: false, canDelete: false });
  });

  it.each([
    ["importada", { source: "IMPORT" }],
    ["heredada", { source: null }],
    ["varias alícuotas", { vatRateCodes: [5, 4] }],
  ])("fila %s -> ninguna acción para ningún rol", (_l, over) => {
    for (const role of ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] as const) {
      expect(invoiceRowActions(role, row(over as Partial<EditableInvoiceRow>))).toEqual({ canEdit: false, canDelete: false });
    }
  });

  it("excepción antigua (condición nula) sigue siendo editable", () => {
    expect(invoiceRowActions("ACCOUNTANT", row({ counterpartyVatConditionCode: null }))).toEqual({ canEdit: true, canDelete: false });
  });
});
