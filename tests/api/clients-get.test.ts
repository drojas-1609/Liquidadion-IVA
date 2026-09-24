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
  wireDb,
  makeWorld,
  freshRecorder,
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
import { MisconfiguredError } from "@/lib/auth/errors";
import { GET } from "@/app/api/clients/route";

let db: ReturnType<typeof freshDbMock>;
let rec: ReturnType<typeof freshRecorder>;

beforeEach(() => {
  db = freshDbMock();
  rec = freshRecorder();
  const world = makeWorld({
    clients: [
      clientRow("c_a1", ORG_A, { name: "Zeta SA" }),
      clientRow("c_a2", ORG_A, { name: "Alfa SA" }),
      clientRow("c_b1", ORG_B, { name: "Beta SA" }),
    ],
  });
  wireDb(db, world, rec);
  H.db.current = db;
  H.claims.throw = null;
  H.claims.value = claimsFor(SUB_OWNER_A);
});

const callGet = () => GET(new Request("http://localhost/api/clients"));

describe("GET /api/clients — scope de organización", () => {
  it("devuelve SÓLO los clientes de la organización activa, ordenados por nombre", async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((c: { name: string }) => c.name)).toEqual(["Alfa SA", "Zeta SA"]);
    expect(body.every((c: { id: string }) => c.id.startsWith("c_a"))).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("un cliente de otra organización NUNCA aparece", async () => {
    const body = await (await callGet()).json();
    expect(JSON.stringify(body)).not.toMatch(/Beta SA|c_b1|org_b/);
  });

  it("sin sesión -> 401 UNAUTHENTICATED (no 200 con [])", async () => {
    H.claims.value = null;
    const res = await callGet();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(Array.isArray(body)).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("sesión válida sin Profile -> 403 NO_PROFILE", async () => {
    H.claims.value = claimsFor(SUB_NO_PROFILE);
    const res = await callGet();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NO_PROFILE");
  });

  it("Profile sin Membership -> 403 NO_ORGANIZATION", async () => {
    H.claims.value = claimsFor(SUB_NO_ORG);
    const res = await callGet();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NO_ORGANIZATION");
  });

  it("config de Auth ausente -> 503 MISCONFIGURED", async () => {
    H.claims.throw = new MisconfiguredError();
    const res = await callGet();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("MISCONFIGURED");
  });

  it("VIEWER puede leer (ROLES_READ incluye VIEWER)", async () => {
    H.claims.value = claimsFor(SUB_VIEWER_A);
    expect((await callGet()).status).toBe(200);
  });

  it("OWNER de otra organización sólo ve la suya", async () => {
    H.claims.value = claimsFor(SUB_OWNER_B);
    const body = await (await callGet()).json();
    expect(body.map((c: { name: string }) => c.name)).toEqual(["Beta SA"]);
  });

  it("un error de la base se propaga como 500 INTERNAL (no [] con 200)", async () => {
    db.client.findMany.mockRejectedValueOnce(new Error("db kaput"));
    const res = await callGet();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toMatch(/kaput/);
  });
});
