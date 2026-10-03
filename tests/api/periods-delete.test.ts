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
import {
  freshDbMock,
  freshRecorder,
  wireDb,
  makeWorld,
  claimsFor,
  periodRow,
  SUB_OWNER_A,
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  SUB_NO_PROFILE,
  SUB_NO_ORG,
  ORG_A,
  ORG_B,
  type World,
  periodLockSteps,
  periodLockOrder,
  timeoutRestoreOrder,
  expectPeriodBusyResponse,
  expectBusyRollback,
  loggedUnclassified,
} from "./_harness";
import { DELETE } from "@/app/api/periods/[id]/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  world = makeWorld({
    periods: [
      periodRow("p_empty", "c_a", ORG_A, { month: 4, year: 2026 }),
      periodRow("p_inv", "c_a", ORG_A, { month: 5, year: 2026 }),
      periodRow("p_tax", "c_a", ORG_A, { month: 6, year: 2026 }),
      periodRow("p_b", "c_b", ORG_B),
    ],
    invoices: [{ id: "i1", periodId: "p_inv", organizationId: ORG_A }],
    taxRecords: [{ id: "t1", periodId: "p_tax", organizationId: ORG_A }],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

function del(id: string) {
  return DELETE(new Request(`http://localhost/api/periods/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}
const exists = (id: string) => world.periods.some((p) => p.id === id);

describe("DELETE /api/periods/[id] — período vacío", () => {
  it("204 (OWNER): elimina y registra period.delete con { clientId, month, year }", async () => {
    const res = await del("p_empty");
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(exists("p_empty")).toBe(false);
    expect(db.period.delete).toHaveBeenCalledWith({
      where: { id_organizationId: { id: "p_empty", organizationId: ORG_A } },
    });
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toEqual({
      organizationId: ORG_A,
      actorProfileId: SUB_OWNER_A,
      action: "period.delete",
      targetType: "Period",
      targetId: "p_empty",
      metadata: { clientId: "c_a", month: 4, year: 2026 },
    });
  });

  it("204 (ADMIN): puede eliminar", async () => {
    H.claims.value = claimsFor(SUB_ADMIN_A);
    expect((await del("p_empty")).status).toBe(204);
    expect(exists("p_empty")).toBe(false);
    expect(rec.audits[0].actorProfileId).toBe(SUB_ADMIN_A);
  });

  it("los conteos de movimientos están acotados a { periodId, organizationId }", async () => {
    await del("p_empty");
    expect(db.invoice.count).toHaveBeenCalledWith({ where: { periodId: "p_empty", organizationId: ORG_A } });
    expect(db.taxRecord.count).toHaveBeenCalledWith({ where: { periodId: "p_empty", organizationId: ORG_A } });
  });
});

describe("DELETE /api/periods/[id] — movimientos bloqueantes", () => {
  it.each([
    ["Invoice", "p_inv"],
    ["TaxRecord", "p_tax"],
  ])("con %s -> 409 CONFLICT legible, sin borrar ni AuditLog", async (_kind, id) => {
    const res = await del(id);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/período tiene comprobantes/);
    expect(db.period.delete).not.toHaveBeenCalled();
    expect(exists(id)).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });

  it("movimiento creado en paralelo (FK Restrict, P2003) -> 409 y rollback, sin AuditLog", async () => {
    db.invoice.count.mockResolvedValueOnce(0); // el conteo no lo ve; la FK sí
    const res = await del("p_inv");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(exists("p_inv")).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });

  it("la fila desaparece entre lectura y borrado (P2025) -> 404", async () => {
    db.period.delete.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("gone", { code: "P2025", clientVersion: "6.19.3" });
    });
    const res = await del("p_empty");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(rec.audits).toHaveLength(0);
  });

  it("otro error de Prisma -> 500 INTERNAL genérico, sin AuditLog", async () => {
    db.period.delete.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("postgresql://user:pass@host/db", {
        code: "P1001",
        clientVersion: "6.19.3",
      });
    });
    const res = await del("p_empty");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toMatch(/postgresql|pass@/);
  });
});

describe("DELETE /api/periods/[id] — autorización y aislamiento", () => {
  it.each([
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
    ["VIEWER", SUB_VIEWER_A],
  ])("%s -> 403 FORBIDDEN, sin borrar ni AuditLog", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    const res = await del("p_empty");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(db.period.findFirst).not.toHaveBeenCalled();
    expect(exists("p_empty")).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });

  it.each([
    ["sin sesión", null, 401, "UNAUTHENTICATED"],
    ["sin Profile", SUB_NO_PROFILE, 403, "NO_PROFILE"],
    ["sin organización", SUB_NO_ORG, 403, "NO_ORGANIZATION"],
  ])("%s -> %i %s", async (_label, sub, status, code) => {
    H.claims.value = claimsFor(sub);
    const res = await del("p_empty");
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(exists("p_empty")).toBe(true);
  });

  it("período de OTRA organización -> 404 idéntico a inexistente, sin revelar movimientos", async () => {
    const other = await del("p_b");
    const missing = await del("p_zzz");
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect(exists("p_b")).toBe(true);
    expect(db.invoice.count).not.toHaveBeenCalled();
    expect(db.taxRecord.count).not.toHaveBeenCalled();
    expect(db.period.delete).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("OWNER de ORG_B sobre un período de ORG_A con movimientos -> 404 (no 409)", async () => {
    H.claims.value = claimsFor(SUB_OWNER_B);
    const res = await del("p_inv");
    expect(res.status).toBe(404);
    expect(exists("p_inv")).toBe(true);
  });

  it("la búsqueda del período se acota a la organización activa", async () => {
    await del("p_empty");
    expect(db.period.findFirst).toHaveBeenCalledWith({ where: { id: "p_empty", organizationId: ORG_A } });
  });
});

describe("DELETE /api/periods/[id] — bloqueo del período (lockPeriodForWrite)", () => {
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
  const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

  it("204: un único bloqueo de Period (id, organización activa) como primera operación; relectura y conteos DESPUÉS", async () => {
    expect((await del("p_empty")).status).toBe(204);
    expect(rec.locks).toHaveLength(1);
    expect(rec.locks[0].sql).toMatch(/FROM "Period"/);
    expect(rec.locks[0].sql).toMatch(/FOR UPDATE/);
    expect(rec.locks[0].values).toEqual(["p_empty", ORG_A]);
    const lockAt = periodLockOrder(db);
    expect(lockAt).toBeGreaterThan(order(db.$transaction));
    expect(lockAt).toBeLessThan(order(db.period.findFirst));
    expect(lockAt).toBeLessThan(order(db.invoice.count));
    expect(lockAt).toBeLessThan(order(db.taxRecord.count));
    expect(order(db.period.findFirst)).toBeLessThan(order(db.period.delete));
  });

  it("secuencia: leer timeout -> set 3000ms -> lock Period -> restaurar; recién después relectura, conteos y borrado", async () => {
    expect((await del("p_empty")).status).toBe(204);
    expect(rec.rawSteps).toEqual(periodLockSteps("0"));
    const restoreAt = timeoutRestoreOrder(db);
    expect(restoreAt).toBeGreaterThan(periodLockOrder(db));
    expect(restoreAt).toBeLessThan(order(db.period.findFirst));
    expect(restoreAt).toBeLessThan(order(db.invoice.count));
    expect(restoreAt).toBeLessThan(order(db.period.delete));
  });

  it("período ocupado (55P03 en el lock de Period) -> 409 PERIOD_BUSY exacto, no-store, sin relectura, conteos, borrado ni AuditLog; rollback", async () => {
    rec.periodLockBusy = true;
    const { result: res, unclassified } = await loggedUnclassified(() => del("p_empty"));
    await expectPeriodBusyResponse(res);
    expect(unclassified).toBe(false);
    expectBusyRollback(rec);
    expect(db.period.findFirst).not.toHaveBeenCalled();
    expect(db.invoice.count).not.toHaveBeenCalled();
    expect(db.taxRecord.count).not.toHaveBeenCalled();
    expect(db.period.delete).not.toHaveBeenCalled();
    expect(exists("p_empty")).toBe(true);
  });

  it.each([
    ["Invoice", () => world.invoices!.push({ id: "i_race", periodId: "p_empty", organizationId: ORG_A })],
    ["TaxRecord", () => world.taxRecords!.push({ id: "t_race", periodId: "p_empty", organizationId: ORG_A })],
  ])("%s confirmado justo antes del bloqueo: los conteos releídos bajo el bloqueo lo ven -> 409, sin borrar ni AuditLog", async (_k, add) => {
    onPeriodLock(add);
    const res = await del("p_empty");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(db.period.delete).not.toHaveBeenCalled();
    expect(exists("p_empty")).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });

  it("período eliminado en paralelo: el bloqueo no lo encuentra -> 404, sin conteos, borrado ni AuditLog", async () => {
    onPeriodLock(() => world.periods.splice(world.periods.findIndex((p) => p.id === "p_empty"), 1));
    const res = await del("p_empty");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(db.period.findFirst).not.toHaveBeenCalled();
    expect(db.invoice.count).not.toHaveBeenCalled();
    expect(db.period.delete).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("período de OTRA organización: el bloqueo (acotado a la organización activa) no lo encuentra -> 404, sin leerlo ni contar", async () => {
    const res = await del("p_b");
    expect(res.status).toBe(404);
    expect(rec.locks).toHaveLength(1);
    expect(rec.locks[0].values).toEqual(["p_b", ORG_A]);
    expect(db.period.findFirst).not.toHaveBeenCalled();
    expect(db.invoice.count).not.toHaveBeenCalled();
    expect(exists("p_b")).toBe(true);
  });

  it("rol insuficiente (403) -> sin transacción ni bloqueo", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    expect((await del("p_empty")).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/periods/[id] — atomicidad", () => {
  it("falla el AuditLog -> 500 y rollback completo (el período sigue existiendo)", async () => {
    rec.failAudit = true;
    const res = await del("p_empty");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
    expect(exists("p_empty")).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });
});
