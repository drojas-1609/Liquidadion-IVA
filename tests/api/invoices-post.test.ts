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
import { POST } from "@/app/api/invoices/route";

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
  POST(new Request("http://localhost/api/invoices", { method: "POST", body: bodyText }));
const jbody = (o: unknown) => JSON.stringify(o);
const valid = {
  date: "2026-05-10",
  type: "FC A",
  pointOfSale: "1",
  number: "1001",
  entityName: "Proveedor SA",
  entityCuit: "30-99999999-1",
  netAmount: "1000",
  vatRate: "21",
  category: "PURCHASES",
  periodId: "p_a",
};

describe("POST /api/invoices", () => {
  it("201: crea con organizationId directo, recalcula IVA/total, autoría y AuditLog", async () => {
    const res = await post(jbody({ ...valid, vatAmount: "999999.99", totalAmount: "0.01" }));
    expect(res.status).toBe(201);
    const dto = await res.json();
    // recalculado server-side, ignora los valores mentirosos del cliente
    expect(dto.vatAmount).toBe("210.00");
    expect(dto.totalAmount).toBe("1210.00");
    expect(dto).not.toHaveProperty("organizationId");

    expect(rec.created.invoice).toMatchObject({
      organizationId: ORG_A,
      periodId: "p_a",
      createdById: SUB_OWNER_A,
      updatedById: SUB_OWNER_A,
    });
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      action: "invoice.create",
      targetType: "Invoice",
      metadata: { periodId: "p_a", category: "PURCHASES", type: "FC A" },
    });
    // el AuditLog NUNCA lleva importes ni contraparte
    expect(JSON.stringify(rec.audits[0])).not.toMatch(/1000|210|Proveedor|30-99999999/);
  });

  it("periodId de otra organización -> 404 NOT_FOUND, sin escritura", async () => {
    const res = await post(jbody({ ...valid, periodId: "p_b" }));
    expect(res.status).toBe(404);
    expect(rec.created.invoice).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("periodId inexistente -> 404 NOT_FOUND", async () => {
    expect((await post(jbody({ ...valid, periodId: "p_zzz" }))).status).toBe(404);
  });

  it("decimales inválidos -> 422 con field", async () => {
    const res = await post(jbody({ ...valid, netAmount: "1.234" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("netAmount");
  });

  it("sin sesión + body malformado -> 401 (no 400)", async () => {
    H.claims.value = null;
    expect((await post("{")).status).toBe(401);
  });
  it("sin Profile + body malformado -> 403 NO_PROFILE (no 400)", async () => {
    H.claims.value = claimsFor(SUB_NO_PROFILE);
    expect((await (await post("{")).json()).error.code).toBe("NO_PROFILE");
  });
  it("VIEWER + body malformado -> 403 FORBIDDEN (no 400)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    expect((await post("{")).status).toBe(403);
  });
  it("rol OK + body malformado -> 400 BAD_REQUEST", async () => {
    expect((await (await post("{")).json()).error.code).toBe("BAD_REQUEST");
  });

  it("VIEWER con body válido -> 403, no crea", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    expect((await post(jbody(valid))).status).toBe(403);
    expect(rec.created.invoice).toBeUndefined();
  });

  it("si el AuditLog falla -> 500 y rollback", async () => {
    rec.failAudit = true;
    expect((await post(jbody(valid))).status).toBe(500);
    expect(rec.created.invoice).toBeUndefined();
  });
});
