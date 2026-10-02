import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
import { PATCH } from "@/app/api/periods/[id]/vat-settings/route";

/**
 * LIMITACIÓN: el harness no tiene una base real ni locks. `$queryRaw` sólo
 * registra la consulta de bloqueo y sus parámetros. Estos tests prueban que la
 * ruta pide el bloqueo de Period dentro de la transacción, con organización,
 * ANTES de leer o escribir; NO prueban concurrencia real entre transacciones.
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

const settings = (periodId: string, over: Record<string, unknown> = {}) => ({
  periodId,
  organizationId: ORG_A,
  creditProrationMode: "GLOBAL",
  globalCoefficient: new Prisma.Decimal("0.5"),
  globalCoefficientStatus: "PROVISIONAL",
  turivaIncluded: true,
  createdById: null,
  updatedById: null,
  ...over,
});
const vatRow = (periodId: string) => (world.vatSettings ?? []).find((s) => s.periodId === periodId);

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  world = makeWorld({
    periods: [
      periodRow("p_new", "c_a", ORG_A, { month: 1 }),
      periodRow("p_on", "c_a", ORG_A, { month: 2 }),
      periodRow("p_off", "c_a", ORG_A, { month: 3 }),
      periodRow("p_t195", "c_a", ORG_A, { month: 4 }),
      periodRow("p_t196", "c_a", ORG_A, { month: 5 }),
      periodRow("p_t197", "c_a", ORG_A, { month: 6 }),
      periodRow("p_b", "c_b", ORG_B),
    ],
    vatSettings: [
      settings("p_on"),
      settings("p_off", { turivaIncluded: false, creditProrationMode: "DIRECT", globalCoefficient: null, globalCoefficientStatus: null }),
      settings("p_t195"),
      settings("p_t196"),
      settings("p_t197"),
      settings("p_b", { organizationId: ORG_B }),
    ],
    invoices: [
      { id: "i_a", periodId: "p_on", organizationId: ORG_A, voucherCode: 1 },
      { id: "i_195", periodId: "p_t195", organizationId: ORG_A, voucherCode: 195 },
      { id: "i_196", periodId: "p_t196", organizationId: ORG_A, voucherCode: 196 },
      { id: "i_197", periodId: "p_t197", organizationId: ORG_A, voucherCode: 197 },
      // Un T de OTRA organización con el mismo periodId no debe contar.
      { id: "i_b", periodId: "p_on", organizationId: ORG_B, voucherCode: 195 },
    ],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

function patch(id: string, body: unknown, raw?: string) {
  return PATCH(
    new Request(`http://localhost/api/periods/${id}/vat-settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
const noWrites = () => {
  expect(db.periodVatSettings.create).not.toHaveBeenCalled();
  expect(db.periodVatSettings.update).not.toHaveBeenCalled();
  expect(rec.audits).toHaveLength(0);
};

describe("PATCH /api/periods/[id]/vat-settings — roles y acceso", () => {
  it.each([
    ["OWNER", SUB_OWNER_A],
    ["ADMIN", SUB_ADMIN_A],
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
  ])("%s activa TurIVA creando la fila con los defaults del schema", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    const res = await patch("p_new", { turivaIncluded: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await res.json()).toEqual({ periodId: "p_new", turivaIncluded: true });
    expect(rec.created.vatSettings).toEqual({
      periodId: "p_new",
      organizationId: ORG_A,
      turivaIncluded: true,
      createdById: sub,
      updatedById: sub,
    });
    expect(vatRow("p_new")).toMatchObject({ creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: true });
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      organizationId: ORG_A,
      actorProfileId: sub,
      action: "period.vat_settings_change",
      targetType: "Period",
      targetId: "p_new",
      metadata: { changedFields: "turivaIncluded", turivaIncludedBefore: false, turivaIncludedAfter: true },
    });
  });

  it("VIEWER -> 403 FORBIDDEN, sin bloqueo ni escritura", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    const res = await patch("p_new", { turivaIncluded: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(rec.locks).toHaveLength(0);
    noWrites();
  });

  it("sin sesión -> 401", async () => {
    H.claims.value = null;
    const res = await patch("p_new", { turivaIncluded: true });
    expect(res.status).toBe(401);
    noWrites();
  });

  it("período de otra organización -> 404 (no se revela), sin bloqueo ni escritura", async () => {
    const res = await patch("p_b", { turivaIncluded: false });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(rec.locks).toHaveLength(0);
    expect(vatRow("p_b")?.turivaIncluded).toBe(true);
    noWrites();
  });

  it("período inexistente -> 404", async () => {
    const res = await patch("p_nope", { turivaIncluded: true });
    expect(res.status).toBe(404);
    noWrites();
  });
});

describe("PATCH /api/periods/[id]/vat-settings — cambios", () => {
  it("activar con fila existente: actualiza SÓLO turivaIncluded y conserva la modalidad de prorrateo", async () => {
    const res = await patch("p_off", { turivaIncluded: true });
    expect(res.status).toBe(200);
    expect(db.periodVatSettings.update).toHaveBeenCalledWith({
      where: { periodId_organizationId: { periodId: "p_off", organizationId: ORG_A } },
      data: { turivaIncluded: true, updatedById: SUB_OWNER_A },
    });
    expect(vatRow("p_off")).toMatchObject({ turivaIncluded: true, creditProrationMode: "DIRECT", globalCoefficient: null });
    expect(rec.audits[0].metadata).toEqual({
      changedFields: "turivaIncluded",
      turivaIncludedBefore: false,
      turivaIncludedAfter: true,
    });
  });

  it("desactivar sin comprobantes 195–197 (hay otros): 200 y conserva GLOBAL y el coeficiente", async () => {
    const res = await patch("p_on", { turivaIncluded: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ periodId: "p_on", turivaIncluded: false });
    const row = vatRow("p_on");
    expect(row?.turivaIncluded).toBe(false);
    expect(row?.creditProrationMode).toBe("GLOBAL");
    expect(row?.globalCoefficient.toString()).toBe("0.5");
    expect(row?.globalCoefficientStatus).toBe("PROVISIONAL");
    expect(rec.audits[0].metadata).toEqual({
      changedFields: "turivaIncluded",
      turivaIncludedBefore: true,
      turivaIncludedAfter: false,
    });
  });

  it.each(["p_t195", "p_t196", "p_t197"])("desactivar con comprobante T (%s) -> 409 sin escritura ni AuditLog", async (id) => {
    const res = await patch(id, { turivaIncluded: false });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/195–197/);
    expect(vatRow(id)?.turivaIncluded).toBe(true);
    expect(rec.locks).toHaveLength(1);
    noWrites();
  });

  it("idempotencia: mismo valor -> 200 sin escritura ni AuditLog (con y sin fila existente)", async () => {
    let res = await patch("p_on", { turivaIncluded: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ periodId: "p_on", turivaIncluded: true });
    res = await patch("p_new", { turivaIncluded: false });
    expect(res.status).toBe(200);
    expect(vatRow("p_new")).toBeUndefined();
    noWrites();
  });

  it("si el AuditLog falla -> 500 y rollback (la configuración no cambia)", async () => {
    rec.failAudit = true;
    const res = await patch("p_off", { turivaIncluded: true });
    expect(res.status).toBe(500);
    expect(vatRow("p_off")?.turivaIncluded).toBe(false);
    expect(rec.audits).toHaveLength(0);
  });
});

describe("PATCH /api/periods/[id]/vat-settings — entrada", () => {
  it.each([
    ["string", { turivaIncluded: "true" }],
    ["número", { turivaIncluded: 1 }],
    ["null", { turivaIncluded: null }],
    ["ausente", {}],
  ])("turivaIncluded %s -> 422 con field, sin transacción", async (_name, body) => {
    const res = await patch("p_new", body);
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(j.field).toBe("turivaIncluded");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("body no objeto (arreglo o número) -> 422 body", async () => {
    for (const body of [[true], 5]) {
      const res = await patch("p_new", body);
      expect(res.status).toBe(422);
      expect((await res.json()).field).toBe("body");
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("JSON malformado o ausente -> 400 BAD_REQUEST", async () => {
    for (const raw of ["{", ""]) {
      const res = await patch("p_new", undefined, raw);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("BAD_REQUEST");
    }
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("organizationId / periodId / clientId / actor del body se IGNORAN", async () => {
    const res = await patch("p_new", {
      turivaIncluded: true,
      organizationId: ORG_B,
      periodId: "p_b",
      clientId: "c_b",
      createdById: "otro",
      creditProrationMode: "GLOBAL",
    });
    expect(res.status).toBe(200);
    expect(rec.created.vatSettings).toEqual({
      periodId: "p_new",
      organizationId: ORG_A,
      turivaIncluded: true,
      createdById: SUB_OWNER_A,
      updatedById: SUB_OWNER_A,
    });
    expect(vatRow("p_b")?.turivaIncluded).toBe(true);
  });
});

describe("PATCH /api/periods/[id]/vat-settings — organización y bloqueo", () => {
  it("toda consulta lleva la organización activa y el bloqueo precede a lectura y escritura", async () => {
    const res = await patch("p_on", { turivaIncluded: false });
    expect(res.status).toBe(200);
    expect(rec.locks).toHaveLength(1);
    expect(rec.locks[0].values).toEqual(["p_on", ORG_A]);
    expect(db.periodVatSettings.findUnique).toHaveBeenCalledWith({
      where: { periodId_organizationId: { periodId: "p_on", organizationId: ORG_A } },
      select: { turivaIncluded: true },
    });
    expect(db.invoice.count).toHaveBeenCalledWith({
      where: { periodId: "p_on", organizationId: ORG_A, voucherCode: { in: [195, 196, 197] } },
    });
    const lockOrder = periodLockOrder(db);
    expect(lockOrder).toBeLessThan(db.periodVatSettings.findUnique.mock.invocationCallOrder[0]);
    expect(lockOrder).toBeLessThan(db.invoice.count.mock.invocationCallOrder[0]);
    expect(lockOrder).toBeLessThan(db.periodVatSettings.update.mock.invocationCallOrder[0]);
  });

  it("secuencia: leer timeout -> set 3000ms -> lock Period -> restaurar; recién después lectura de la configuración, conteo y escritura", async () => {
    expect((await patch("p_on", { turivaIncluded: false })).status).toBe(200);
    expect(rec.rawSteps).toEqual(periodLockSteps("0"));
    const restoreAt = timeoutRestoreOrder(db);
    expect(restoreAt).toBeGreaterThan(periodLockOrder(db));
    expect(restoreAt).toBeLessThan(db.periodVatSettings.findUnique.mock.invocationCallOrder[0]);
    expect(restoreAt).toBeLessThan(db.invoice.count.mock.invocationCallOrder[0]);
    expect(restoreAt).toBeLessThan(db.periodVatSettings.update.mock.invocationCallOrder[0]);
  });

  it("período ocupado (55P03 en el lock de Period) -> 409 PERIOD_BUSY exacto, no-store, sin leer configuración, contar, escribir ni AuditLog; rollback", async () => {
    rec.periodLockBusy = true;
    const { result: res, unclassified } = await loggedUnclassified(() => patch("p_on", { turivaIncluded: false }));
    await expectPeriodBusyResponse(res);
    expect(unclassified).toBe(false);
    expectBusyRollback(rec);
    expect(db.periodVatSettings.findUnique).not.toHaveBeenCalled();
    expect(db.invoice.count).not.toHaveBeenCalled();
    noWrites();
    expect(vatRow("p_on")?.turivaIncluded).toBe(true);
  });

  it("un comprobante T de OTRA organización con el mismo periodId no impide desactivar", async () => {
    const res = await patch("p_on", { turivaIncluded: false });
    expect(res.status).toBe(200);
  });
});

describe("helper lockPeriodForWrite — estructura", () => {
  const helper = readFileSync(repo + "lib/period-lock.ts", "utf8");
  const route = readFileSync(repo + "app/api/periods/[id]/vat-settings/route.ts", "utf8");

  it("SQL parametrizado por tagged template con FOR UPDATE, id y organizationId; sin SQL crudo inseguro ni transacción propia", () => {
    expect(helper.startsWith('import "server-only";')).toBe(true);
    expect(helper).toMatch(/\$queryRaw<.+>`/);
    expect(helper).toContain('FROM "Period"');
    expect(helper).toContain('"id" = ${periodId}');
    expect(helper).toContain('"organizationId" = ${organizationId}');
    expect(helper).toContain("FOR UPDATE");
    expect(helper).not.toMatch(/\$queryRawUnsafe|\$executeRawUnsafe|\$transaction/);
    expect(helper).not.toMatch(/\+\s*periodId|\+\s*organizationId/);
  });

  it("lockPeriodForWrite es el único bloqueo exportado; lockPeriodForUpdate es interno", () => {
    expect(helper).toMatch(/export async function lockPeriodForWrite\(/);
    expect(helper).not.toMatch(/export\s+(async\s+)?function\s+lockPeriodForUpdate/);
    expect(helper).not.toMatch(/export\s*\{[^}]*lockPeriodForUpdate/);
  });

  it("la ruta vat-settings importa el helper y lo invoca dentro de prisma.$transaction", () => {
    expect(route).toMatch(/import \{ lockPeriodForWrite \} from "@\/lib\/period-lock";/);
    expect(route).not.toContain("lockPeriodForUpdate");
    const tx = route.indexOf("prisma.$transaction(");
    const lock = route.indexOf("lockPeriodForWrite(tx, id, organizationId)");
    expect(tx).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(tx);
    expect(lock).toBeLessThan(route.indexOf("periodVatSettings.findUnique"));
  });
});
