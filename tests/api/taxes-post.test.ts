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
  SUB_VIEWER_A,
  SUB_NO_PROFILE,
  ORG_A,
  ORG_B,
  type World,
} from "./_harness";
import { POST } from "@/app/api/taxes/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  world = makeWorld();
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

const post = (bodyText: string | undefined) =>
  POST(new Request("http://localhost/api/taxes", { method: "POST", body: bodyText }));
const jbody = (o: unknown) => JSON.stringify(o);
const valid = { date: "2026-05-10", type: "RETENCION IVA", amount: "2500.00", periodId: "p_a" };

describe("POST /api/taxes", () => {
  it("201: crea con organizationId directo, autoría y AuditLog taxrecord.create", async () => {
    const res = await post(jbody(valid));
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto.amount).toBe("2500.00");
    expect(dto).not.toHaveProperty("organizationId");

    expect(rec.created.taxRecord).toMatchObject({
      organizationId: ORG_A,
      periodId: "p_a",
      createdById: SUB_OWNER_A,
      updatedById: SUB_OWNER_A,
    });
    expect(rec.audits[0]).toMatchObject({
      action: "taxrecord.create",
      targetType: "TaxRecord",
      metadata: { periodId: "p_a", type: "RETENCION IVA" },
    });
    expect(JSON.stringify(rec.audits[0])).not.toMatch(/2500/);
  });

  it("periodId de otra organización -> 404, sin escritura", async () => {
    expect((await post(jbody({ ...valid, periodId: "p_b" }))).status).toBe(404);
    expect(rec.created.taxRecord).toBeUndefined();
  });

  it("amount con exceso de escala -> 422 field=amount", async () => {
    const res = await post(jbody({ ...valid, amount: "25000.005" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("amount");
  });

  it("sin sesión + body malformado -> 401 (no 400)", async () => {
    H.claims.value = null;
    expect((await post("{")).status).toBe(401);
  });
  it("sin Profile + body malformado -> 403 NO_PROFILE", async () => {
    H.claims.value = claimsFor(SUB_NO_PROFILE);
    expect((await (await post("{")).json()).error.code).toBe("NO_PROFILE");
  });
  it("VIEWER + body malformado -> 403 (no 400)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    expect((await post("{")).status).toBe(403);
  });
  it("rol OK + body malformado -> 400 BAD_REQUEST", async () => {
    expect((await (await post("{")).json()).error.code).toBe("BAD_REQUEST");
  });

  it("si el AuditLog falla -> 500 y rollback", async () => {
    rec.failAudit = true;
    expect((await post(jbody(valid))).status).toBe(500);
    expect(rec.created.taxRecord).toBeUndefined();
  });
});

describe("POST /api/taxes — bloqueo del período (lockPeriodForWrite)", () => {
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
  const expectNoTaxWrite = () => {
    expect(db.taxRecord.create).not.toHaveBeenCalled();
    expect(rec.created.taxRecord).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  };

  it("201: un único bloqueo de Period (id, organización activa), primera operación de la transacción, antes del TaxRecord y del AuditLog", async () => {
    expect((await post(jbody(valid))).status).toBe(201);
    expect(rec.locks).toHaveLength(1);
    expect(rec.locks[0].sql).toMatch(/FROM "Period"/);
    expect(rec.locks[0].sql).toMatch(/FOR UPDATE/);
    expect(rec.locks[0].values).toEqual(["p_a", ORG_A]);
    const lockAt = db.$queryRaw.mock.invocationCallOrder[0];
    expect(lockAt).toBeGreaterThan(db.$transaction.mock.invocationCallOrder[0]);
    expect(lockAt).toBeLessThan(db.taxRecord.create.mock.invocationCallOrder[0]);
    expect(rec.audits).toHaveLength(1);
  });

  it("período eliminado en paralelo: el bloqueo no lo encuentra -> 404 NOT_FOUND, sin TaxRecord ni AuditLog", async () => {
    onPeriodLock(() => world.periods.splice(world.periods.findIndex((p) => p.id === "p_a"), 1));
    const res = await post(jbody(valid));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(rec.locks).toHaveLength(1);
    expectNoTaxWrite();
  });

  it.each([
    ["VIEWER (403)", () => (H.claims.value = claimsFor(SUB_VIEWER_A)), valid, 403],
    ["body inválido (422)", () => {}, { ...valid, amount: "1.005" }, 422],
    ["período inexistente (404)", () => {}, { ...valid, periodId: "p_missing" }, 404],
  ])("rechazo previo a la transacción: %s -> sin transacción ni bloqueo", async (_l, arrange, body, status) => {
    arrange();
    expect((await post(jbody(body))).status).toBe(status);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expectNoTaxWrite();
  });
});

describe("POST /api/taxes — aislamiento de organización (endurecimiento)", () => {
  it("período de OTRA organización (acceso normal) -> 404 sin transacción ni bloqueo", async () => {
    const res = await post(jbody({ ...valid, periodId: "p_b" }));
    expect(res.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(rec.created.taxRecord).toBeUndefined();
  });

  it("período de OTRA organización aunque la Membership lo habilite -> el MISMO 404 que uno inexistente, antes de la transacción y sin bloquear", async () => {
    // Lecturas inconsistentes (p. ej. una Membership nueva entre consultas):
    // resolveActiveOrganization ve sólo ORG_A, pero requirePeriodAccess
    // encontraría rol en ORG_B. Antes: la FK compuesta rechazaba el TaxRecord
    // dentro de la transacción (500). Ahora: 404 sin revelar el período.
    const missing = await post(jbody({ ...valid, periodId: "p_missing" }));
    const missingBody = await missing.json();

    db.membership.findUnique.mockImplementation(
      async ({ where }: { where: { profileId_organizationId: { organizationId: string } } }) => {
        const { organizationId } = where.profileId_organizationId;
        return organizationId === ORG_A || organizationId === ORG_B ? { role: "OWNER" } : null;
      },
    );
    const res = await post(jbody({ ...valid, periodId: "p_b" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual(missingBody);
    expect(JSON.stringify(body)).not.toMatch(/p_b|org_b|c_b/);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.taxRecord.create).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });
});
