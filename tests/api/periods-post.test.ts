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
  periodRow,
  SUB_OWNER_A,
  SUB_VIEWER_A,
  SUB_NO_PROFILE,
  SUB_NO_ORG,
  ORG_A,
} from "./_harness";
import { POST } from "@/app/api/periods/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  const world = makeWorld({
    periods: [periodRow("p_a_existing", "c_a", ORG_A, { month: 3, year: 2026 })],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

const post = (bodyText: string | undefined) =>
  POST(new Request("http://localhost/api/periods", { method: "POST", body: bodyText }));
const jbody = (o: unknown) => JSON.stringify(o);
const valid = { clientId: "c_a", month: 6, year: 2026 };

describe("POST /api/periods", () => {
  it("201: crea el período con organizationId directo, autoría y AuditLog period.create", async () => {
    const res = await post(jbody(valid));
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto).toEqual(
      expect.objectContaining({ clientId: "c_a", month: 6, year: 2026 }),
    );
    // el DTO NO expone organizationId/createdById/updatedById
    expect(dto).not.toHaveProperty("organizationId");
    expect(dto).not.toHaveProperty("createdById");

    expect(rec.created.period).toMatchObject({
      clientId: "c_a",
      organizationId: ORG_A,
      createdById: SUB_OWNER_A,
      updatedById: SUB_OWNER_A,
    });
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      action: "period.create",
      targetType: "Period",
      organizationId: ORG_A,
      metadata: { clientId: "c_a", month: 6, year: 2026 },
    });
  });

  it("clientId de otra organización -> 404 NOT_FOUND, sin escritura", async () => {
    const res = await post(jbody({ ...valid, clientId: "c_b" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(rec.created.period).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("clientId inexistente -> 404 NOT_FOUND (idéntico a ajeno)", async () => {
    const res = await post(jbody({ ...valid, clientId: "c_zzz" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("período duplicado (month, year, clientId) -> 409 CONFLICT, sin audit", async () => {
    const res = await post(jbody({ clientId: "c_a", month: 3, year: 2026 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(rec.audits).toHaveLength(0);
  });

  it("month=13 / year=1990 -> 422 con field", async () => {
    let res = await post(jbody({ ...valid, month: 13 }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("month");
    res = await post(jbody({ ...valid, year: 1990 }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("year");
  });

  // ── orden auth -> parse ────────────────────────────────────────────────
  it("sin sesión + body malformado -> 401 (no 400)", async () => {
    H.claims.value = null;
    expect((await post("{")).status).toBe(401);
  });
  it("sin Profile + body malformado -> 403 NO_PROFILE (no 400)", async () => {
    H.claims.value = claimsFor(SUB_NO_PROFILE);
    expect((await (await post("{")).json()).error.code).toBe("NO_PROFILE");
  });
  it("sin Membership + body malformado -> 403 NO_ORGANIZATION (no 400)", async () => {
    H.claims.value = claimsFor(SUB_NO_ORG);
    expect((await (await post("{")).json()).error.code).toBe("NO_ORGANIZATION");
  });
  it("VIEWER + body malformado -> 403 FORBIDDEN (no 400)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    const res = await post("{");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });
  it("rol OK + body malformado -> 400 BAD_REQUEST", async () => {
    const res = await post("{");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
  });

  it("VIEWER con body válido -> 403 FORBIDDEN, no crea", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    const res = await post(jbody(valid));
    expect(res.status).toBe(403);
    expect(rec.created.period).toBeUndefined();
  });

  it("si el AuditLog falla -> 500 y rollback (no queda período)", async () => {
    rec.failAudit = true;
    const res = await post(jbody(valid));
    expect(res.status).toBe(500);
    expect(rec.created.period).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });
});
