import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

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
  periodRow,
  taxRecordRow,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  SUB_NO_PROFILE,
  ORG_A,
  ORG_B,
  TAX_RECORD_UPDATED_AT,
  TAX_RECORD_UPDATED_AT_AFTER,
  type World,
  periodLockSteps,
  periodLockOrder,
  rawCallOrder,
  PERIOD_WRITE_TX_OPTIONS,
  expectPeriodBusyResponse,
  expectBusyRollback,
  loggedUnclassified,
} from "./_harness";
import { DELETE, PATCH } from "@/app/api/taxes/[id]/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

const T0 = TAX_RECORD_UPDATED_AT;
const TAX = "t_a";
const LEGACY = "t_legacy";
const STALE_MESSAGE = "La retención/percepción fue modificada por otra persona. Volvé a abrirla para ver los datos actuales.";

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  world = makeWorld({
    periods: [periodRow("p_a", "c_a", ORG_A), periodRow("p_a_jun", "c_a", ORG_A, { month: 6 }), periodRow("p_b", "c_b", ORG_B)],
    taxRecords: [
      taxRecordRow(TAX, "p_a", ORG_A),
      taxRecordRow(LEGACY, "p_a", ORG_A, { type: "RETENCION GANANCIAS", description: "  carga manual  " }),
      taxRecordRow("t_b", "p_b", ORG_B),
    ],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

const as = (sub: string | null) => (H.claims.value = claimsFor(sub));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Cuerpo idéntico a la fila t_a: un PATCH con él es un no-op. */
const same = { date: "2026-05-10", type: "RETENCION IVA", amount: "2500.00", description: "Banco Galicia", expectedUpdatedAt: T0 };

const patch = (body: unknown, id = TAX) =>
  PATCH(
    new Request(`http://localhost/api/taxes/${id}`, { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }),
    ctx(id),
  );
const edit = (over: Record<string, unknown> = {}, id = TAX) => patch({ ...same, ...over }, id);
const del = (expected: string | null = T0, id = TAX) =>
  DELETE(
    new Request(`http://localhost/api/taxes/${id}${expected === null ? "" : `?expectedUpdatedAt=${encodeURIComponent(expected)}`}`, {
      method: "DELETE",
    }),
    ctx(id),
  );

const row = (id = TAX) => (world.taxRecords ?? []).find((t) => t.id === id);
const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
const taxRecordLockOrder = () => rawCallOrder(db, /FROM "TaxRecord"[\s\S]*FOR UPDATE/);
const lockTargets = () => rec.locks.map((l) => `${/FROM "TaxRecord"/.test(l.sql) ? "TaxRecord" : "Period"}:${l.values[0]}`);

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

const expectUnchanged = (id = TAX) => {
  expect(row(id)?.updatedAt.toISOString()).toBe(T0);
  expect(rec.created.taxRecordUpdate).toBeUndefined();
  expect(rec.audits).toHaveLength(0);
};
const expectNotDeleted = (id = TAX) => {
  expect(row(id)).toBeDefined();
  expect(rec.created.taxRecordDelete).toBeUndefined();
  expect(rec.audits).toHaveLength(0);
};
const errorOf = async (res: Response) => (await res.json()) as { error: { code: string; message: string }; field?: string };

// ═════════════════════════════════════════════════════════════════════════
// PATCH
// ═════════════════════════════════════════════════════════════════════════

describe("PATCH /api/taxes/[id] — éxito y changedFields", () => {
  it("200: actualiza por { id, organizationId }, con autoría, y audita taxrecord.update con metadata exacta", async () => {
    const res = await edit({ date: "2026-05-20", type: "PERCEPCION IVA", amount: "2600.50", description: "  Banco Nación  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: TAX,
      date: "2026-05-20T00:00:00.000Z",
      type: "PERCEPCION IVA",
      amount: "2600.50",
      description: "Banco Nación",
      periodId: "p_a",
      // Token nuevo de la fila confirmada (harness: TAX_RECORD_UPDATED_AT_AFTER).
      updatedAt: "2026-05-16T11:22:33.456Z",
    });
    expect(db.taxRecord.update).toHaveBeenCalledTimes(1);
    const args = db.taxRecord.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: TAX, organizationId: ORG_A });
    expect(Object.keys(args.data).sort()).toEqual(["amount", "date", "description", "type", "updatedById"]);
    expect(args.data).toMatchObject({ type: "PERCEPCION IVA", description: "Banco Nación", updatedById: SUB_OWNER_A });
    expect(args.data.amount.toFixed(2)).toBe("2600.50");
    expect(row()?.updatedAt.toISOString()).toBe(TAX_RECORD_UPDATED_AT_AFTER);

    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toEqual({
      organizationId: ORG_A,
      actorProfileId: SUB_OWNER_A,
      action: "taxrecord.update",
      targetType: "TaxRecord",
      targetId: TAX,
      metadata: { periodId: "p_a", typeBefore: "RETENCION IVA", typeAfter: "PERCEPCION IVA", changedFields: "date,type,amount,description" },
    });
    expect(JSON.stringify(rec.audits[0])).not.toMatch(/2600|2500|Galicia|Nación|2026-05/);
  });

  it.each([
    ["date", { date: "2026-05-31" }],
    ["type", { type: "SIRCREB" }],
    ["amount", { amount: "0.01" }],
    ["description", { description: "Otro banco" }],
    ["description", { description: null }],
    ["description", { description: "" }],
  ])("cambio de un campo -> changedFields %s", async (field, over) => {
    expect((await edit(over)).status).toBe(200);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0].metadata.changedFields).toBe(field);
  });

  it("changedFields en orden canónico aunque el cuerpo traiga las claves en otro orden", async () => {
    const res = await patch({ expectedUpdatedAt: T0, description: "X", amount: "1.00", type: "SIRTAC", date: "2026-05-01" });
    expect(res.status).toBe(200);
    expect(rec.audits[0].metadata.changedFields).toBe("date,type,amount,description");
  });

  it.each([
    ["cuerpo idéntico", {}],
    ["mismo importe con otra escala", { amount: "2500" }],
    ["misma descripción con espacios", { description: "  Banco Galicia  " }],
    ["periodId igual al actual", { periodId: "p_a" }],
  ])("no-op (%s): 200 con la fila vigente, sin update ni AuditLog", async (_l, over) => {
    const res = await edit(over);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: TAX,
      date: "2026-05-10T00:00:00.000Z",
      type: "RETENCION IVA",
      amount: "2500.00",
      description: "Banco Galicia",
      periodId: "p_a",
      // No-op: el token vigente de la fila bloqueada.
      updatedAt: "2026-05-15T10:20:30.123Z",
    });
    expect(db.taxRecord.update).not.toHaveBeenCalled();
    expectUnchanged();
    expect(rec.txOptions).toEqual([PERIOD_WRITE_TX_OPTIONS]);
  });

  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s puede editar", async (_l, sub) => {
    as(sub);
    expect((await edit({ amount: "3000.00" })).status).toBe(200);
    expect(rec.audits[0].actorProfileId).toBe(sub);
  });
});

describe("PATCH /api/taxes/[id] — tipo histórico fuera del catálogo", () => {
  it("se normaliza: exige un tipo del catálogo; changedFields incluye type y typeBefore conserva el valor histórico", async () => {
    const res = await edit({ description: "carga manual" }, LEGACY);
    expect(res.status).toBe(200);
    expect(row(LEGACY)?.type).toBe("RETENCION IVA");
    expect(rec.audits[0].metadata).toEqual({
      periodId: "p_a",
      typeBefore: "RETENCION GANANCIAS",
      typeAfter: "RETENCION IVA",
      changedFields: "type",
    });
  });

  it("conservar el tipo histórico -> 422 type, sin transacción", async () => {
    const res = await edit({ type: "RETENCION GANANCIAS" }, LEGACY);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).field).toBe("type");
    expect(db.$transaction).not.toHaveBeenCalled();
    expectUnchanged(LEGACY);
  });
});

describe("PATCH /api/taxes/[id] — autenticación, autorización y aislamiento", () => {
  it("sin sesión (aun con JSON inválido) -> 401", async () => {
    as(null);
    expect((await patch("{")).status).toBe(401);
  });

  it("sin Profile -> 403 NO_PROFILE", async () => {
    as(SUB_NO_PROFILE);
    expect((await errorOf(await edit())).error.code).toBe("NO_PROFILE");
  });

  it("VIEWER -> 403 antes de leer nada", async () => {
    as(SUB_VIEWER_A);
    expect((await edit({ amount: "1.00" })).status).toBe(403);
    expect(db.taxRecord.findFirst).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("JSON inválido -> 400 BAD_REQUEST (antes de buscar el registro)", async () => {
    const res = await patch("{");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).error.code).toBe("BAD_REQUEST");
    expect(db.taxRecord.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ["id inexistente", () => edit({}, "t_missing")],
    ["registro de otra organización", () => edit({}, "t_b")],
    ["usuario de otra organización", () => (as(SUB_OWNER_B), edit())],
  ])("%s -> 404 sin transacción", async (_l, run) => {
    const res = await (run as () => Promise<Response>)();
    expect(res.status).toBe(404);
    expect((await errorOf(res)).error.code).toBe("NOT_FOUND");
    expect(db.$transaction).not.toHaveBeenCalled();
    expectUnchanged();
  });

  it("la lectura previa se acota a la organización activa", async () => {
    await edit({ amount: "1.00" });
    expect(db.taxRecord.findFirst).toHaveBeenCalledWith({ where: { id: TAX, organizationId: ORG_A }, select: { periodId: true } });
  });

  it("período del registro inaccesible (Membership retirada) -> 404 sin transacción", async () => {
    world.periods = world.periods.filter((p) => p.id !== "p_a");
    expect((await edit({ amount: "1.00" })).status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/taxes/[id] — validación (422)", () => {
  it.each([
    ["date", { date: "2026-02-30" }],
    ["date", { date: "2026-05-10T00:00:00Z" }],
    ["type", { type: "OTRO" }],
    ["amount", { amount: "0" }],
    ["amount", { amount: "-1" }],
    ["amount", { amount: "1.001" }],
    ["description", { description: "x".repeat(201) }],
    ["description", { description: 5 }],
    ["expectedUpdatedAt", { expectedUpdatedAt: undefined }],
    ["expectedUpdatedAt", { expectedUpdatedAt: "2026-05-15" }],
    ["periodId", { periodId: "p_a_jun" }],
  ])("%s inválido -> 422 con field, sin transacción", async (field, over) => {
    const res = await edit(over);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).field).toBe(field);
    expect(db.$transaction).not.toHaveBeenCalled();
    expectUnchanged();
  });

  it("fecha fuera del período releído bajo el lock -> 422 date, sin update ni AuditLog (rollback)", async () => {
    const res = await edit({ date: "2026-06-01" });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toEqual({
      error: { code: "UNPROCESSABLE_ENTITY", message: "la fecha debe pertenecer al período 05/2026" },
      field: "date",
    });
    expect(lockTargets()).toEqual(["Period:p_a", "TaxRecord:t_a"]);
    expect(db.taxRecord.update).not.toHaveBeenCalled();
    expectUnchanged();
  });

  it("cambio de año: diciembre del año anterior fuera de un período de enero", async () => {
    world.periods.push(periodRow("p_ene", "c_a", ORG_A, { month: 1, year: 2026 }));
    world.taxRecords!.push(taxRecordRow("t_ene", "p_ene", ORG_A, { date: new Date("2026-01-05T00:00:00.000Z") }));
    const res = await edit({ date: "2025-12-31" }, "t_ene");
    expect(res.status).toBe(422);
    expect((await errorOf(res)).error.message).toBe("la fecha debe pertenecer al período 01/2026");
  });
});

describe("PATCH /api/taxes/[id] — concurrencia (stale), período y bloqueo", () => {
  const expectStale = async (res: Response) => {
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ error: { code: "CONFLICT", message: STALE_MESSAGE } });
  };

  it("updatedAt distinto del esperado -> 409 stale", async () => {
    await expectStale(await edit({ amount: "1.00", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }));
    expectUnchanged();
  });

  it("el registro cambió de período en paralelo -> 409 stale (periodId de la fila bloqueada)", async () => {
    onPeriodLock(() => (row()!.periodId = "p_a_jun"));
    await expectStale(await edit({ amount: "1.00" }));
    expect(db.taxRecord.update).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("el período cambió de cliente en paralelo -> 409 stale, antes de bloquear el TaxRecord", async () => {
    onPeriodLock(() => (world.periods.find((p) => p.id === "p_a")!.clientId = "c_other"));
    await expectStale(await edit({ amount: "1.00" }));
    expect(lockTargets()).toEqual(["Period:p_a"]);
    expectUnchanged();
  });

  it("el período desapareció antes del lock -> 404 sin bloquear el TaxRecord", async () => {
    onPeriodLock(() => world.periods.splice(world.periods.findIndex((p) => p.id === "p_a"), 1));
    expect((await edit({ amount: "1.00" })).status).toBe(404);
    expect(lockTargets()).toEqual(["Period:p_a"]);
    expectUnchanged();
  });

  it("la relectura del período bajo el lock no lo encuentra -> 404", async () => {
    db.period.findFirst.mockResolvedValueOnce(null);
    expect((await edit({ amount: "1.00" })).status).toBe(404);
    expect(lockTargets()).toEqual(["Period:p_a"]);
    expectUnchanged();
  });

  it("el TaxRecord desapareció en paralelo -> 404 tras bloquear Period y TaxRecord", async () => {
    onPeriodLock(() => (world.taxRecords = world.taxRecords!.filter((t) => t.id !== TAX)));
    expect((await edit({ amount: "1.00" })).status).toBe(404);
    expect(lockTargets()).toEqual(["Period:p_a", "TaxRecord:t_a"]);
    expect(db.taxRecord.update).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("período ocupado (55P03) -> 409 PERIOD_BUSY exacto, sin bloquear el TaxRecord ni escribir; rollback", async () => {
    rec.periodLockBusy = true;
    const { result: res, unclassified } = await loggedUnclassified(() => edit({ amount: "1.00" }));
    await expectPeriodBusyResponse(res);
    expect(unclassified).toBe(false);
    expectBusyRollback(rec);
    expectUnchanged();
  });

  it("orden: lock Period -> relectura del Period -> lock TaxRecord -> update -> AuditLog, en una transacción con opciones exactas", async () => {
    expect((await edit({ amount: "1.00" })).status).toBe(200);
    expect(rec.rawSteps).toEqual([...periodLockSteps("0"), "lock:TaxRecord@0"]);
    expect(rec.locks.map((l) => l.values)).toEqual([["p_a", ORG_A], [TAX, ORG_A]]);
    expect(periodLockOrder(db)).toBeGreaterThan(order(db.$transaction));
    expect(periodLockOrder(db)).toBeLessThan(order(db.period.findFirst));
    expect(order(db.period.findFirst)).toBeLessThan(taxRecordLockOrder());
    expect(taxRecordLockOrder()).toBeLessThan(order(db.taxRecord.update));
    expect(order(db.taxRecord.update)).toBeLessThan(order(db.auditLog.create));
    expect(db.period.findFirst).toHaveBeenCalledWith({
      where: { id: "p_a", organizationId: ORG_A },
      select: { id: true, organizationId: true, clientId: true, month: true, year: true },
    });
    expect(rec.txOptions).toEqual([PERIOD_WRITE_TX_OPTIONS]);
  });

  it("si falla el update -> 500 genérico, sin AuditLog y sin cambios", async () => {
    db.taxRecord.update.mockRejectedValueOnce(new Error("db down"));
    const { result: res } = await loggedUnclassified(() => edit({ amount: "1.00" }));
    expect(res.status).toBe(500);
    expect((await errorOf(res)).error.code).toBe("INTERNAL");
    expectUnchanged();
  });

  it("si falla el AuditLog -> 500 y rollback total del update", async () => {
    rec.failAudit = true;
    const { result: res } = await loggedUnclassified(() => edit({ amount: "1.00" }));
    expect(res.status).toBe(500);
    expect(row()?.amount.toFixed(2)).toBe("2500.00");
    expectUnchanged();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// DELETE
// ═════════════════════════════════════════════════════════════════════════

describe("DELETE /api/taxes/[id] — éxito", () => {
  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
  ])("204 (%s): borra por { id, organizationId } y audita taxrecord.delete con { periodId, type }", async (_l, sub) => {
    as(sub);
    const res = await del();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(row()).toBeUndefined();
    expect(db.taxRecord.deleteMany).toHaveBeenCalledWith({ where: { id: TAX, organizationId: ORG_A } });
    expect(rec.audits).toEqual([
      {
        organizationId: ORG_A,
        actorProfileId: sub,
        action: "taxrecord.delete",
        targetType: "TaxRecord",
        targetId: TAX,
        metadata: { periodId: "p_a", type: "RETENCION IVA" },
      },
    ]);
    expect(JSON.stringify(rec.audits[0])).not.toMatch(/2500|Galicia|2026-05-10/);
  });

  it("tipo histórico fuera del catálogo -> se puede eliminar; se audita el valor histórico", async () => {
    expect((await del(T0, LEGACY)).status).toBe(204);
    expect(row(LEGACY)).toBeUndefined();
    expect(rec.audits[0].metadata).toEqual({ periodId: "p_a", type: "RETENCION GANANCIAS" });
  });
});

describe("DELETE /api/taxes/[id] — autorización, entrada y aislamiento", () => {
  it.each([
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
    ["VIEWER", SUB_VIEWER_A],
  ])("%s -> 403 sin leer ni borrar", async (_l, sub) => {
    as(sub);
    expect((await del()).status).toBe(403);
    expect(db.taxRecord.findFirst).not.toHaveBeenCalled();
    expectNotDeleted();
  });

  it("sin sesión -> 401", async () => {
    as(null);
    expect((await del()).status).toBe(401);
  });

  it.each([
    ["ausente", null],
    ["sin milisegundos", "2026-05-15T10:20:30Z"],
    ["sólo fecha", "2026-05-15"],
    ["texto", "ayer"],
  ])("expectedUpdatedAt %s -> 422 expectedUpdatedAt, sin leer ni borrar", async (_l, expected) => {
    const res = await del(expected);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).field).toBe("expectedUpdatedAt");
    expect(db.taxRecord.findFirst).not.toHaveBeenCalled();
    expectNotDeleted();
  });

  it.each([
    ["id inexistente", () => del(T0, "t_missing")],
    ["registro de otra organización", () => del(T0, "t_b")],
    ["usuario de otra organización", () => (as(SUB_OWNER_B), del())],
  ])("%s -> 404 sin transacción", async (_l, run) => {
    expect((await (run as () => Promise<Response>)()).status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
    expectNotDeleted();
    expect(row("t_b")).toBeDefined();
  });
});

describe("DELETE /api/taxes/[id] — concurrencia, bloqueo y atomicidad", () => {
  const expectStale = async (res: Response) => {
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ error: { code: "CONFLICT", message: STALE_MESSAGE } });
  };

  it("updatedAt distinto -> 409 stale", async () => {
    await expectStale(await del("2020-01-01T00:00:00.000Z"));
    expectNotDeleted();
  });

  it("el registro cambió de período en paralelo -> 409 stale", async () => {
    onPeriodLock(() => (row()!.periodId = "p_a_jun"));
    await expectStale(await del());
    expect(db.taxRecord.deleteMany).not.toHaveBeenCalled();
    expectNotDeleted();
  });

  it("el período cambió de cliente en paralelo -> 409 stale, antes de bloquear el TaxRecord", async () => {
    onPeriodLock(() => (world.periods.find((p) => p.id === "p_a")!.clientId = "c_other"));
    await expectStale(await del());
    expect(lockTargets()).toEqual(["Period:p_a"]);
    expectNotDeleted();
  });

  it("el período desapareció -> 404 sin bloquear el TaxRecord", async () => {
    onPeriodLock(() => world.periods.splice(world.periods.findIndex((p) => p.id === "p_a"), 1));
    expect((await del()).status).toBe(404);
    expect(lockTargets()).toEqual(["Period:p_a"]);
    expectNotDeleted();
  });

  it("el TaxRecord desapareció en paralelo -> 404", async () => {
    onPeriodLock(() => (world.taxRecords = world.taxRecords!.filter((t) => t.id !== TAX)));
    expect((await del()).status).toBe(404);
    expect(db.taxRecord.deleteMany).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("período ocupado (55P03) -> 409 PERIOD_BUSY exacto; rollback sin borrar", async () => {
    rec.periodLockBusy = true;
    const { result: res, unclassified } = await loggedUnclassified(() => del());
    await expectPeriodBusyResponse(res);
    expect(unclassified).toBe(false);
    expectBusyRollback(rec);
    expectNotDeleted();
  });

  it.each([[0], [2]])("deleteMany con count %i -> 500 y rollback sin AuditLog", async (count) => {
    db.taxRecord.deleteMany.mockResolvedValueOnce({ count });
    const { result: res } = await loggedUnclassified(() => del());
    expect(res.status).toBe(500);
    expect((await errorOf(res)).error.code).toBe("INTERNAL");
    expectNotDeleted();
  });

  it("si falla el AuditLog -> 500 y rollback total (la fila vuelve)", async () => {
    rec.failAudit = true;
    const { result: res } = await loggedUnclassified(() => del());
    expect(res.status).toBe(500);
    expect(db.taxRecord.deleteMany).toHaveBeenCalledTimes(1);
    expect(row()?.updatedAt.toISOString()).toBe(T0);
    expect(rec.audits).toHaveLength(0);
  });

  it("orden: lock Period -> relectura -> lock TaxRecord -> deleteMany -> AuditLog, con opciones exactas", async () => {
    expect((await del()).status).toBe(204);
    expect(rec.rawSteps).toEqual([...periodLockSteps("0"), "lock:TaxRecord@0"]);
    expect(rec.locks.map((l) => l.values)).toEqual([["p_a", ORG_A], [TAX, ORG_A]]);
    expect(periodLockOrder(db)).toBeLessThan(order(db.period.findFirst));
    expect(order(db.period.findFirst)).toBeLessThan(taxRecordLockOrder());
    expect(taxRecordLockOrder()).toBeLessThan(order(db.taxRecord.deleteMany));
    expect(order(db.taxRecord.deleteMany)).toBeLessThan(order(db.auditLog.create));
    expect(rec.txOptions).toEqual([PERIOD_WRITE_TX_OPTIONS]);
  });
});

describe("FOR UPDATE de TaxRecord — forma de la consulta", () => {
  it("SQL parametrizado con columnas exactas, id y organización; sin Period", async () => {
    expect((await edit({ amount: "1.00" })).status).toBe(200);
    const lock = rec.locks.find((l) => /FROM "TaxRecord"/.test(l.sql))!;
    expect(lock.sql.replace(/\s+/g, " ").trim()).toBe(
      'SELECT "id", "organizationId", "periodId", "type", "date", "amount", "description", "updatedAt" FROM "TaxRecord" WHERE "id" = ? AND "organizationId" = ? FOR UPDATE',
    );
    expect(lock.values).toEqual([TAX, ORG_A]);
  });

  it("devuelve importes como Decimal: la comparación de changedFields no pasa por number", async () => {
    world.taxRecords![0].amount = new Prisma.Decimal("9007199254740993.01");
    expect((await edit({ amount: "9007199254740993.01" })).status).toBe(200);
    expect(db.taxRecord.update).not.toHaveBeenCalled();
    expect((await edit({ amount: "9007199254740993.02" })).status).toBe(200);
    expect(rec.audits[0].metadata.changedFields).toBe("amount");
  });
});
