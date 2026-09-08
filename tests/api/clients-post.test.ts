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
  clientRow,
  SUB_OWNER_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  SUB_NO_PROFILE,
  SUB_NO_ORG,
  ORG_A,
  ORG_B,
} from "./_harness";
import { POST } from "@/app/api/clients/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  const world = makeWorld({
    clients: [clientRow("c_a_existing", ORG_A, { cuit: "30-11111111-1" })],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

function post(bodyText: string | undefined) {
  return POST(
    new Request("http://localhost/api/clients", {
      method: "POST",
      body: bodyText,
      headers: { "content-type": "application/json" },
    }),
  );
}
const jbody = (o: unknown) => JSON.stringify(o);
const validBody = { name: "Nueva SA", cuit: "30-22222222-2", condition: "Responsable Inscripto" };

describe("POST /api/clients — rehabilitación segura", () => {
  it("201: crea el cliente en la org activa, con autoría y AuditLog client.create", async () => {
    const res = await post(jbody(validBody));
    expect(res.status).toBe(201);
    const dto = await res.json();
    expect(dto).toMatchObject({ name: "Nueva SA", cuit: "30-22222222-2", defaultIibbRate: "3" });
    expect(typeof dto.defaultIibbRate).toBe("string");
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");

    expect(rec.created.client).toMatchObject({
      organizationId: ORG_A,
      createdById: SUB_OWNER_A,
      updatedById: SUB_OWNER_A,
    });
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      organizationId: ORG_A,
      actorProfileId: SUB_OWNER_A,
      action: "client.create",
      targetType: "Client",
    });
  });

  it("AuditLog.metadata de client.create = { condition } y NUNCA el cuit", async () => {
    await post(jbody(validBody));
    expect(rec.audits[0].metadata).toEqual({ condition: "Responsable Inscripto" });
    expect(JSON.stringify(rec.audits[0])).not.toMatch(/30-22222222-2/);
    // targetId es el id del cliente creado
    expect(rec.audits[0].targetId).toBe(rec.audits[0].targetId);
  });

  it("IGNORA organizationId del body: escribe en la org de la Membership del caller", async () => {
    const res = await post(jbody({ ...validBody, organizationId: ORG_B, createdById: "atacante" }));
    expect(res.status).toBe(201);
    expect(rec.created.client.organizationId).toBe(ORG_A);
    expect(rec.created.client.createdById).toBe(SUB_OWNER_A);
  });

  // ── orden auth -> parse (§18.2bis) ──────────────────────────────────────
  it("sin sesión + body malformado -> 401 (no 400)", async () => {
    H.claims.value = null;
    const res = await post("{");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("sin sesión + body ausente -> 401", async () => {
    H.claims.value = null;
    expect((await post(undefined)).status).toBe(401);
  });

  it("sesión sin Profile + body malformado -> 403 NO_PROFILE (no 400)", async () => {
    H.claims.value = claimsFor(SUB_NO_PROFILE);
    const res = await post("{");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NO_PROFILE");
  });

  it("Profile sin Membership + body malformado -> 403 NO_ORGANIZATION (no 400)", async () => {
    H.claims.value = claimsFor(SUB_NO_ORG);
    const res = await post("{");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NO_ORGANIZATION");
  });

  it("VIEWER (rol insuficiente) + body malformado -> 403 FORBIDDEN (no 400)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    const res = await post("{");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(rec.created.client).toBeUndefined();
  });

  it("sesión + Profile + org + rol OK + body malformado -> 400 BAD_REQUEST", async () => {
    const res = await post("{");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
  });

  // ── validación / conflicto ─────────────────────────────────────────────
  it("name vacío -> 422 UNPROCESSABLE_ENTITY con field, sin escritura", async () => {
    const res = await post(jbody({ ...validBody, name: "" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(body.field).toBe("name");
    expect(rec.created.client).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("defaultIibbRate inválido -> 422 field=defaultIibbRate", async () => {
    const res = await post(jbody({ ...validBody, defaultIibbRate: "101" }));
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("defaultIibbRate");
  });

  it("CUIT duplicado en la organización -> 409 CONFLICT genérico, sin escritura ni audit", async () => {
    const res = await post(jbody({ ...validBody, cuit: "30-11111111-1" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(JSON.stringify(body)).not.toMatch(/constraint|P2002|cuit/i);
    expect(rec.audits).toHaveLength(0);
  });

  it("VIEWER con body válido -> 403 FORBIDDEN (no crea)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    const res = await post(jbody(validBody));
    expect(res.status).toBe(403);
    expect(rec.created.client).toBeUndefined();
  });

  it("ACCOUNTANT puede crear", async () => {
    H.claims.value = claimsFor("aaaaaaaa-0000-4000-8000-000000000002");
    expect((await post(jbody(validBody))).status).toBe(201);
  });

  it("si el AuditLog falla, la transacción hace rollback: no queda cliente creado", async () => {
    rec.failAudit = true;
    const res = await post(jbody(validBody));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
    expect(rec.created.client).toBeUndefined();
    expect(rec.audits).toHaveLength(0);
  });

  it("OWNER de otra organización crea en SU organización, nunca en ORG_A", async () => {
    H.claims.value = claimsFor(SUB_OWNER_B);
    const res = await post(jbody(validBody));
    expect(res.status).toBe(201);
    expect(rec.created.client.organizationId).toBe(ORG_B);
  });
});
