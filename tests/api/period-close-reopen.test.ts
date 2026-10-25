import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  closedPeriodRow,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  SUB_NO_PROFILE,
  SUB_NO_ORG,
  ORG_A,
  ORG_B,
  PERIOD_UPDATED_AT,
  type World,
  periodLockSteps,
  periodLockOrder,
  PERIOD_WRITE_TX_OPTIONS,
  expectPeriodBusyResponse,
  expectBusyRollback,
  expectPeriodClosedResponse,
  loggedUnclassified,
} from "./_harness";
import { POST as CLOSE } from "@/app/api/periods/[id]/close/route";
import { POST as REOPEN } from "@/app/api/periods/[id]/reopen/route";
import { POST as CREATE_TAX } from "@/app/api/taxes/route";

/**
 * POST /api/periods/[id]/close y /reopen: roles, aislamiento, token de
 * versión (Period.updatedAt), no-op, contención, rollback y el bloqueo
 * compartido con las escrituras del contenido.
 */

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

const T0 = PERIOD_UPDATED_AT;
const STALE_BODY = {
  error: {
    code: "CONFLICT",
    message: "El estado del período cambió desde que abriste esta pantalla. Recargala para ver el estado actual.",
  },
};

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  world = makeWorld({
    periods: [
      periodRow("p_a", "c_a", ORG_A, { month: 5, year: 2026 }),
      closedPeriodRow("p_closed", "c_a", ORG_A, { month: 4, year: 2026 }),
      periodRow("p_b", "c_b", ORG_B),
    ],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

afterEach(() => {
  vi.useRealTimers();
});

const as = (sub: string | null) => (H.claims.value = claimsFor(sub));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const close = (id = "p_a", body: unknown = { expectedUpdatedAt: T0 }) => CLOSE(req(`/api/periods/${id}/close`, body), ctx(id));
const reopen = (id = "p_closed", body: unknown = { expectedUpdatedAt: T0 }) => REOPEN(req(`/api/periods/${id}/reopen`, body), ctx(id));
const period = (id: string) => world.periods.find((p) => p.id === id)!;
const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

const expectNoTransition = () => {
  expect(db.period.update).not.toHaveBeenCalled();
  expect(rec.audits).toHaveLength(0);
};

describe("POST /api/periods/[id]/close", () => {
  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s -> 200; CLOSED + closedAt + closedById + nueva versión + AuditLog period.close", async (_r, sub) => {
    as(sub);
    const res = await close();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    const body = await res.json();
    const p = period("p_a");
    expect(p.status).toBe("CLOSED");
    expect(p.closedAt).toBeInstanceOf(Date);
    expect(p.closedById).toBe(sub);
    expect(p.updatedById).toBe(sub);
    expect(p.updatedAt.getTime()).toBeGreaterThan(new Date(T0).getTime());
    expect(body).toEqual({ periodId: "p_a", status: "CLOSED", updatedAt: p.updatedAt.toISOString() });
    expect(rec.audits).toEqual([
      {
        organizationId: ORG_A,
        actorProfileId: sub,
        action: "period.close",
        targetType: "Period",
        targetId: "p_a",
        metadata: { clientId: "c_a", month: 5, year: 2026 },
      },
    ]);
  });

  it("escribe SÓLO el estado, el cierre, el actor y la versión de la fila (organización acotada en el where)", async () => {
    await close();
    expect(db.period.update).toHaveBeenCalledTimes(1);
    const args = db.period.update.mock.calls[0][0];
    expect(args.where).toEqual({ id_organizationId: { id: "p_a", organizationId: ORG_A } });
    expect(Object.keys(args.data).sort()).toEqual(["closedAt", "closedById", "status", "updatedAt", "updatedById"]);
    expect(args.data.closedAt).toEqual(period("p_a").closedAt);
  });

  it("orden: transacción única con opciones exactas -> lock Period (status) -> relectura -> update -> AuditLog", async () => {
    expect((await close()).status).toBe(200);
    expect(rec.rawSteps).toEqual(periodLockSteps("0"));
    expect(rec.locks.map((l) => l.values)).toEqual([["p_a", ORG_A]]);
    expect(rec.locks[0].sql).toMatch(/"status"::text AS "status"/);
    expect(rec.txOptions).toEqual([PERIOD_WRITE_TX_OPTIONS]);
    expect(periodLockOrder(db)).toBeGreaterThan(order(db.$transaction));
    expect(periodLockOrder(db)).toBeLessThan(order(db.period.findFirst));
    expect(order(db.period.findFirst)).toBeLessThan(order(db.period.update));
    expect(order(db.period.update)).toBeLessThan(order(db.auditLog.create));
    expect(db.period.findFirst).toHaveBeenCalledWith({
      where: { id: "p_a", organizationId: ORG_A },
      select: { clientId: true, month: true, year: true, updatedAt: true },
    });
  });

  it("no exige que la liquidación sea calculable ni lee el contenido del período", async () => {
    expect((await close()).status).toBe(200);
    expect(db.invoice.findMany).not.toHaveBeenCalled();
    expect(db.invoice.count).not.toHaveBeenCalled();
    expect(db.taxRecord.count).not.toHaveBeenCalled();
    expect(db.periodVatSettings.findUnique).not.toHaveBeenCalled();
  });

  it("VIEWER -> 403 FORBIDDEN antes de leer el cuerpo; sin transacción", async () => {
    as(SUB_VIEWER_A);
    const res = await close("p_a", "{malformado");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(period("p_a").status).toBe("OPEN");
  });

  it.each([
    ["sin sesión", null, 401, "UNAUTHENTICATED"],
    ["sin Profile", SUB_NO_PROFILE, 403, "NO_PROFILE"],
    ["sin organización", SUB_NO_ORG, 403, "NO_ORGANIZATION"],
  ])("%s -> %i %s; sin transacción", async (_l, sub, status, code) => {
    as(sub);
    const res = await close();
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("período de OTRA organización -> 404 idéntico al inexistente; sin transacción ni cambios", async () => {
    as(SUB_OWNER_B);
    const foreign = await close("p_a");
    const missing = await close("p_missing");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(period("p_a").status).toBe("OPEN");
  });

  it.each([
    ["JSON malformado", "{malformado", 400, "BAD_REQUEST"],
    ["sin expectedUpdatedAt", {}, 422, "UNPROCESSABLE_ENTITY"],
    ["expectedUpdatedAt sin milisegundos", { expectedUpdatedAt: "2026-01-01T00:00:00Z" }, 422, "UNPROCESSABLE_ENTITY"],
    ["expectedUpdatedAt numérico", { expectedUpdatedAt: 0 }, 422, "UNPROCESSABLE_ENTITY"],
    ["cuerpo array", [], 422, "UNPROCESSABLE_ENTITY"],
  ])("%s -> %i %s; sin transacción", async (_l, body, status, code) => {
    const res = await close("p_a", body);
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.error.code).toBe(code);
    if (status === 422 && !Array.isArray(body)) expect(json.field).toBe("expectedUpdatedAt");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("token obsoleto -> 409 CONFLICT exacto ANTES de la transición: bajo el bloqueo, sin update ni AuditLog", async () => {
    const res = await close("p_a", { expectedUpdatedAt: "2025-12-31T23:59:59.999Z" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(STALE_BODY);
    expect(rec.rawSteps).toEqual(periodLockSteps("0"));
    expectNoTransition();
    expect(period("p_a").status).toBe("OPEN");
  });

  it("ya cerrado con el token vigente -> 200 sin escritura ni AuditLog (no-op), con el estado y la versión actuales", async () => {
    const res = await close("p_closed");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ periodId: "p_closed", status: "CLOSED", updatedAt: T0 });
    expectNoTransition();
  });

  it("período ocupado (55P03) -> 409 PERIOD_BUSY exacto; sin relectura, update ni AuditLog; rollback", async () => {
    rec.periodLockBusy = true;
    const { result: res, unclassified } = await loggedUnclassified(() => close());
    await expectPeriodBusyResponse(res);
    expect(unclassified).toBe(false);
    expectBusyRollback(rec);
    expect(db.period.findFirst).not.toHaveBeenCalled();
    expectNoTransition();
    expect(period("p_a").status).toBe("OPEN");
  });

  it("período eliminado mientras esperaba el bloqueo -> 404, sin update ni AuditLog", async () => {
    const base = db.$queryRaw.getMockImplementation()!;
    let done = false;
    db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!done && /FROM "Period"/.test(strings.join("?"))) {
        done = true;
        world.periods.splice(world.periods.findIndex((p) => p.id === "p_a"), 1);
      }
      return base(strings, ...values);
    });
    const res = await close();
    expect(res.status).toBe(404);
    expectNoTransition();
  });

  it("falla el AuditLog -> 500 genérico y rollback: el período sigue ABIERTO con su versión", async () => {
    rec.failAudit = true;
    const { result: res } = await loggedUnclassified(() => close());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
    expect(period("p_a").status).toBe("OPEN");
    expect(period("p_a").closedAt).toBeNull();
    expect(period("p_a").updatedAt.toISOString()).toBe(T0);
    expect(rec.audits).toHaveLength(0);
  });

  it("estado desconocido bajo el bloqueo -> 500 genérico, sin transición", async () => {
    world.periods[0] = { ...world.periods[0], status: "ARCHIVED" };
    const { result: res } = await loggedUnclassified(() => close());
    expect(res.status).toBe(500);
    expectNoTransition();
  });

  it("misma marca de tiempo que la versión previa -> la nueva versión es estrictamente posterior (+1 ms)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(T0));
    const res = await close();
    const { updatedAt } = await res.json();
    expect(updatedAt).toBe("2026-01-01T00:00:00.001Z");
    expect(period("p_a").closedAt?.toISOString()).toBe(T0);
  });
});

describe("POST /api/periods/[id]/reopen", () => {
  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
  ])("%s -> 200; OPEN, closedAt y closedById en NULL, nueva versión + AuditLog period.reopen", async (_r, sub) => {
    as(sub);
    const res = await reopen();
    expect(res.status).toBe(200);
    const p = period("p_closed");
    expect(p.status).toBe("OPEN");
    expect(p.closedAt).toBeNull();
    expect(p.closedById).toBeNull();
    expect(p.updatedById).toBe(sub);
    expect(p.updatedAt.getTime()).toBeGreaterThan(new Date(T0).getTime());
    expect(await res.json()).toEqual({ periodId: "p_closed", status: "OPEN", updatedAt: p.updatedAt.toISOString() });
    expect(rec.audits).toEqual([
      {
        organizationId: ORG_A,
        actorProfileId: sub,
        action: "period.reopen",
        targetType: "Period",
        targetId: "p_closed",
        metadata: { clientId: "c_a", month: 4, year: 2026 },
      },
    ]);
    expect(rec.txOptions).toEqual([PERIOD_WRITE_TX_OPTIONS]);
    expect(rec.rawSteps).toEqual(periodLockSteps("0"));
  });

  it("escribe SÓLO estado, limpieza del cierre, actor y versión", async () => {
    await reopen();
    const args = db.period.update.mock.calls[0][0];
    expect(args.where).toEqual({ id_organizationId: { id: "p_closed", organizationId: ORG_A } });
    expect(args.data).toMatchObject({ status: "OPEN", closedAt: null, closedById: null, updatedById: SUB_OWNER_A });
    expect(Object.keys(args.data).sort()).toEqual(["closedAt", "closedById", "status", "updatedAt", "updatedById"]);
  });

  it.each([
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
    ["VIEWER", SUB_VIEWER_A],
  ])("%s -> 403 FORBIDDEN; sin transacción y el período sigue cerrado", async (_r, sub) => {
    as(sub);
    const res = await reopen();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(period("p_closed").status).toBe("CLOSED");
  });

  it("período de OTRA organización -> 404; sin transacción", async () => {
    as(SUB_OWNER_B);
    expect((await reopen("p_closed")).status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("token obsoleto -> 409 CONFLICT exacto, sin update ni AuditLog; sigue cerrado", async () => {
    const res = await reopen("p_closed", { expectedUpdatedAt: "2026-01-01T00:00:00.001Z" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(STALE_BODY);
    expectNoTransition();
    expect(period("p_closed").status).toBe("CLOSED");
  });

  it("ya abierto con el token vigente -> 200 no-op sin escritura ni AuditLog", async () => {
    const res = await reopen("p_a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ periodId: "p_a", status: "OPEN", updatedAt: T0 });
    expectNoTransition();
  });

  it("falla el AuditLog -> 500 y rollback: sigue CERRADO con closedAt y closedById intactos", async () => {
    rec.failAudit = true;
    const before = { ...period("p_closed") };
    const { result: res } = await loggedUnclassified(() => reopen());
    expect(res.status).toBe(500);
    expect(period("p_closed")).toEqual(before);
  });

  it("período ocupado (55P03) -> 409 PERIOD_BUSY; sigue cerrado", async () => {
    rec.periodLockBusy = true;
    await expectPeriodBusyResponse(await reopen());
    expectNoTransition();
    expect(period("p_closed").status).toBe("CLOSED");
  });
});

describe("pantallas viejas y bloqueo compartido con las escrituras", () => {
  const tax = { date: "2026-05-10", type: "RETENCION IVA", amount: "2500.00", periodId: "p_a" };
  const createTax = () => CREATE_TAX(req("/api/taxes", tax));

  it("dos pantallas con la misma versión: la segunda transición (cerrar o reabrir) recibe 409 sin aplicar nada", async () => {
    const first = await close();
    expect(first.status).toBe(200);
    const v1 = (await first.json()).updatedAt;

    // Pantalla vieja (T0) que intenta cerrar otra vez o reabrir: ambas obsoletas.
    expect(await (await close("p_a", { expectedUpdatedAt: T0 })).json()).toEqual(STALE_BODY);
    expect(await (await reopen("p_a", { expectedUpdatedAt: T0 })).json()).toEqual(STALE_BODY);
    expect(period("p_a").status).toBe("CLOSED");
    expect(period("p_a").updatedAt.toISOString()).toBe(v1);
    expect(rec.audits.map((a) => a.action)).toEqual(["period.close"]);
  });

  it("cerrar -> reabrir -> la pantalla que vio el primer cierre ya no puede reabrir ni cerrar", async () => {
    const v1 = (await (await close()).json()).updatedAt;
    const v2 = (await (await reopen("p_a", { expectedUpdatedAt: v1 })).json()).updatedAt;
    expect(v2 > v1).toBe(true);
    expect((await reopen("p_a", { expectedUpdatedAt: v1 })).status).toBe(409);
    expect((await close("p_a", { expectedUpdatedAt: v1 })).status).toBe(409);
    expect(period("p_a").status).toBe("OPEN");
    expect(rec.audits.map((a) => a.action)).toEqual(["period.close", "period.reopen"]);
  });

  it("una escritura del contenido se rechaza con el período cerrado y vuelve a admitirse al reabrirlo", async () => {
    expect((await createTax()).status).toBe(201);
    const v1 = (await (await close()).json()).updatedAt;

    await expectPeriodClosedResponse(await createTax());

    expect((await reopen("p_a", { expectedUpdatedAt: v1 })).status).toBe(200);
    expect((await createTax()).status).toBe(201);
    expect(rec.audits.map((a) => a.action)).toEqual(["taxrecord.create", "period.close", "period.reopen", "taxrecord.create"]);
  });

  it("cerrar y escribir usan el MISMO FOR UPDATE de Period (mismo SQL y parámetros)", async () => {
    await close();
    await reopen("p_a", { expectedUpdatedAt: period("p_a").updatedAt.toISOString() });
    await createTax();
    const periodLocks = rec.locks.filter((l) => /FROM "Period"/.test(l.sql));
    expect(periodLocks).toHaveLength(3);
    expect(new Set(periodLocks.map((l) => l.sql.replace(/\s+/g, " ")))).toHaveProperty("size", 1);
    expect(periodLocks.map((l) => l.values)).toEqual([["p_a", ORG_A], ["p_a", ORG_A], ["p_a", ORG_A]]);
  });
});
