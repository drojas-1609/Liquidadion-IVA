import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

// ── mock de la identidad (getAuthClaims): estado mutable, sin mockRejectedValue ──
const claimsState: { throw: unknown; value: unknown } = { throw: null, value: null };
vi.mock("@/lib/auth/claims", () => ({
  getAuthClaims: async () => {
    if (claimsState.throw) throw claimsState.throw;
    return claimsState.value;
  },
}));

// ── mock de next/navigation: redirect/notFound lanzan errores identificables ──
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOTFOUND_PAGE");
  },
}));

import {
  requireAuthenticatedProfile,
  resolveActiveOrganization,
  requireOrganizationRole,
  requireClientAccess,
  requirePeriodAccess,
  parseJsonBody,
  withApiAuthz,
  guardPage,
  type AuthzDb,
} from "@/lib/auth/authz";
import {
  UnauthenticatedError,
  NoProfileError,
  NoOrganizationError,
  OrganizationSelectionRequiredError,
  ForbiddenError,
  NotFoundError,
  MisconfiguredError,
  BadRequestError,
} from "@/lib/auth/errors";
import { ROLES_READ, ROLES_CREATE } from "@/lib/auth/roles";

const SUB = "11111111-1111-4111-8111-111111111111";
const ORG_A = "org_a";
const ORG_B = "org_b";

type ClientRow = {
  id: string;
  organizationId: string;
  name: string;
  cuit: string;
  condition: string;
  address: string | null;
  defaultIibbRate: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
};
type PeriodRow = { id: string; clientId: string; organizationId: string };

function clientRow(id: string, organizationId: string): ClientRow {
  return {
    id,
    organizationId,
    name: "Cliente " + id,
    cuit: "30-00000000-0",
    condition: "Responsable Inscripto",
    address: null,
    defaultIibbRate: new Prisma.Decimal("3"),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function makeDb(over: {
  profile?: { id: string; email: string | null } | null;
  memberships?: Array<{ organizationId: string; role: Role }>;
  membershipByOrg?: Record<string, { role: Role } | null>;
  clients?: Record<string, ClientRow | null>;
  periods?: Record<string, PeriodRow | null>;
  onProfileFindUnique?: () => void;
} = {}): AuthzDb {
  const db = {
    profile: {
      findUnique: async () => {
        over.onProfileFindUnique?.();
        return over.profile === undefined ? { id: SUB, email: "u@dero.test" } : over.profile;
      },
    },
    membership: {
      findMany: async () => over.memberships ?? [],
      findUnique: async (args: {
        where: { profileId_organizationId: { profileId: string; organizationId: string } };
      }) => {
        const orgId = args.where.profileId_organizationId.organizationId;
        return over.membershipByOrg?.[orgId] ?? null;
      },
    },
    client: {
      findUnique: async (args: { where: { id: string } }) =>
        over.clients?.[args.where.id] ?? null,
    },
    period: {
      findUnique: async (args: { where: { id: string } }) =>
        over.periods?.[args.where.id] ?? null,
    },
  };
  return db as unknown as AuthzDb;
}

beforeEach(() => {
  claimsState.throw = null;
  claimsState.value = { sub: SUB, email: "u@dero.test", authRole: "authenticated", raw: {} };
});

// ─────────────────────────────────────────────────────────────────────────────
describe("requireAuthenticatedProfile", () => {
  it("sin config de Auth -> propaga MisconfiguredError (503)", async () => {
    claimsState.throw = new MisconfiguredError();
    await expect(requireAuthenticatedProfile({ db: makeDb() })).rejects.toBeInstanceOf(
      MisconfiguredError,
    );
  });

  it("sin sesión (claims null) -> UnauthenticatedError (401), no consulta Profile", async () => {
    claimsState.value = null;
    let touched = false;
    await expect(
      requireAuthenticatedProfile({ db: makeDb({ onProfileFindUnique: () => (touched = true) }) }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(touched).toBe(false);
  });

  it("claims válidos sin fila Profile -> NoProfileError (403 NO_PROFILE)", async () => {
    await expect(
      requireAuthenticatedProfile({ db: makeDb({ profile: null }) }),
    ).rejects.toBeInstanceOf(NoProfileError);
  });

  it("camino feliz -> { profileId, authUserId, email }", async () => {
    const id = await requireAuthenticatedProfile({
      db: makeDb({ profile: { id: SUB, email: "real@dero.test" } }),
    });
    expect(id).toEqual({ profileId: SUB, authUserId: SUB, email: "real@dero.test" });
  });
});

describe("resolveActiveOrganization", () => {
  it("0 memberships -> NoOrganizationError (403)", async () => {
    await expect(
      resolveActiveOrganization(SUB, { db: makeDb({ memberships: [] }) }),
    ).rejects.toBeInstanceOf(NoOrganizationError);
  });

  it("2 memberships -> OrganizationSelectionRequiredError (409)", async () => {
    await expect(
      resolveActiveOrganization(SUB, {
        db: makeDb({
          memberships: [
            { organizationId: ORG_A, role: "OWNER" },
            { organizationId: ORG_B, role: "VIEWER" },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(OrganizationSelectionRequiredError);
  });

  it("1 membership -> { organizationId, role }", async () => {
    const org = await resolveActiveOrganization(SUB, {
      db: makeDb({ memberships: [{ organizationId: ORG_A, role: "ACCOUNTANT" }] }),
    });
    expect(org).toEqual({ organizationId: ORG_A, role: "ACCOUNTANT" });
  });
});

describe("requireOrganizationRole", () => {
  it("sin Membership en esa org -> NotFoundError (404), no ForbiddenError", async () => {
    await expect(
      requireOrganizationRole(SUB, ORG_B, ROLES_READ, { db: makeDb({ membershipByOrg: {} }) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rol fuera de `allowed` -> ForbiddenError (403)", async () => {
    await expect(
      requireOrganizationRole(SUB, ORG_A, ROLES_CREATE, {
        db: makeDb({ membershipByOrg: { [ORG_A]: { role: "VIEWER" } } }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rol permitido -> { organizationId, role }", async () => {
    const org = await requireOrganizationRole(SUB, ORG_A, ROLES_CREATE, {
      db: makeDb({ membershipByOrg: { [ORG_A]: { role: "ADMIN" } } }),
    });
    expect(org).toEqual({ organizationId: ORG_A, role: "ADMIN" });
  });
});

describe("requireClientAccess — D4 (recurso ajeno == inexistente)", () => {
  it("cliente inexistente -> NotFoundError (404)", async () => {
    await expect(
      requireClientAccess(SUB, "c_missing", ROLES_READ, { db: makeDb({ clients: {} }) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cliente de otra organización -> MISMO NotFoundError (404), cuerpo idéntico", async () => {
    const missing = await requireClientAccess(SUB, "c_missing", ROLES_READ, {
      db: makeDb({ clients: {} }),
    }).catch((e) => e);
    const foreign = await requireClientAccess(SUB, "c_b", ROLES_READ, {
      db: makeDb({
        clients: { c_b: clientRow("c_b", ORG_B) },
        membershipByOrg: { [ORG_A]: { role: "OWNER" } }, // el caller es de ORG_A, no de ORG_B
      }),
    }).catch((e) => e);

    expect(missing).toBeInstanceOf(NotFoundError);
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(foreign.code).toBe(missing.code);
    expect(foreign.status).toBe(missing.status);
    expect(foreign.message).toBe(missing.message);
  });

  it("cliente propio + rol OK -> devuelve contexto con el client", async () => {
    const acc = await requireClientAccess(SUB, "c_a", ROLES_READ, {
      db: makeDb({
        clients: { c_a: clientRow("c_a", ORG_A) },
        membershipByOrg: { [ORG_A]: { role: "VIEWER" } },
      }),
    });
    expect(acc).toMatchObject({ profileId: SUB, organizationId: ORG_A, role: "VIEWER" });
    expect(acc.client.id).toBe("c_a");
    expect(acc.client.organizationId).toBe(ORG_A);
  });

  it("cliente propio pero rol insuficiente -> ForbiddenError (403)", async () => {
    await expect(
      requireClientAccess(SUB, "c_a", ROLES_CREATE, {
        db: makeDb({
          clients: { c_a: clientRow("c_a", ORG_A) },
          membershipByOrg: { [ORG_A]: { role: "VIEWER" } },
        }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("requirePeriodAccess", () => {
  const db = (over: Parameters<typeof makeDb>[0] = {}) =>
    makeDb({
      periods: { p_a: { id: "p_a", clientId: "c_a", organizationId: ORG_A } },
      membershipByOrg: { [ORG_A]: { role: "ACCOUNTANT" } },
      ...over,
    });

  it("período inexistente -> NotFoundError (404)", async () => {
    await expect(
      requirePeriodAccess(SUB, "p_missing", ROLES_READ, { db: db() }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("período de otra organización -> NotFoundError (404) idéntico", async () => {
    await expect(
      requirePeriodAccess(SUB, "p_b", ROLES_READ, {
        db: db({
          periods: { p_b: { id: "p_b", clientId: "c_b", organizationId: ORG_B } },
          membershipByOrg: { [ORG_A]: { role: "OWNER" } },
        }),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("expectClientId distinto de period.clientId -> NotFoundError (404)", async () => {
    await expect(
      requirePeriodAccess(SUB, "p_a", ROLES_READ, { db: db(), expectClientId: "otro" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("expectClientId coincidente + rol OK -> devuelve el period", async () => {
    const acc = await requirePeriodAccess(SUB, "p_a", ROLES_READ, {
      db: db(),
      expectClientId: "c_a",
    });
    expect(acc.period).toEqual({ id: "p_a", clientId: "c_a", organizationId: ORG_A });
    expect(acc.organizationId).toBe(ORG_A);
  });

  it("rol insuficiente -> ForbiddenError (403)", async () => {
    await expect(
      requirePeriodAccess(SUB, "p_a", ROLES_CREATE, {
        db: db({ membershipByOrg: { [ORG_A]: { role: "VIEWER" } } }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("parseJsonBody", () => {
  it("JSON válido -> lo devuelve", async () => {
    const req = new Request("http://x/api", { method: "POST", body: '{"a":1}' });
    expect(await parseJsonBody(req)).toEqual({ a: 1 });
  });

  it("JSON malformado -> BadRequestError (400)", async () => {
    const req = new Request("http://x/api", { method: "POST", body: "{" });
    await expect(parseJsonBody(req)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("body ausente -> BadRequestError (400)", async () => {
    const req = new Request("http://x/api", { method: "POST" });
    await expect(parseJsonBody(req)).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("withApiAuthz", () => {
  it("propaga la respuesta del handler y le pone Cache-Control: no-store", async () => {
    const wrapped = withApiAuthz(async () => NextResponse.json({ ok: true }, { status: 201 }));
    const res = await wrapped(new Request("http://x/api"));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("respeta un Cache-Control ya puesto por el handler", async () => {
    const wrapped = withApiAuthz(async () =>
      NextResponse.json({}, { headers: { "Cache-Control": "no-store, max-age=0" } }),
    );
    const res = await wrapped(new Request("http://x/api"));
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("AuthError -> su status + code + no-store", async () => {
    const wrapped = withApiAuthz(async () => {
      throw new ForbiddenError();
    });
    const res = await wrapped(new Request("http://x/api"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("Prisma P2002 -> 409 CONFLICT genérico (sin filtrar el nombre de la constraint)", async () => {
    const wrapped = withApiAuthz(async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`cuit`)", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: ["organizationId", "cuit"] },
      });
    });
    const res = await wrapped(new Request("http://x/api"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(JSON.stringify(body)).not.toMatch(/constraint|cuit|P2002/i);
  });

  it("error desconocido -> 500 INTERNAL genérico, sin fuga del mensaje", async () => {
    const wrapped = withApiAuthz(async () => {
      throw new Error("postgres://user:pass@host/db se cayó");
    });
    const res = await wrapped(new Request("http://x/api"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\/|pass@/);
  });

  it("Prisma P2003 (FK compuesta) -> 500 INTERNAL genérico, NO 404/409", async () => {
    const wrapped = withApiAuthz(async () => {
      throw new Prisma.PrismaClientKnownRequestError("FK failed", {
        code: "P2003",
        clientVersion: "6.19.3",
      });
    });
    const res = await wrapped(new Request("http://x/api"));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL");
  });

  it("pasa el segundo argumento (ctx con params) al handler", async () => {
    const wrapped = withApiAuthz(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
      const { id } = await ctx.params;
      return NextResponse.json({ id });
    });
    const res = await wrapped(new Request("http://x/api"), { params: Promise.resolve({ id: "z" }) });
    expect((await res.json()).id).toBe("z");
  });
});

describe("guardPage", () => {
  it("fn OK -> { ok: true, data }", async () => {
    const r = await guardPage(async () => 42);
    expect(r).toEqual({ ok: true, data: 42 });
  });

  it("UNAUTHENTICATED -> redirect('/login')", async () => {
    await expect(
      guardPage(async () => {
        throw new UnauthenticatedError();
      }),
    ).rejects.toThrow("REDIRECT:/login");
  });

  it("NOT_FOUND -> notFound()", async () => {
    await expect(
      guardPage(async () => {
        throw new NotFoundError();
      }),
    ).rejects.toThrow("NOTFOUND_PAGE");
  });

  it("NO_PROFILE / NO_ORGANIZATION / 409 / FORBIDDEN / MISCONFIGURED -> { ok: false, notice }", async () => {
    const cases: Array<[Error, string]> = [
      [new NoProfileError(), "no-profile"],
      [new NoOrganizationError(), "no-organization"],
      [new OrganizationSelectionRequiredError(), "org-selection"],
      [new ForbiddenError(), "forbidden"],
      [new MisconfiguredError(), "misconfigured"],
    ];
    for (const [err, notice] of cases) {
      const r = await guardPage(async () => {
        throw err;
      });
      expect(r, notice).toEqual({ ok: false, notice });
    }
  });

  it("un error que no es AuthError se propaga tal cual", async () => {
    await expect(
      guardPage(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
