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
} from "./_harness";
import { POST } from "@/app/api/taxes/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  wireDb(db, makeWorld(), rec);
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
