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
  SUB_ADMIN_A,
  SUB_ACCOUNTANT_A,
  SUB_VIEWER_A,
  SUB_OWNER_B,
  SUB_NO_PROFILE,
  SUB_NO_ORG,
  ORG_A,
  ORG_B,
  type World,
} from "./_harness";
import { PATCH } from "@/app/api/clients/[id]/route";
import { cuitCheckDigit } from "@/lib/cuit";

const CUIT_A = "30-11111111-8";
const CUIT_OTHER_A = "30-22222222-9";
const CUIT_B = `30-33333334-${cuitCheckDigit("3033333334")}`;

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  world = makeWorld({
    clients: [
      clientRow("c_a", ORG_A, { cuit: CUIT_A, name: "Alfa SA", address: "Calle 1" }),
      clientRow("c_a2", ORG_A, { cuit: CUIT_OTHER_A }),
      clientRow("c_b", ORG_B, { cuit: CUIT_B }),
    ],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

function patch(id: string, bodyText: string | undefined) {
  return PATCH(
    new Request(`http://localhost/api/clients/${id}`, {
      method: "PATCH",
      body: bodyText,
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );
}
const jbody = (o: unknown) => JSON.stringify(o);
const clientA = () => world.clients.find((c) => c.id === "c_a")!;

describe("PATCH /api/clients/[id] — actualización", () => {
  it("200 (OWNER): actualiza campos permitidos, autoría y AuditLog client.update", async () => {
    const res = await patch("c_a", jbody({ name: "Alfa SRL", condition: "Monotributo" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    const dto = await res.json();
    expect(dto).toMatchObject({ id: "c_a", name: "Alfa SRL", condition: "Monotributo", cuit: CUIT_A });
    expect(typeof dto.defaultIibbRate).toBe("string");
    expect(dto).not.toHaveProperty("organizationId");

    expect(db.client.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id_organizationId: { id: "c_a", organizationId: ORG_A } } }),
    );
    expect(rec.created.clientUpdate).toMatchObject({ updatedById: SUB_OWNER_A });
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      organizationId: ORG_A,
      actorProfileId: SUB_OWNER_A,
      action: "client.update",
      targetType: "Client",
      targetId: "c_a",
      metadata: { changedFields: "name,condition", condition: "Monotributo" },
    });
  });

  it("200 (ADMIN): puede editar", async () => {
    H.claims.value = claimsFor(SUB_ADMIN_A);
    const res = await patch("c_a", jbody({ name: "Alfa Admin" }));
    expect(res.status).toBe(200);
    expect(rec.audits[0].actorProfileId).toBe(SUB_ADMIN_A);
  });

  it("CUIT: se normaliza al formato canónico antes de persistir", async () => {
    const res = await patch("c_a", jbody({ cuit: "20 12345678 6" }));
    expect(res.status).toBe(200);
    expect(rec.created.clientUpdate.cuit).toBe("20-12345678-6");
    expect((await res.json()).cuit).toBe("20-12345678-6");
  });

  it("AuditLog.metadata NUNCA contiene CUIT, nombre ni dirección (sólo nombres de campo)", async () => {
    await patch("c_a", jbody({ cuit: "20-12345678-6", name: "Nuevo Nombre", address: "Otra calle 99" }));
    expect(rec.audits[0].metadata).toEqual({
      changedFields: "name,cuit,address",
      condition: "Responsable Inscripto",
    });
    const serialized = JSON.stringify(rec.audits[0]);
    expect(serialized).not.toMatch(/12345678|30-11111111-8|Nuevo Nombre|Otra calle|Calle 1/);
  });

  it("IGNORA organizationId, id y autoría del body", async () => {
    const res = await patch(
      "c_a",
      jbody({ name: "X", organizationId: ORG_B, id: "otro", createdById: "atacante", updatedById: "atacante" }),
    );
    expect(res.status).toBe(200);
    expect(rec.created.clientUpdate).toEqual({ name: "X", updatedById: SUB_OWNER_A });
    expect(clientA().organizationId).toBe(ORG_A);
  });

  it("sin cambios efectivos: 200 sin escritura ni AuditLog", async () => {
    const res = await patch("c_a", jbody({ name: "Alfa SA", cuit: "30111111118" }));
    expect(res.status).toBe(200);
    expect(db.client.update).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("dirección vacía -> null; alícuota decimal válida", async () => {
    const res = await patch("c_a", jbody({ address: "", defaultIibbRate: "2.5" }));
    expect(res.status).toBe(200);
    expect(clientA().address).toBeNull();
    expect((await res.json()).defaultIibbRate).toBe("2.5");
    expect(rec.audits[0].metadata.changedFields).toBe("address,defaultIibbRate");
  });

  // ── autorización ────────────────────────────────────────────────────────
  it.each([
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
    ["VIEWER", SUB_VIEWER_A],
  ])("%s -> 403 FORBIDDEN, sin escritura ni AuditLog", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    const res = await patch("c_a", jbody({ name: "Hack" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(db.client.update).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
    expect(clientA().name).toBe("Alfa SA");
  });

  it("sin sesión + body malformado -> 401 (no 400)", async () => {
    H.claims.value = null;
    const res = await patch("c_a", "{");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("sesión sin Profile -> 403 NO_PROFILE", async () => {
    H.claims.value = claimsFor(SUB_NO_PROFILE);
    const res = await patch("c_a", jbody({ name: "X" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NO_PROFILE");
  });

  it("Profile sin organización -> 403 NO_ORGANIZATION", async () => {
    H.claims.value = claimsFor(SUB_NO_ORG);
    const res = await patch("c_a", jbody({ name: "X" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NO_ORGANIZATION");
  });

  it("ACCOUNTANT + body malformado -> 403 (el rol se evalúa antes del parseo)", async () => {
    H.claims.value = claimsFor(SUB_ACCOUNTANT_A);
    expect((await patch("c_a", "{")).status).toBe(403);
  });

  // ── aislamiento entre organizaciones ───────────────────────────────────
  it("cliente de OTRA organización -> 404 idéntico a inexistente, sin escritura", async () => {
    const other = await patch("c_b", jbody({ name: "Hack" }));
    const missing = await patch("c_inexistente", jbody({ name: "Hack" }));
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect(db.client.update).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
    expect(world.clients.find((c) => c.id === "c_b")!.name).toBe("Cliente c_b");
  });

  it("OWNER de ORG_B no puede editar un cliente de ORG_A -> 404", async () => {
    H.claims.value = claimsFor(SUB_OWNER_B);
    const res = await patch("c_a", jbody({ name: "Hack" }));
    expect(res.status).toBe(404);
    expect(clientA().name).toBe("Alfa SA");
  });

  // ── validación ─────────────────────────────────────────────────────────
  it("body malformado -> 400 BAD_REQUEST", async () => {
    const res = await patch("c_a", "{");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
  });

  it.each([
    ["CUIT con DV incorrecto", { cuit: "20-12345678-0" }, "cuit"],
    ["CUIT con letras", { cuit: "20-1234567A-6" }, "cuit"],
    ["CUIT corto", { cuit: "20-123-6" }, "cuit"],
    ["nombre vacío", { name: "   " }, "name"],
    ["condición vacía", { condition: "" }, "condition"],
    ["alícuota inválida", { defaultIibbRate: "abc" }, "defaultIibbRate"],
    ["dirección no string", { address: 123 }, "address"],
    ["sin campos editables", { organizationId: ORG_B }, "body"],
  ])("%s -> 422 con field, sin escritura", async (_label, body, field) => {
    const res = await patch("c_a", jbody(body));
    expect(res.status).toBe(422);
    const out = await res.json();
    expect(out.error.code).toBe("UNPROCESSABLE_ENTITY");
    expect(typeof out.error.message).toBe("string");
    expect(out.field).toBe(field);
    expect(db.client.update).not.toHaveBeenCalled();
    expect(rec.audits).toHaveLength(0);
  });

  it("CUIT duplicado en la organización (aun con otro formato) -> 409 CONFLICT, sin AuditLog", async () => {
    const res = await patch("c_a", jbody({ cuit: "30222222229" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(rec.audits).toHaveLength(0);
    expect(clientA().cuit).toBe(CUIT_A);
  });

  it("CUIT de un cliente de OTRA organización no choca (unicidad por organización)", async () => {
    const res = await patch("c_a", jbody({ cuit: CUIT_B }));
    expect(res.status).toBe(200);
  });

  // ── atomicidad ─────────────────────────────────────────────────────────
  it("falla el AuditLog -> 500 y rollback completo (el cliente no cambia)", async () => {
    rec.failAudit = true;
    const res = await patch("c_a", jbody({ name: "No debe quedar" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
    expect(clientA().name).toBe("Alfa SA");
    expect(rec.audits).toHaveLength(0);
  });

  it("la fila desaparece entre lectura y escritura (P2025) -> 404", async () => {
    db.client.update.mockImplementationOnce(async () => {
      const { Prisma } = await import("@prisma/client");
      throw new Prisma.PrismaClientKnownRequestError("not found", { code: "P2025", clientVersion: "6.19.3" });
    });
    const res = await patch("c_a", jbody({ name: "X" }));
    expect(res.status).toBe(404);
    expect(rec.audits).toHaveLength(0);
  });
});
