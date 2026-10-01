import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  claims: { throw: null as unknown, value: null as unknown },
  db: { current: null as unknown },
}));
vi.mock("@/lib/auth/claims", () => ({
  getAuthClaims: async () => {
    if (H.claims.throw) throw H.claims.throw;
    return H.claims.value;
  },
}));
vi.mock("@/lib/prisma", () => ({
  get default() {
    return H.db.current;
  },
}));

import { Prisma } from "@prisma/client";
import { freshDbMock, freshRecorder, wireDb, makeWorld, claimsFor, SUB_OWNER_A, ORG_A, type World } from "./api/_harness";
import { PATCH, DELETE } from "@/app/api/invoices/[id]/route";
import { PATCH as PATCH_VAT_SETTINGS } from "@/app/api/periods/[id]/vat-settings/route";
import { buildInvoiceInputV2 } from "@/lib/api-input";
import { resolveManualInvoice } from "@/lib/manual-invoice";
import { clientConditionCode } from "@/lib/client-condition";
import { manualInvoiceColumns, manualInvoiceVatLines } from "@/lib/invoice-write";
import { computeLiquidation, type LiquidationResult } from "@/lib/liquidation-calc";

/**
 * Bloque 4: recálculo tras PATCH / DELETE REALES de /api/invoices/[id] sobre el
 * harness. Las filas y líneas que se liquidan son las que dejaron las rutas en
 * el mundo en memoria (world.invoices / world.invoiceVatLines), leídas como las
 * lee la pantalla de liquidación (período + comprobantes con sus líneas).
 *
 * LIMITACIÓN: sin base real ni locks. `$queryRaw` sólo registra los bloqueos;
 * la secuencia entre rutas es secuencial (no concurrente).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

const T0 = "2026-05-11T10:00:00.000Z";

const RI = { name: "Contraparte SA", docType: 80, docNumber: "30-99999999-5", vatConditionCode: 1 };
// Fixtures ya validados en tests/api/invoices-post.test.ts.
const purchaseA = {
  contractVersion: 2,
  category: "PURCHASES",
  periodId: "p_a",
  date: "2026-05-10",
  voucherCode: 1,
  voucherVariant: "NONE",
  pointOfSale: 1,
  number: 2001,
  counterparty: RI,
  turivaRelationCode: null,
  netAmount: "500",
  vatRate: "21",
};
const saleA = { ...purchaseA, category: "SALES", number: 1001, netAmount: "1000" };
const saleT = {
  ...saleA,
  voucherCode: 195,
  voucherVariant: null,
  turivaRelationCode: "0001",
  counterparty: { name: "Tourist", docType: 94, docNumber: "ab123456", vatConditionCode: 5 },
};
/** Compra C de un Monotributo (cliente RI). */
const purchaseC = { ...purchaseA, voucherCode: 11, voucherVariant: null, vatRate: "0", counterparty: { ...RI, vatConditionCode: 6 } };
/** Compra B de un RI a un cliente Exento. */
const purchaseB = { ...purchaseA, voucherCode: 6, voucherVariant: null, vatRate: "0" };

/** Fila MANUAL como la escribe el alta (mismos helpers de lib/invoice-write). */
function stored(id: string, body: Record<string, unknown>, clientCondition = "Responsable Inscripto") {
  const parsed = buildInvoiceInputV2(body);
  if (!parsed.ok) throw new Error(`fixture inválido: ${parsed.error}`);
  const resolved = resolveManualInvoice(parsed.data, clientConditionCode(clientCondition));
  if (!resolved.ok) throw new Error(`fixture inválido: ${resolved.error}`);
  const cols = manualInvoiceColumns({ input: parsed.data, resolved: resolved.data, periodId: "p_a", organizationId: ORG_A, clientId: "c_a" });
  const row = { id, ...cols, createdById: SUB_OWNER_A, updatedById: SUB_OWNER_A, createdAt: new Date(T0), updatedAt: new Date(T0) };
  const lines = manualInvoiceVatLines(resolved.data.model).map((l, n) => ({ id: `${id}_vl${n}`, invoiceId: id, organizationId: ORG_A, ...l }));
  return { row, lines };
}

const setWorld = (rows: Array<ReturnType<typeof stored>>, opts: { clientCondition?: string; turivaIncluded?: boolean } = {}) => {
  world = makeWorld({
    invoices: rows.map((r) => r.row),
    invoiceVatLines: rows.flatMap((r) => r.lines),
    vatSettings:
      opts.turivaIncluded === undefined
        ? []
        : [{ periodId: "p_a", organizationId: ORG_A, turivaIncluded: opts.turivaIncluded, creditProrationMode: "NONE", globalCoefficient: null, globalCoefficientStatus: null }],
  });
  if (opts.clientCondition) world.clients[0].condition = opts.clientCondition;
  wireDb(db, world, rec);
};

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

// ── Rutas reales ─────────────────────────────────────────────────────────

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const tokenOf = (id: string) => (world.invoices ?? []).find((i) => i.id === id)!.updatedAt.toISOString();
const patchInvoice = (id: string, body: Record<string, unknown>, expectedUpdatedAt = tokenOf(id)) =>
  PATCH(new Request(`http://localhost/api/invoices/${id}`, { method: "PATCH", body: JSON.stringify({ ...body, expectedUpdatedAt }) }), ctx(id));
const deleteInvoice = (id: string, expectedUpdatedAt = tokenOf(id)) =>
  DELETE(
    new Request(`http://localhost/api/invoices/${id}?expectedUpdatedAt=${encodeURIComponent(expectedUpdatedAt)}`, { method: "DELETE" }),
    ctx(id),
  );
const setTuriva = (turivaIncluded: boolean) =>
  PATCH_VAT_SETTINGS(new Request("http://localhost/api/periods/p_a/vat-settings", { method: "PATCH", body: JSON.stringify({ turivaIncluded }) }), ctx("p_a"));

// ── Liquidación sobre el estado MUTADO por las rutas ─────────────────────

/** Como la pantalla de liquidación: comprobantes del período con sus líneas, cliente y configuración. */
function periodFromWorld(legacyOnly = false) {
  return {
    invoices: (world.invoices ?? [])
      .filter((i) => i.periodId === "p_a" && i.organizationId === ORG_A)
      .map((i) => ({
        ...i,
        // Paridad: sin código oficial la fila se liquida por sus columnas heredadas.
        ...(legacyOnly ? { voucherCode: null } : {}),
        vatLines: (world.invoiceVatLines ?? []).filter((l) => l.invoiceId === i.id && l.organizationId === i.organizationId),
      })),
    taxRecords: [],
    client: { defaultIibbRate: world.clients[0].defaultIibbRate },
    vatSettings: (world.vatSettings ?? []).find((s) => s.periodId === "p_a") ?? null,
  };
}
const money = (r: LiquidationResult) => ({
  salesNet: r.sales.net.toFixed(2),
  salesVat: r.sales.vat.toFixed(2),
  salesTotal: r.sales.total.toFixed(2),
  purchasesNet: r.purchases.net.toFixed(2),
  purchasesVat: r.purchases.vat.toFixed(2),
  purchasesTotal: r.purchases.total.toFixed(2),
  debit: r.iva.debit.toFixed(2),
  credit: r.iva.credit.toFixed(2),
  balance: r.iva.balance.toFixed(2),
  iibbBase: r.iibb.base.toFixed(2),
  iibbTax: r.iibb.tax.toFixed(2),
});
const liquidate = () => money(computeLiquidation(periodFromWorld() as any));
/** Paridad: el modelo nuevo y las columnas heredadas de las MISMAS filas liquidan igual. */
const expectParity = () => expect(money(computeLiquidation(periodFromWorld(true) as any))).toEqual(liquidate());

const row = (id: string) => (world.invoices ?? []).find((i) => i.id === id);
const linesOf = (id: string) => (world.invoiceVatLines ?? []).filter((l) => l.invoiceId === id);
const str = (v: unknown) => (v instanceof Prisma.Decimal ? v.toFixed(2) : v);
const lockTargets = () => rec.locks.map((l) => `${/FROM "Invoice"/.test(l.sql) ? "Invoice" : "Period"}:${l.values[0]}`);
const snapshot = () => JSON.parse(JSON.stringify({ invoices: world.invoices, lines: world.invoiceVatLines, settings: world.vatSettings }));

/** Venta A 1000 + compra A 500 al 21 %, cliente RI (IIBB 3 %). */
const BASELINE = {
  salesNet: "1000.00",
  salesVat: "210.00",
  salesTotal: "1210.00",
  purchasesNet: "500.00",
  purchasesVat: "105.00",
  purchasesTotal: "605.00",
  debit: "210.00",
  credit: "105.00",
  balance: "105.00",
  iibbBase: "1000.00",
  iibbTax: "30.00",
};
const withSaleAndPurchase = () => setWorld([stored("inv_s", saleA), stored("inv_p", purchaseA)]);

// ═════════════════════════════════════════════════════════════════════════

describe("recálculo tras PATCH real", () => {
  beforeEach(withSaleAndPurchase);

  it("línea base: el cálculo parte de las filas del alta", () => {
    expect(liquidate()).toEqual(BASELINE);
    expectParity();
  });

  it("venta A 1000 -> 2000 al 21 %: débito 210 -> 420, base IIBB, IIBB y saldo", async () => {
    expect((await patchInvoice("inv_s", { ...saleA, netAmount: "2000" })).status).toBe(200);
    expect(liquidate()).toEqual({
      ...BASELINE,
      salesNet: "2000.00",
      salesVat: "420.00",
      salesTotal: "2420.00",
      debit: "420.00",
      balance: "315.00",
      iibbBase: "2000.00",
      iibbTax: "60.00",
    });
    // Fila escrita por la ruta: modelo, heredadas y línea coherentes.
    const r = row("inv_s")!;
    expect([r.taxedNetAmount, r.totalVatAmount, r.voucherTotalAmount, r.grossIncomeTaxBaseAmount].map(str)).toEqual(["2000.00", "420.00", "2420.00", "2000.00"]);
    expect([r.netAmount, r.vatAmount, r.totalAmount].map(str)).toEqual(["2000.00", "420.00", "2420.00"]);
    expect(linesOf("inv_s").map((l) => [l.vatRateCode, str(l.netAmount), str(l.vatAmount)])).toEqual([[5, "2000.00", "420.00"]]);
    expectParity();
  });

  it("compra A: neto 500 -> 800 -> crédito 105 -> 168 y saldo 42", async () => {
    expect((await patchInvoice("inv_p", { ...purchaseA, netAmount: "800" })).status).toBe(200);
    expect(liquidate()).toEqual({ ...BASELINE, purchasesNet: "800.00", purchasesVat: "168.00", purchasesTotal: "968.00", credit: "168.00", balance: "42.00" });
    expect(linesOf("inv_p").map((l) => [l.creditAllocation, str(l.computableVatAmount)])).toEqual([["DIRECT_COMPUTABLE", "168.00"]]);
    expectParity();
  });

  it("compra A: alícuota 21 -> 10,5 -> crédito 52,50 y saldo 157,50", async () => {
    expect((await patchInvoice("inv_p", { ...purchaseA, vatRate: "10.5" })).status).toBe(200);
    expect(liquidate()).toEqual({ ...BASELINE, purchasesVat: "52.50", purchasesTotal: "552.50", credit: "52.50", balance: "157.50" });
    expect(linesOf("inv_p").map((l) => l.vatRateCode)).toEqual([4]);
    expectParity();
  });

  it("FC -> NC (venta, mismo nominal): signo invertido en IVA, IIBB y total", async () => {
    expect((await patchInvoice("inv_s", { ...saleA, voucherCode: 3 })).status).toBe(200);
    expect(liquidate()).toEqual({
      ...BASELINE,
      salesNet: "-1000.00",
      salesVat: "-210.00",
      salesTotal: "-1210.00",
      debit: "-210.00",
      balance: "-315.00",
      iibbBase: "-1000.00",
      iibbTax: "-30.00",
    });
    // Modelo positivo (signo por código); heredadas con signo.
    const r = row("inv_s")!;
    expect([r.taxedNetAmount, r.totalVatAmount].map(str)).toEqual(["1000.00", "210.00"]);
    expect([r.netAmount, r.vatAmount, r.totalAmount].map(str)).toEqual(["-1000.00", "-210.00", "-1210.00"]);
    expectParity();
  });

  it("FC -> NC (compra): el crédito se invierte", async () => {
    expect((await patchInvoice("inv_p", { ...purchaseA, voucherCode: 3 })).status).toBe(200);
    expect(liquidate()).toEqual({ ...BASELINE, purchasesNet: "-500.00", purchasesVat: "-105.00", purchasesTotal: "-605.00", credit: "-105.00", balance: "315.00" });
    expectParity();
  });

  it("compra A -> compra C (Monotributo, sin IVA discriminado): sin crédito, neto sin discriminar, sin líneas", async () => {
    expect((await patchInvoice("inv_p", purchaseC)).status).toBe(200);
    expect(liquidate()).toEqual({ ...BASELINE, purchasesVat: "0.00", purchasesTotal: "500.00", credit: "0.00", balance: "210.00" });
    const r = row("inv_p")!;
    expect([r.taxedNetAmount, r.netWithoutVatBreakdownAmount, r.directComputableVatCreditAmount].map(str)).toEqual(["0.00", "500.00", "0.00"]);
    expect(linesOf("inv_p")).toEqual([]);
    expectParity();
  });

  it("si falla el AuditLog del PATCH -> 500 y la liquidación queda EXACTAMENTE como antes (sin efecto parcial)", async () => {
    const before = snapshot();
    rec.failAudit = true;
    expect((await patchInvoice("inv_s", { ...saleA, netAmount: "2000" })).status).toBe(500);
    expect(snapshot()).toEqual(before);
    expect(liquidate()).toEqual(BASELINE);
  });
});

describe("compra B sin IVA discriminado (cliente Exento)", () => {
  it("editar el neto 500 -> 700: sin crédito fiscal en ningún momento, neto sin discriminar", async () => {
    setWorld([stored("inv_b", purchaseB, "Exento")], { clientCondition: "Exento" });
    expect(liquidate()).toMatchObject({ purchasesNet: "500.00", purchasesVat: "0.00", credit: "0.00" });
    expect((await patchInvoice("inv_b", { ...purchaseB, netAmount: "700" })).status).toBe(200);
    expect(liquidate()).toMatchObject({ purchasesNet: "700.00", purchasesVat: "0.00", purchasesTotal: "700.00", credit: "0.00", balance: "0.00" });
    expect(str(row("inv_b")!.netWithoutVatBreakdownAmount)).toBe("700.00");
    expect(linesOf("inv_b")).toEqual([]);
    expectParity();
  });
});

describe("recálculo tras DELETE real", () => {
  beforeEach(withSaleAndPurchase);

  it("borrar la venta: desaparece su débito, su base IIBB y sus líneas", async () => {
    expect((await deleteInvoice("inv_s")).status).toBe(204);
    expect(liquidate()).toEqual({ ...BASELINE, salesNet: "0.00", salesVat: "0.00", salesTotal: "0.00", debit: "0.00", balance: "-105.00", iibbBase: "0.00", iibbTax: "0.00" });
    expect(row("inv_s")).toBeUndefined();
    expect(linesOf("inv_s")).toEqual([]);
    expectParity();
  });

  it("borrar la compra: desaparece su crédito", async () => {
    expect((await deleteInvoice("inv_p")).status).toBe(204);
    expect(liquidate()).toEqual({ ...BASELINE, purchasesNet: "0.00", purchasesVat: "0.00", purchasesTotal: "0.00", credit: "0.00", balance: "210.00" });
    expectParity();
  });

  it("PATCH y luego DELETE con el updatedAt devuelto: el efecto del comprobante se elimina por completo", async () => {
    const edited = await patchInvoice("inv_s", { ...saleA, netAmount: "2000" });
    const token = (await edited.json()).updatedAt;
    expect(token).not.toBe(T0);
    expect((await deleteInvoice("inv_s", token)).status).toBe(204);
    expect(liquidate()).toEqual({ ...BASELINE, salesNet: "0.00", salesVat: "0.00", salesTotal: "0.00", debit: "0.00", balance: "-105.00", iibbBase: "0.00", iibbTax: "0.00" });
  });

  it("si falla el AuditLog del DELETE -> 500 y la liquidación queda EXACTAMENTE como antes", async () => {
    const before = snapshot();
    rec.failAudit = true;
    expect((await deleteInvoice("inv_s")).status).toBe(500);
    expect(snapshot()).toEqual(before);
    expect(liquidate()).toEqual(BASELINE);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Interacción con la inclusión TurIVA (PATCH /api/periods/[id]/vat-settings)
// ═════════════════════════════════════════════════════════════════════════

describe("secuencias con TurIVA", () => {
  const turiva = () => (world.vatSettings ?? []).find((s) => s.periodId === "p_a")?.turivaIncluded;

  it("editar T -> no T y luego desactivar TurIVA: 200", async () => {
    setWorld([stored("inv_t", saleT)], { turivaIncluded: true });
    expect((await patchInvoice("inv_t", saleA)).status).toBe(200);
    expect(row("inv_t")).toMatchObject({ voucherCode: 1, lidSection: "GENERAL", turivaRelationCode: null });
    expect(lockTargets()).toEqual(["Period:p_a", "Invoice:inv_t"]);
    const res = await setTuriva(false);
    expect(res.status).toBe(200);
    expect(turiva()).toBe(false);
    expect(lockTargets()).toEqual(["Period:p_a", "Invoice:inv_t", "Period:p_a"]);
    expect(rec.audits.map((a) => a.action)).toEqual(["invoice.update", "period.vat_settings_change"]);
    expect(liquidate()).toMatchObject({ salesNet: "1000.00", debit: "210.00" });
  });

  it("borrar el último T y luego desactivar TurIVA: 200", async () => {
    setWorld([stored("inv_t", saleT)], { turivaIncluded: true });
    expect((await deleteInvoice("inv_t")).status).toBe(204);
    expect((await setTuriva(false)).status).toBe(200);
    expect(turiva()).toBe(false);
    expect(rec.audits.map((a) => a.action)).toEqual(["invoice.delete", "period.vat_settings_change"]);
  });

  it("borrar un T pero mantener otro y desactivar: 409, sin efectos parciales", async () => {
    setWorld([stored("inv_t", saleT), stored("inv_t2", { ...saleT, number: 1002 })], { turivaIncluded: true });
    expect((await deleteInvoice("inv_t")).status).toBe(204);
    const before = snapshot();
    const res = await setTuriva(false);
    expect(res.status).toBe(409);
    expect(snapshot()).toEqual(before);
    expect(turiva()).toBe(true);
    expect(row("inv_t2")).toMatchObject({ voucherCode: 195 });
    expect(rec.audits.map((a) => a.action)).toEqual(["invoice.delete"]);
  });

  it("editar no T -> T con TurIVA desactivado: 422 sin cambios en filas, líneas, configuración ni auditoría", async () => {
    setWorld([stored("inv_s", saleA)], { turivaIncluded: false });
    const before = snapshot();
    const liquidationBefore = liquidate();
    const res = await patchInvoice("inv_s", saleT);
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("turivaRelationCode");
    expect(snapshot()).toEqual(before);
    expect(liquidate()).toEqual(liquidationBefore);
    expect(db.invoice.update).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("editar T -> T con TurIVA incluido: locks Period -> Invoice, sin volver a bloquear el Period (relectura bajo el mismo lock)", async () => {
    setWorld([stored("inv_t", saleT)], { turivaIncluded: true });
    expect((await patchInvoice("inv_t", { ...saleT, netAmount: "1500" })).status).toBe(200);
    expect(lockTargets()).toEqual(["Period:p_a", "Invoice:inv_t"]);
    expectParity();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
