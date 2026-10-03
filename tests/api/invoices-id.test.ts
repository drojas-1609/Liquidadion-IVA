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

import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  ORG_A,
  ORG_B,
  periodRow,
  type World,
  periodLockSteps,
  periodLockOrder,
  rawCallOrder,
  timeoutRestoreOrder,
  expectPeriodBusyResponse,
  expectBusyRollback,
  loggedUnclassified,
} from "./_harness";
import { Prisma } from "@prisma/client";
import { PATCH, DELETE } from "@/app/api/invoices/[id]/route";
import { buildInvoiceInputV2, EXPECTED_UPDATED_AT_ERROR } from "@/lib/api-input";
import { resolveManualInvoice } from "@/lib/manual-invoice";
import { clientConditionCode } from "@/lib/client-condition";
import { manualInvoiceColumns, manualInvoiceVatLines } from "@/lib/invoice-write";
import { INVOICE_NOT_EDITABLE_MESSAGES } from "@/lib/invoice-edit";
import { TURIVA_NOT_INCLUDED_MESSAGE } from "@/lib/invoice-model";

/* eslint-disable @typescript-eslint/no-explicit-any */

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

const T0 = "2026-05-11T10:00:00.000Z";
const INV = "inv_1";

const RI_CUIT = { name: "Proveedor SA", docType: 80, docNumber: "30-99999999-5", vatConditionCode: 1 };

// Compra A de un Responsable Inscripto (cliente RI): matriz C1, documento DC1.
const valid = {
  contractVersion: 2,
  category: "PURCHASES",
  periodId: "p_a",
  date: "2026-05-10",
  voucherCode: 1,
  voucherVariant: "NONE",
  pointOfSale: 1,
  number: 1001,
  counterparty: RI_CUIT,
  turivaRelationCode: null,
  netAmount: "1000",
  vatRate: "21",
};
const sale = { ...valid, category: "SALES", counterparty: { ...RI_CUIT, name: "Cliente SA" } };
// Venta T a turista no residente (TV2 / DV8).
const saleT = {
  ...sale,
  voucherCode: 195,
  voucherVariant: null,
  turivaRelationCode: "0001",
  counterparty: { name: "Tourist", docType: 94, docNumber: "ab123456", vatConditionCode: 5 },
};

/**
 * Fila MANUAL tal como la escribe el alta (mismos helpers de lib/invoice-write):
 * un PATCH con el mismo cuerpo es un no-op real.
 */
function stored(body: Record<string, unknown>, over: Record<string, unknown> = {}, id = INV) {
  const parsed = buildInvoiceInputV2(body);
  if (!parsed.ok) throw new Error(`fixture inválido: ${parsed.error}`);
  const resolved = resolveManualInvoice(parsed.data, clientConditionCode("Responsable Inscripto"));
  if (!resolved.ok) throw new Error(`fixture inválido: ${resolved.error}`);
  const cols = manualInvoiceColumns({
    input: parsed.data,
    resolved: resolved.data,
    periodId: "p_a",
    organizationId: ORG_A,
    clientId: "c_a",
  });
  const row = {
    id,
    ...cols,
    createdById: SUB_OWNER_A,
    updatedById: SUB_OWNER_A,
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...over,
  };
  const lines = manualInvoiceVatLines(resolved.data.model).map((l, n) => ({
    id: `${id}_vl${n}`,
    invoiceId: id,
    organizationId: row.organizationId,
    ...l,
  }));
  return { row, lines };
}

const setWorld = (patch: (w: World) => void = () => {}) => {
  world = makeWorld();
  patch(world);
  wireDb(db, world, rec);
};
/** Mundo con UN comprobante (inv_1) y, opcionalmente, retoques a la fila/líneas. */
const withInvoice = (
  body: Record<string, unknown> = valid,
  over: Record<string, unknown> = {},
  extra: (w: World) => void = () => {},
) =>
  setWorld((w) => {
    const { row, lines } = stored(body, over);
    w.invoices = [row];
    w.invoiceVatLines = lines;
    extra(w);
  });
const turivaIncluded = (w: World, value: boolean) =>
  (w.vatSettings = [{ periodId: "p_a", organizationId: ORG_A, turivaIncluded: value, creditProrationMode: "NONE" }]);

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  withInvoice();
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

const as = (sub: string) => (H.claims.value = claimsFor(sub));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown, id = INV) =>
  PATCH(
    new Request(`http://localhost/api/invoices/${id}`, {
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx(id),
  );
const edit = (over: Record<string, unknown> = {}, base: Record<string, unknown> = valid) =>
  patch({ ...base, expectedUpdatedAt: T0, ...over });
const del = (expected: string | null = T0, id = INV) =>
  DELETE(
    new Request(
      `http://localhost/api/invoices/${id}${expected === null ? "" : `?expectedUpdatedAt=${encodeURIComponent(expected)}`}`,
      { method: "DELETE" },
    ),
    ctx(id),
  );

const current = () => (world.invoices ?? []).find((i) => i.id === INV);
const linesOf = (id = INV) => (world.invoiceVatLines ?? []).filter((l) => l.invoiceId === id);
const lockTargets = () => rec.locks.map((l) => `${/FROM "Invoice"/.test(l.sql) ? "Invoice" : "Period"}:${l.values[0]}`);

const expectNoUpdate = () => {
  expect(db.invoice.update).not.toHaveBeenCalled();
  expect(rec.created.invoiceUpdate).toBeUndefined();
  expect(rec.audits).toHaveLength(0);
  expect(current()?.updatedAt.toISOString()).toBe(T0);
};
const expectNotDeleted = () => {
  expect(db.invoice.delete).not.toHaveBeenCalled();
  expect(current()).toBeDefined();
  expect(linesOf()).toHaveLength(1);
  expect(rec.audits).toHaveLength(0);
};
const expectNotEditable = async (res: Response, reason: keyof typeof INVOICE_NOT_EDITABLE_MESSAGES) => {
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.field).toBe("invoice");
  expect(body.error.message).toBe(INVOICE_NOT_EDITABLE_MESSAGES[reason]);
};
/** Ejecuta `fn` justo cuando la ruta bloquea el Period (simula una escritura concurrente ya confirmada). */
const onPeriodLock = (fn: () => void) => {
  const base = db.$queryRaw.getMockImplementation()!;
  let done = false;
  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!done && /FROM "Period"/.test(strings.join("?"))) {
      done = true;
      fn();
    }
    return base(strings, ...values);
  });
};

// ═════════════════════════════════════════════════════════════════════════
// PATCH
// ═════════════════════════════════════════════════════════════════════════

describe("PATCH /api/invoices/[id] — roles y aislamiento", () => {
  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s -> 200 y actualiza", async (_l, sub) => {
    as(sub);
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(200);
    expect(current()?.number).toBe(1002);
    expect(current()?.updatedById).toBe(sub);
    expect(rec.audits).toHaveLength(1);
  });

  it("VIEWER -> 403 FORBIDDEN, sin leer el comprobante ni escribir", async () => {
    as(SUB_VIEWER_A);
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(403);
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
    expectNoUpdate();
  });

  it("sin sesión -> 401", async () => {
    H.claims.value = null;
    expect((await edit({ number: 1002 })).status).toBe(401);
    expectNoUpdate();
  });

  it("comprobante de OTRA organización (activa ORG_B) -> 404, sin revelar nada", async () => {
    as(SUB_OWNER_B);
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/inv_1|p_a|1001|Proveedor/);
    expect(db.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: INV, organizationId: ORG_B } }));
    expectNoUpdate();
  });

  it("id de un comprobante de ORG_B pedido desde ORG_A -> 404", async () => {
    withInvoice(valid, {}, (w) => {
      w.invoices!.push({ ...w.invoices![0], id: "inv_b", organizationId: ORG_B, periodId: "p_b", clientId: "c_b" });
    });
    expect((await edit({ number: 1002 }, valid)).status).toBe(200); // control: el propio sí
    expect((await patch({ ...valid, expectedUpdatedAt: T0, periodId: "p_b" }, "inv_b")).status).toBe(404);
  });

  it("id inexistente -> 404", async () => {
    expect((await patch({ ...valid, expectedUpdatedAt: T0 }, "inv_zzz")).status).toBe(404);
    expectNoUpdate();
  });

  it("comprobante cuyo Period es de otra organización (dato inconsistente) -> 404", async () => {
    withInvoice(valid, { periodId: "p_b" });
    expect((await edit({ number: 1002, periodId: "p_b" })).status).toBe(404);
    expectNoUpdate();
  });
});

describe("PATCH /api/invoices/[id] — parseo y contrato", () => {
  it("JSON inválido -> 400", async () => {
    expect((await patch("{no json")).status).toBe(400);
    expectNoUpdate();
  });

  it("sin contractVersion -> 422 contractVersion (contrato v2 completo)", async () => {
    const rest: Partial<typeof valid> = { ...valid };
    delete rest.contractVersion;
    expect(Object.prototype.hasOwnProperty.call(rest, "contractVersion")).toBe(false);
    const res = await patch({ ...rest, expectedUpdatedAt: T0 });
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("contractVersion");
    expectNoUpdate();
  });

  it.each([
    ["ausente", undefined],
    ["null", null],
    ["número", Date.parse(T0)],
    ["sin milisegundos", "2026-05-11T10:00:00Z"],
    ["con offset", "2026-05-11T07:00:00.000-03:00"],
    ["fecha inexistente", "2026-02-30T10:00:00.000Z"],
    ["sólo fecha", "2026-05-11"],
  ])("expectedUpdatedAt %s -> 422 expectedUpdatedAt, antes de leer el comprobante", async (_l, v) => {
    const res = await patch({ ...valid, expectedUpdatedAt: v });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.field).toBe("expectedUpdatedAt");
    expect(body.error.message).toBe(EXPECTED_UPDATED_AT_ERROR);
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
    expectNoUpdate();
  });

  it("categoría distinta -> 422 category (inmutable), sin escritura", async () => {
    const res = await edit({}, sale);
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("category");
    expectNoUpdate();
  });

  it("período distinto (de la misma organización) -> 422 periodId (inmutable), sin escritura", async () => {
    withInvoice(valid, {}, (w) => w.periods.push(periodRow("p_a2", "c_a", ORG_A, { month: 6 })));
    const res = await edit({ periodId: "p_a2", date: "2026-06-10" });
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("periodId");
    expectNoUpdate();
  });

  it("factura con neto negativo -> 422 netAmount (validación v2 completa)", async () => {
    const res = await edit({ netAmount: "-1000" });
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("netAmount");
    expectNoUpdate();
  });

  it("nota de débito con neto negativo -> 422 netAmount", async () => {
    const res = await edit({ voucherCode: 2, netAmount: "-1000" });
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("netAmount");
    expectNoUpdate();
  });

  it("fecha fuera del período -> 422 (misma preparación que el alta)", async () => {
    const res = await edit({ date: "2026-07-10" });
    expect(res.status).toBe(422);
    expectNoUpdate();
  });
});

describe("PATCH /api/invoices/[id] — editabilidad", () => {
  it("importado -> 422 IMPORTED", async () => {
    withInvoice(valid, { source: "IMPORT" });
    await expectNotEditable(await edit({ number: 1002 }), "IMPORTED");
    expectNoUpdate();
  });

  it("source nulo -> 422 LEGACY", async () => {
    withInvoice(valid, { source: null });
    await expectNotEditable(await edit({ number: 1002 }), "LEGACY");
    expectNoUpdate();
  });

  it("MANUAL sin código oficial -> 422 LEGACY", async () => {
    withInvoice(valid, { voucherCode: null });
    await expectNotEditable(await edit({ number: 1002 }), "LEGACY");
    expectNoUpdate();
  });

  it("más de una línea de IVA -> 422 MULTI_RATE", async () => {
    withInvoice(valid, {}, (w) => w.invoiceVatLines!.push({ ...w.invoiceVatLines![0], id: "vl_x", vatRateCode: 4 }));
    await expectNotEditable(await edit({ number: 1002 }), "MULTI_RATE");
    expectNoUpdate();
  });

  it("precedencia: importado con varias líneas -> IMPORTED", async () => {
    withInvoice(valid, { source: "IMPORT" }, (w) =>
      w.invoiceVatLines!.push({ ...w.invoiceVatLines![0], id: "vl_x", vatRateCode: 4 }),
    );
    await expectNotEditable(await edit({ number: 1002 }), "IMPORTED");
  });

  it.each([
    ["sin fecha", { voucherDate: null }],
    ["sin nombre", { counterpartyName: null }],
    ["sin documento", { counterpartyDocNumber: null }],
    ["sin neto gravado", { taxedNetAmount: null }],
  ])("%s -> 422 INSUFFICIENT_DATA", async (_l, over) => {
    withInvoice(valid, over);
    await expectNotEditable(await edit({ number: 1002 }), "INSUFFICIENT_DATA");
    expectNoUpdate();
  });

  it("excepción: condición de la contraparte nula -> editable; changedFields la incluye al completarla", async () => {
    withInvoice(valid, { counterpartyVatConditionCode: null });
    const res = await edit();
    expect(res.status).toBe(200);
    expect(current()?.counterpartyVatConditionCode).toBe(1);
    expect(rec.audits[0].metadata.changedFields).toBe("counterpartyVatConditionCode");
  });

  it("excepción: variante nula en 001–003 -> editable; changedFields la incluye al completarla", async () => {
    withInvoice(valid, { voucherVariant: null });
    const res = await edit();
    expect(res.status).toBe(200);
    expect(current()?.voucherVariant).toBe("NONE");
    expect(rec.audits[0].metadata.changedFields).toBe("voucherVariant");
  });

  it("excepción: la variante se exige igual que en el alta (sin inferencia)", async () => {
    withInvoice(valid, { voucherVariant: null });
    const res = await edit({ voucherVariant: null });
    expect(res.status).toBe(422);
    expectNoUpdate();
  });
});

describe("PATCH /api/invoices/[id] — no-op", () => {
  it("mismo contenido -> 200 sin update ni AuditLog, updatedAt intacto", async () => {
    const res = await edit();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(INV);
    expect(body.number).toBe(1001);
    expect(body).toHaveProperty("legalClass");
    expect(body).toHaveProperty("warnings");
    expectNoUpdate();
  });

  it("documento con otro formato (mismo documento normalizado) -> no-op", async () => {
    const res = await edit({ counterparty: { ...RI_CUIT, docNumber: "30 99999999 5" } });
    expect(res.status).toBe(200);
    expectNoUpdate();
  });

  it("mismo neto con otro formato decimal -> no-op", async () => {
    expect((await edit({ netAmount: "1000.00" })).status).toBe(200);
    expectNoUpdate();
  });

  it("nota de crédito: '-1000' y '1000' son el mismo neto canónico -> no-op", async () => {
    withInvoice({ ...valid, voucherCode: 3 });
    expect((await edit({ voucherCode: 3, netAmount: "-1000" })).status).toBe(200);
    expect((await edit({ voucherCode: 3, netAmount: "1000" })).status).toBe(200);
    expectNoUpdate();
  });
});

describe("PATCH /api/invoices/[id] — changedFields y escritura", () => {
  it("cambio de número -> 'number'; metadata exacta; líneas reemplazadas", async () => {
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(200);
    expect(rec.audits).toHaveLength(1);
    const audit = rec.audits[0];
    expect(audit).toMatchObject({ organizationId: ORG_A, actorProfileId: SUB_OWNER_A, action: "invoice.update", targetType: "Invoice", targetId: INV });
    expect(audit.metadata).toEqual({
      periodId: "p_a",
      category: "PURCHASES",
      voucherCodeBefore: 1,
      voucherCodeAfter: 1,
      pointOfSaleBefore: 1,
      pointOfSaleAfter: 1,
      numberBefore: 1001,
      numberAfter: 1002,
      changedFields: "number",
    });
    expect(linesOf()).toHaveLength(1);
    expect(linesOf()[0].id).not.toBe(`${INV}_vl0`);
    expect(current()?.updatedAt.toISOString()).not.toBe(T0);
  });

  it("FC -> NC del mismo nominal -> exactamente 'voucherCode,netAmount'", async () => {
    const res = await edit({ voucherCode: 3 });
    expect(res.status).toBe(200);
    expect(rec.audits[0].metadata.changedFields).toBe("voucherCode,netAmount");
    expect(rec.audits[0].metadata.voucherCodeBefore).toBe(1);
    expect(rec.audits[0].metadata.voucherCodeAfter).toBe(3);
  });

  it("FC -> NC informando '-1000' -> también 'voucherCode,netAmount'", async () => {
    expect((await edit({ voucherCode: 3, netAmount: "-1000" })).status).toBe(200);
    expect(rec.audits[0].metadata.changedFields).toBe("voucherCode,netAmount");
  });

  it("sólo alícuota -> 'vatRate'", async () => {
    expect((await edit({ vatRate: "10.5" })).status).toBe(200);
    expect(rec.audits[0].metadata.changedFields).toBe("vatRate");
    expect(linesOf().map((l) => l.vatRateCode)).toEqual([4]);
  });

  it("sólo importe -> 'netAmount'", async () => {
    expect((await edit({ netAmount: "1500" })).status).toBe(200);
    expect(rec.audits[0].metadata.changedFields).toBe("netAmount");
  });

  it("varios campos -> orden fijo", async () => {
    const res = await edit({
      number: 1002,
      pointOfSale: 2,
      date: "2026-05-12",
      counterparty: { ...RI_CUIT, name: "Otro Proveedor SA" },
    });
    expect(res.status).toBe(200);
    expect(rec.audits[0].metadata.changedFields).toBe("voucherDate,pointOfSale,number,counterpartyName");
    expect(rec.audits[0].metadata.pointOfSaleAfter).toBe(2);
  });

  it("la metadata nunca lleva importes, alícuotas, CUIT, documento ni nombre", async () => {
    await edit({ netAmount: "1500", vatRate: "10.5", counterparty: { ...RI_CUIT, name: "Otro Proveedor SA" } });
    const json = JSON.stringify(rec.audits[0].metadata);
    expect(json).not.toMatch(/1500|1000|10\.5|"21"|30999999995|30-99999999-5|Proveedor/);
  });

  it("clientId, organizationId y periodId escritos salen del período autorizado, nunca del body", async () => {
    await edit({ number: 1002, clientId: "c_b", organizationId: ORG_B });
    const data = rec.created.invoiceUpdate;
    expect(data).toMatchObject({ clientId: "c_a", organizationId: ORG_A, periodId: "p_a", source: "MANUAL", updatedById: SUB_OWNER_A });
    expect(data.vatLines).toMatchObject({ deleteMany: {} });
    expect(data).not.toHaveProperty("createdById");
  });

  it("200 tras escribir incluye updatedAt ISO exacto de la fila confirmada", async () => {
    const body = await (await edit({ number: 1002 })).json();
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.updatedAt).toBe(current()?.updatedAt.toISOString());
    expect(body.updatedAt).not.toBe(T0);
  });

  it("200 no-op incluye el updatedAt vigente (sin cambios)", async () => {
    const body = await (await edit()).json();
    expect(body.updatedAt).toBe(T0);
  });

  it("el updatedAt devuelto permite una segunda edición consecutiva; el anterior queda viejo (409)", async () => {
    const first = await (await edit({ number: 1002 })).json();
    const second = await edit({ number: 1003, expectedUpdatedAt: first.updatedAt });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(current()?.number).toBe(1003);
    expect(secondBody.updatedAt).toBe(current()?.updatedAt.toISOString());
    expect(rec.audits.map((a) => a.metadata.numberAfter)).toEqual([1002, 1003]);
    const stale = await edit({ number: 1004, expectedUpdatedAt: first.updatedAt });
    expect(stale.status).toBe(409);
    expect(current()?.number).toBe(1003);
    expect(rec.audits).toHaveLength(2);
  });

  it("el updatedAt de un no-op permite editar a continuación", async () => {
    const noop = await (await edit()).json();
    expect((await edit({ number: 1002, expectedUpdatedAt: noop.updatedAt })).status).toBe(200);
    expect(current()?.number).toBe(1002);
  });

  it("respuesta 200 con la misma forma que el alta", async () => {
    const res = await edit({ number: 1002 });
    const body = await res.json();
    expect(body).toMatchObject({ id: INV, number: 1002, category: "PURCHASES", periodId: "p_a" });
    for (const k of ["warnings", "legalClass", "mandatoryLegend", "partialValidation", "requiresTurivaSection"]) {
      expect(body).toHaveProperty(k);
    }
  });
});

describe("PATCH /api/invoices/[id] — concurrencia y orden de locks", () => {
  it("expectedUpdatedAt viejo -> 409 sin escritura ni AuditLog", async () => {
    const res = await edit({ number: 1002, expectedUpdatedAt: "2026-05-11T09:59:59.999Z" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expectNoUpdate();
  });

  it("edición concurrente confirmada antes del lock -> 409 (se compara contra la fila BLOQUEADA)", async () => {
    onPeriodLock(() => (world.invoices![0] = { ...world.invoices![0], updatedAt: new Date("2026-05-11T10:00:01.000Z") }));
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(409);
    expect(db.invoice.update).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("baja concurrente antes del lock -> 404", async () => {
    onPeriodLock(() => world.invoices!.splice(0, 1));
    expect((await edit({ number: 1002 })).status).toBe(404);
    expect(db.invoice.update).not.toHaveBeenCalled();
  });

  it("editabilidad reevaluada bajo lock (línea agregada) -> 422 MULTI_RATE", async () => {
    onPeriodLock(() => world.invoiceVatLines!.push({ ...world.invoiceVatLines![0], id: "vl_x", vatRateCode: 4 }));
    await expectNotEditable(await edit({ number: 1002 }), "MULTI_RATE");
    expect(db.invoice.update).not.toHaveBeenCalled();
  });

  it("inmutables reevaluados bajo lock (cliente distinto) -> 422 sin escritura", async () => {
    onPeriodLock(() => (world.invoices![0] = { ...world.invoices![0], clientId: "c_other" }));
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(422);
    expect(db.invoice.update).not.toHaveBeenCalled();
  });

  it("orden de locks: Period -> Invoice, parametrizados con la organización", async () => {
    await edit({ number: 1002 });
    expect(lockTargets()).toEqual(["Period:p_a", "Invoice:inv_1"]);
    expect(rec.locks[1].values).toEqual([INV, ORG_A]);
    expect(rec.locks[1].sql).toMatch(/FOR UPDATE/);
  });

  it("el lock de Invoice se toma aun en el no-op", async () => {
    await edit();
    expect(lockTargets()).toEqual(["Period:p_a", "Invoice:inv_1"]);
  });
});

describe("PATCH /api/invoices/[id] — duplicidad", () => {
  const other = (over: Record<string, unknown> = {}) => (w: World) => {
    w.periods.push(periodRow("p_a_prev", "c_a", ORG_A, { month: 4 }));
    const { row } = stored(valid, { periodId: "p_a_prev", number: 1002, ...over }, "inv_2");
    w.invoices!.push(row);
  };

  it("cambiar al número de otro comprobante del cliente -> 409 con el período, sin escritura", async () => {
    withInvoice(valid, {}, other());
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe("El comprobante ya existe en el período 04/2026.");
    expect(JSON.stringify(body)).not.toMatch(/inv_2|p_a_prev|30999999995/);
    expectNoUpdate();
  });

  it("el propio comprobante no cuenta como duplicado (se excluye su id)", async () => {
    expect((await edit({ netAmount: "1500" })).status).toBe(200);
    expect(db.invoice.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ NOT: { id: INV } }) }));
  });

  it("mismo número de OTRA organización -> no es duplicado", async () => {
    withInvoice(valid, {}, other({ organizationId: ORG_B, clientId: "c_b", periodId: "p_b" }));
    expect((await edit({ number: 1002 })).status).toBe(200);
  });

  it("carrera: P2002 al actualizar con el duplicado visible -> 409 con el período, sin AuditLog", async () => {
    const base = db.invoice.findFirst.getMockImplementation()!;
    let raced = false;
    db.invoice.findFirst.mockImplementation(async (args: any) =>
      raced && args.where?.NOT ? { period: { month: 4, year: 2026 } } : base(args),
    );
    db.invoice.update.mockImplementationOnce(async () => {
      raced = true;
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });
    });
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe("El comprobante ya existe en el período 04/2026.");
    expect(rec.audits).toHaveLength(0);
    expect(current()?.number).toBe(1001);
  });

  it("carrera: P2002 sin duplicado visible -> 409 CONFLICT genérico", async () => {
    db.invoice.update.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });
    });
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(rec.audits).toHaveLength(0);
  });
});

describe("PATCH /api/invoices/[id] — TurIVA (195–197)", () => {
  const withT = (included: boolean) => withInvoice(saleT, {}, (w) => turivaIncluded(w, included));

  it("T con inclusión vigente -> 200; locks Period -> Invoice, sin volver a bloquear el Period (relectura bajo el mismo lock)", async () => {
    withT(true);
    const res = await edit({ number: 1002 }, saleT);
    expect(res.status).toBe(200);
    expect(lockTargets()).toEqual(["Period:p_a", "Invoice:inv_1"]);
    // La relectura TurIVA ocurre DESPUÉS de ambos locks.
    const invoiceLockAt = rawCallOrder(db, /FROM "Invoice"[\s\S]*FOR UPDATE/);
    expect(periodLockOrder(db)).toBeLessThan(invoiceLockAt);
    expect(invoiceLockAt).toBeLessThan(db.periodVatSettings.findUnique.mock.invocationCallOrder[0]);
    expect(rec.audits[0].metadata.changedFields).toBe("number");
  });

  it("inclusión desactivada antes del lock -> 422 turivaRelationCode, sin escritura", async () => {
    withT(true);
    onPeriodLock(() => turivaIncluded(world, false));
    const res = await edit({ number: 1002 }, saleT);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.field).toBe("turivaRelationCode");
    expect(body.error.message).toBe(TURIVA_NOT_INCLUDED_MESSAGE);
    expectNoUpdate();
  });

  it("A -> T sin inclusión -> 422 turivaRelationCode", async () => {
    withInvoice(sale, {}, (w) => turivaIncluded(w, false));
    const res = await edit({}, saleT);
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("turivaRelationCode");
    expectNoUpdate();
  });

  it("no T -> no relee TurIVA", async () => {
    await edit({ number: 1002 });
    expect(db.periodVatSettings.findUnique).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/invoices/[id] — atomicidad", () => {
  it("falla el AuditLog -> 500 y rollback total (fila y líneas intactas)", async () => {
    rec.failAudit = true;
    const linesBefore = linesOf().map((l) => l.id);
    const res = await edit({ number: 1002, vatRate: "10.5" });
    expect(res.status).toBe(500);
    expect(current()?.number).toBe(1001);
    expect(current()?.updatedAt.toISOString()).toBe(T0);
    expect(linesOf().map((l) => l.id)).toEqual(linesBefore);
    expect(rec.audits).toHaveLength(0);
    expect(rec.created.invoiceUpdate).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Orden único de locks (lockPeriodForWrite): Period -> Invoice
// ═════════════════════════════════════════════════════════════════════════

describe("PATCH / DELETE /api/invoices/[id] — orden único de locks", () => {
  /**
   * Invariante: si hubo locks, el primero es Period; hay a lo sumo UN lock de
   * Period y a lo sumo uno de Invoice; nunca Period después de Invoice.
   */
  const expectLockOrder = () => {
    const t = lockTargets();
    expect(t.length).toBeGreaterThan(0);
    expect(t[0]).toBe("Period:p_a");
    expect(t.filter((x) => x.startsWith("Period:"))).toHaveLength(1);
    expect(t.filter((x) => x.startsWith("Invoice:")).length).toBeLessThanOrEqual(1);
    const inv = t.findIndex((x) => x.startsWith("Invoice:"));
    if (inv >= 0) expect(t.slice(inv + 1).some((x) => x.startsWith("Period:"))).toBe(false);
  };

  it.each([
    ["PATCH no T (200)", () => edit({ number: 1002 }), 200],
    ["PATCH no-op (200)", () => edit(), 200],
    ["PATCH T con inclusión (200)", () => (withInvoice(saleT, {}, (w) => turivaIncluded(w, true)), edit({ number: 1002 }, saleT)), 200],
    ["PATCH A -> T sin inclusión (422)", () => (withInvoice(sale, {}, (w) => turivaIncluded(w, false)), edit({}, saleT)), 422],
    [
      "PATCH T con inclusión desactivada bajo el lock (422)",
      () => {
        withInvoice(saleT, {}, (w) => turivaIncluded(w, true));
        onPeriodLock(() => turivaIncluded(world, false));
        return edit({ number: 1002 }, saleT);
      },
      422,
    ],
    ["PATCH con updatedAt viejo (409)", () => edit({ number: 1002, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }), 409],
    ["DELETE (204)", () => del(), 204],
    ["DELETE con updatedAt viejo (409)", () => del("2020-01-01T00:00:00.000Z"), 409],
  ])("%s -> Period primero, un solo lock de Period, nunca Invoice -> Period", async (_l, run, status) => {
    const res = await (run as () => Promise<Response>)();
    expect(res.status).toBe(status);
    expectLockOrder();
  });

  it("período eliminado en paralelo: el lock de Period no lo encuentra -> 404 sin bloquear Invoice ni escribir", async () => {
    onPeriodLock(() => world.periods.splice(world.periods.findIndex((p) => p.id === "p_a"), 1));
    const res = await edit({ number: 1002 });
    expect(res.status).toBe(404);
    expect(lockTargets()).toEqual(["Period:p_a"]);
    expectNoUpdate();
  });

  it("PATCH con lock_timeout previo 1500ms: leer -> set 3000ms -> lock Period -> restaurar 1500ms EXACTO; el lock de Invoice ya corre con 1500ms", async () => {
    rec.initialLockTimeout = "1500ms";
    expect((await edit({ number: 1002 })).status).toBe(200);
    expect(rec.rawSteps).toEqual([...periodLockSteps("1500ms"), "lock:Invoice@1500ms"]);
    expect(rec.lockTimeouts.at(-1)).toEqual({ step: "restore", value: "1500ms" });
    const restoreAt = timeoutRestoreOrder(db);
    expect(restoreAt).toBeGreaterThan(periodLockOrder(db));
    expect(restoreAt).toBeLessThan(rawCallOrder(db, /FROM "Invoice"[\s\S]*FOR UPDATE/));
    expect(restoreAt).toBeLessThan(db.invoiceVatLine.findMany.mock.invocationCallOrder[0]);
    expect(restoreAt).toBeLessThan(db.invoice.update.mock.invocationCallOrder[0]);
    expect(restoreAt).toBeLessThan(db.auditLog.create.mock.invocationCallOrder[0]);
  });

  it("DELETE: leer -> set 3000ms -> lock Period -> restaurar; recién después lock de Invoice, borrado y AuditLog", async () => {
    expect((await del()).status).toBe(204);
    expect(rec.rawSteps).toEqual([...periodLockSteps("0"), "lock:Invoice@0"]);
    const restoreAt = timeoutRestoreOrder(db);
    expect(restoreAt).toBeGreaterThan(periodLockOrder(db));
    expect(restoreAt).toBeLessThan(rawCallOrder(db, /FROM "Invoice"[\s\S]*FOR UPDATE/));
    expect(restoreAt).toBeLessThan(db.invoiceVatLine.deleteMany.mock.invocationCallOrder[0]);
    expect(restoreAt).toBeLessThan(db.invoice.delete.mock.invocationCallOrder[0]);
    expect(restoreAt).toBeLessThan(db.auditLog.create.mock.invocationCallOrder[0]);
  });

  it("PATCH con el período ocupado (55P03 en el lock de Period) -> 409 PERIOD_BUSY exacto, no-store; sin lock de Invoice, líneas, TurIVA, escritura ni AuditLog; rollback", async () => {
    withInvoice(saleT, {}, (w) => turivaIncluded(w, true));
    rec.periodLockBusy = true;
    const { result: res, unclassified } = await loggedUnclassified(() => edit({ number: 1002 }, saleT));
    await expectPeriodBusyResponse(res);
    expect(unclassified).toBe(false);
    expectBusyRollback(rec);
    expect(lockTargets()).toEqual(["Period:p_a"]);
    expect(db.invoiceVatLine.findMany).not.toHaveBeenCalled();
    expect(db.periodVatSettings.findUnique).not.toHaveBeenCalled();
    expectNoUpdate();
    expect(current()?.number).toBe(1001);
  });

  it("DELETE con el período ocupado (55P03 en el lock de Period) -> 409 PERIOD_BUSY exacto, no-store; sin lock de Invoice, borrado de líneas, baja ni AuditLog; rollback", async () => {
    rec.periodLockBusy = true;
    const { result: res, unclassified } = await loggedUnclassified(() => del());
    await expectPeriodBusyResponse(res);
    expect(unclassified).toBe(false);
    expectBusyRollback(rec);
    expect(lockTargets()).toEqual(["Period:p_a"]);
    expect(db.invoiceVatLine.findMany).not.toHaveBeenCalled();
    expect(db.invoiceVatLine.deleteMany).not.toHaveBeenCalled();
    expectNotDeleted();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE
// ═════════════════════════════════════════════════════════════════════════

describe("DELETE /api/invoices/[id]", () => {
  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
  ])("%s -> 204; borra fila y líneas; AuditLog de la fila bloqueada", async (_l, sub) => {
    as(sub);
    const res = await del();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(current()).toBeUndefined();
    expect(linesOf()).toHaveLength(0);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({ action: "invoice.delete", targetType: "Invoice", targetId: INV, actorProfileId: sub, organizationId: ORG_A });
    expect(rec.audits[0].metadata).toEqual({ periodId: "p_a", category: "PURCHASES", voucherCode: 1, pointOfSale: 1, number: 1001 });
  });

  it.each([
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
    ["VIEWER", SUB_VIEWER_A],
  ])("%s -> 403 sin leer el comprobante", async (_l, sub) => {
    as(sub);
    expect((await del()).status).toBe(403);
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
    expectNotDeleted();
  });

  it("sin sesión -> 401", async () => {
    H.claims.value = null;
    expect((await del()).status).toBe(401);
    expectNotDeleted();
  });

  it.each([
    ["ausente", null],
    ["sin milisegundos", "2026-05-11T10:00:00Z"],
    ["fecha inexistente", "2026-02-30T10:00:00.000Z"],
  ])("expectedUpdatedAt %s -> 422 expectedUpdatedAt antes de leer el comprobante", async (_l, v) => {
    const res = await del(v);
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("expectedUpdatedAt");
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
    expectNotDeleted();
  });

  it("otra organización -> 404", async () => {
    as(SUB_OWNER_B);
    expect((await del()).status).toBe(404);
    expectNotDeleted();
  });

  it("inexistente -> 404", async () => {
    expect((await del(T0, "inv_zzz")).status).toBe(404);
    expectNotDeleted();
  });

  it.each([
    ["IMPORTED", { source: "IMPORT" }],
    ["LEGACY", { source: null }],
    ["LEGACY", { voucherCode: null }],
  ] as const)("%s -> 422", async (reason, over) => {
    withInvoice(valid, over);
    await expectNotEditable(await del(), reason);
    expectNotDeleted();
  });

  it("MULTI_RATE -> 422", async () => {
    withInvoice(valid, {}, (w) => w.invoiceVatLines!.push({ ...w.invoiceVatLines![0], id: "vl_x", vatRateCode: 4 }));
    await expectNotEditable(await del(), "MULTI_RATE");
    expect(current()).toBeDefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("eliminabilidad = sólo alcance: fila MANUAL con datos insuficientes SÍ se puede borrar", async () => {
    withInvoice(valid, { counterpartyName: null, voucherDate: null });
    expect((await del()).status).toBe(204);
    expect(current()).toBeUndefined();
  });

  it("expectedUpdatedAt viejo -> 409 sin borrar", async () => {
    expect((await del("2026-05-11T09:59:59.999Z")).status).toBe(409);
    expectNotDeleted();
  });

  it("edición concurrente antes del lock -> 409", async () => {
    onPeriodLock(() => (world.invoices![0] = { ...world.invoices![0], updatedAt: new Date("2026-05-11T10:00:01.000Z") }));
    expect((await del()).status).toBe(409);
    expect(db.invoice.delete).not.toHaveBeenCalled();
  });

  describe("fila bloqueada fuera del período / cliente autorizados (mismo updatedAt) -> el MISMO 409 stale", () => {
    const STALE_BODY = {
      error: {
        code: "CONFLICT",
        message: "El comprobante fue modificado por otra persona. Volvé a abrirlo para ver los datos actuales.",
      },
    };

    it("referencia: el 409 stale por updatedAt viejo tiene exactamente ese cuerpo", async () => {
      const res = await del("2026-05-11T09:59:59.999Z");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(STALE_BODY);
    });

    it.each([
      ["periodId", { periodId: "p_ajeno" }],
      ["clientId", { clientId: "c_ajeno" }],
      ["periodId y clientId", { periodId: "p_ajeno", clientId: "c_ajeno" }],
    ])("%s cambiado bajo lock -> 409 stale idéntico, sin leer líneas, evaluar eliminabilidad, borrar ni AuditLog", async (_l, over) => {
      // Además la fila deja de ser eliminable (MULTI_RATE): si la eliminabilidad
      // se evaluara antes, respondería 422. El 409 prueba el orden.
      onPeriodLock(() => {
        world.invoices![0] = { ...world.invoices![0], ...over };
        world.invoiceVatLines!.push({ ...world.invoiceVatLines![0], id: "vl_x", vatRateCode: 4 });
      });
      const res = await del();
      expect(res.status).toBe(409);
      expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
      const body = await res.json();
      expect(body).toEqual(STALE_BODY);
      expect(JSON.stringify(body)).not.toMatch(/p_ajeno|c_ajeno|p_a|c_a|org_|inv_1/);

      expect(lockTargets()).toEqual(["Period:p_a", "Invoice:inv_1"]);
      expect(db.invoiceVatLine.findMany).not.toHaveBeenCalled();
      expect(db.invoiceVatLine.deleteMany).not.toHaveBeenCalled();
      expect(db.invoice.delete).not.toHaveBeenCalled();
      expect(rec.audits).toHaveLength(0);
      expect(rec.created).toEqual({});
      // Fila y líneas intactas. (El rollback del harness restaura el mundo al
      // inicio de la transacción, incluida la modificación simulada bajo lock.)
      expectNotDeleted();
    });
  });

  it("caso normal: la relectura de líneas ocurre DESPUÉS del lock de Invoice y de las comprobaciones", async () => {
    expect((await del()).status).toBe(204);
    const invoiceLockAt = rawCallOrder(db, /FROM "Invoice"[\s\S]*FOR UPDATE/);
    expect(db.invoiceVatLine.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(invoiceLockAt);
    expect(db.invoiceVatLine.findMany).toHaveBeenCalledWith({ where: { invoiceId: INV, organizationId: ORG_A }, select: { vatRateCode: true } });
  });

  it("baja concurrente antes del lock -> 404", async () => {
    onPeriodLock(() => world.invoices!.splice(0, 1));
    expect((await del()).status).toBe(404);
    expect(db.invoice.delete).not.toHaveBeenCalled();
  });

  it("eliminabilidad reevaluada bajo lock -> 422 MULTI_RATE", async () => {
    onPeriodLock(() => world.invoiceVatLines!.push({ ...world.invoiceVatLines![0], id: "vl_x", vatRateCode: 4 }));
    await expectNotEditable(await del(), "MULTI_RATE");
    expect(db.invoice.delete).not.toHaveBeenCalled();
  });

  it("orden de locks: Period -> Invoice", async () => {
    await del();
    expect(lockTargets()).toEqual(["Period:p_a", "Invoice:inv_1"]);
    expect(rec.locks[1].values).toEqual([INV, ORG_A]);
  });

  it("borra las líneas filtrando por comprobante y organización", async () => {
    await del();
    expect(db.invoiceVatLine.deleteMany).toHaveBeenCalledWith({ where: { invoiceId: INV, organizationId: ORG_A } });
    expect(db.invoice.delete).toHaveBeenCalledWith({ where: { id_organizationId: { id: INV, organizationId: ORG_A } } });
  });

  it("la metadata nunca lleva importes, CUIT, documento ni nombre", async () => {
    await del();
    expect(JSON.stringify(rec.audits[0].metadata)).not.toMatch(/1000|30999999995|Proveedor|21/);
  });

  it("falla el AuditLog -> 500 y rollback total (fila y líneas restauradas)", async () => {
    rec.failAudit = true;
    const res = await del();
    expect(res.status).toBe(500);
    expect(current()).toBeDefined();
    expect(linesOf()).toHaveLength(1);
    expect(rec.audits).toHaveLength(0);
    expect(rec.created.invoiceDelete).toBeUndefined();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
