import { describe, it, expect, vi, beforeEach } from "vitest";

// Espías compartidos: se rearman en cada test vía mockImplementation.
const getClaims = vi.fn();
const getSession = vi.fn(() => {
  throw new Error("getSession() no debe usarse para decidir acceso");
});
const getUser = vi.fn(() => {
  throw new Error("getUser() no se usa en el camino de dev (claves asimétricas)");
});

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({
    auth: { getClaims, getSession, getUser },
  }),
}));

import { getAuthClaims, requireAuthClaims } from "@/lib/auth/claims";
import { UnauthenticatedError } from "@/lib/auth/errors";

beforeEach(() => {
  getClaims.mockReset();
  getSession.mockClear();
  getUser.mockClear();
});

describe("getAuthClaims — autoridad = getClaims()", () => {
  it("devuelve claims normalizados cuando getClaims verifica un JWT con sub", async () => {
    getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "11111111-1111-1111-1111-111111111111",
          email: "user@dero.test",
          role: "authenticated",
          aud: "authenticated",
        },
      },
      error: null,
    });

    const claims = await getAuthClaims();
    expect(claims).toEqual({
      sub: "11111111-1111-1111-1111-111111111111",
      email: "user@dero.test",
      authRole: "authenticated",
      raw: expect.objectContaining({ aud: "authenticated" }),
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("devuelve null si getClaims informa error", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "bad jwt" } });
    expect(await getAuthClaims()).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("devuelve null si no hay claims o falta sub", async () => {
    getClaims.mockResolvedValue({ data: { claims: null }, error: null });
    expect(await getAuthClaims()).toBeNull();

    getClaims.mockResolvedValue({ data: { claims: { email: "x@y.z" } }, error: null });
    expect(await getAuthClaims()).toBeNull();
  });

  it("email/authRole son null si no vienen en el claim", async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: "22222222-2222-2222-2222-222222222222" } },
      error: null,
    });
    expect(await getAuthClaims()).toMatchObject({ email: null, authRole: null });
  });
});

describe("requireAuthClaims", () => {
  it("lanza UnauthenticatedError (401) sin sesión", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "no session" } });
    await expect(requireAuthClaims()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("devuelve los claims si hay sesión", async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: "33333333-3333-3333-3333-333333333333" } },
      error: null,
    });
    expect((await requireAuthClaims()).sub).toBe("33333333-3333-3333-3333-333333333333");
  });
});
