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
  clientRow,
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
} from "./_harness";
import { DELETE } from "@/app/api/clients/[id]/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;
let world: World;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  world = makeWorld({
    clients: [
      clientRow("c_free", ORG_A, { condition: "Monotributo", name: "Libre SA", address: "Calle 1" }),
      clientRow("c_with_periods", ORG_A),
      clientRow("c_b", ORG_B),
    ],
    periods: [periodRow("p_a", "c_with_periods", ORG_A)],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

function del(id: string) {
  return DELETE(new Request(`http://localhost/api/clients/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}
const exists = (id: string) => world.clients.some((c) => c.id === id);

describe("DELETE /api/clients/[id] — eliminación", () => {
  it("204 (OWNER): elimina el cliente sin períodos y registra client.delete", async () => {
    const res = await del("c_free");
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(exists("c_free")).toBe(false);
    expect(db.client.delete).toHaveBeenCalledWith({
      where: { id_organizationId: { id: "c_free", organizationId: ORG_A } },
    });
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      organizationId: ORG_A,
      actorProfileId: SUB_OWNER_A,
      action: "client.delete",
      targetType: "Client",
      targetId: "c_free",
    });
  });

  it("AuditLog.metadata de client.delete = { condition } y NUNCA cuit, nombre ni dirección", async () => {
    const cuit = world.clients.find((c) => c.id === "c_free")!.cuit;
    await del("c_free");
    expect(rec.audits[0].metadata).toEqual({ condition: "Monotributo" });
    const serialized = JSON.stringify(rec.audits[0]);
    expect(serialized).not.toContain(cuit);
    expect(serialized).not.toMatch(/Libre SA|Calle 1/);
  });

  it("204 (ADMIN): puede eliminar", async () => {
    H.claims.value = claimsFor(SUB_ADMIN_A);
    expect((await del("c_free")).status).toBe(204);
    expect(exists("c_free")).toBe(false);
  });

  // ── relaciones bloqueantes ─────────────────────────────────────────────
  it("cliente con períodos -> 409 CONFLICT legible, sin borrar ni AuditLog", async () => {
    const res = await del("c_with_periods");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/períodos/);
    expect(db.client.delete).not.toHaveBeenCalled();
    expect(exists("c_with_periods")).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });

  it("período creado en paralelo (FK Restrict, P2003) -> 409 y rollback, sin AuditLog", async () => {
    db.period.count.mockResolvedValueOnce(0); // el conteo no lo ve; la FK sí
    const res = await del("c_with_periods");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
    expect(exists("c_with_periods")).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });

  // ── autorización ────────────────────────────────────────────────────────
  it.each([
    ["ACCOUNTANT", SUB_ACCOUNTANT_A],
    ["VIEWER", SUB_VIEWER_A],
  ])("%s -> 403 FORBIDDEN, sin borrar ni AuditLog", async (_role, sub) => {
    H.claims.value = claimsFor(sub);
    const res = await del("c_free");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(db.client.delete).not.toHaveBeenCalled();
    expect(exists("c_free")).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });

  it.each([
    ["sin sesión", null, 401, "UNAUTHENTICATED"],
    ["sin Profile", SUB_NO_PROFILE, 403, "NO_PROFILE"],
    ["sin organización", SUB_NO_ORG, 403, "NO_ORGANIZATION"],
  ])("%s -> %i %s", async (_label, sub, status, code) => {
    H.claims.value = claimsFor(sub);
    const res = await del("c_free");
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(exists("c_free")).toBe(true);
  });

  // ── aislamiento entre organizaciones ───────────────────────────────────
  it("cliente de OTRA organización -> 404 idéntico a inexistente, sin borrar", async () => {
    const other = await del("c_b");
    const missing = await del("c_inexistente");
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
    expect(exists("c_b")).toBe(true);
    expect(db.client.delete).not.toHaveBeenCalled();
    expect(db.period.count).not.toHaveBeenCalled(); // no revela si tiene períodos
    expect(rec.audits).toHaveLength(0);
  });

  it("OWNER de ORG_B sobre un cliente de ORG_A con períodos -> 404 (no 409)", async () => {
    H.claims.value = claimsFor(SUB_OWNER_B);
    const res = await del("c_with_periods");
    expect(res.status).toBe(404);
    expect(exists("c_with_periods")).toBe(true);
  });

  // ── atomicidad ─────────────────────────────────────────────────────────
  it("falla el AuditLog -> 500 y rollback completo (el cliente sigue existiendo)", async () => {
    rec.failAudit = true;
    const res = await del("c_free");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
    expect(exists("c_free")).toBe(true);
    expect(rec.audits).toHaveLength(0);
  });

  it("la fila desaparece entre lectura y borrado (P2025) -> 404", async () => {
    db.client.delete.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientKnownRequestError("gone", { code: "P2025", clientVersion: "6.19.3" });
    });
    const res = await del("c_free");
    expect(res.status).toBe(404);
    expect(rec.audits).toHaveLength(0);
  });
});
