import { describe, it, expect, vi, beforeEach } from "vitest";
import { SupabaseConfigError } from "@/lib/supabase/env";

// Estado mutable del mock (evita vi.fn().mockRejectedValue -> promesas
// rechazadas sin manejar entre tests).
const state: {
  serverThrow: unknown;
  getClaimsThrow: unknown;
  getClaimsResult: unknown;
} = { serverThrow: null, getClaimsThrow: null, getClaimsResult: null };

const getSession = vi.fn(() => {
  throw new Error("getSession() no debe usarse para decidir acceso");
});
const getUser = vi.fn(() => {
  throw new Error("getUser() no se usa en el camino de dev (claves asimétricas)");
});

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => {
    if (state.serverThrow) throw state.serverThrow;
    return {
      auth: {
        getSession,
        getUser,
        getClaims: async () => {
          if (state.getClaimsThrow) throw state.getClaimsThrow;
          return state.getClaimsResult;
        },
      },
    };
  },
}));

import { getAuthClaims, requireAuthClaims } from "@/lib/auth/claims";
import { UnauthenticatedError, MisconfiguredError } from "@/lib/auth/errors";

beforeEach(() => {
  state.serverThrow = null;
  state.getClaimsThrow = null;
  state.getClaimsResult = null;
  getSession.mockClear();
  getUser.mockClear();
});

describe("getAuthClaims — autoridad = getClaims()", () => {
  it("devuelve claims normalizados cuando getClaims verifica un JWT con sub", async () => {
    state.getClaimsResult = {
      data: {
        claims: {
          sub: "11111111-1111-1111-1111-111111111111",
          email: "user@dero.test",
          role: "authenticated",
          aud: "authenticated",
        },
      },
      error: null,
    };

    expect(await getAuthClaims()).toEqual({
      sub: "11111111-1111-1111-1111-111111111111",
      email: "user@dero.test",
      authRole: "authenticated",
      raw: expect.objectContaining({ aud: "authenticated" }),
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
  });

  it("devuelve null si getClaims informa error", async () => {
    state.getClaimsResult = { data: null, error: { message: "bad jwt" } };
    expect(await getAuthClaims()).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("devuelve null si no hay claims o falta sub", async () => {
    state.getClaimsResult = { data: { claims: null }, error: null };
    expect(await getAuthClaims()).toBeNull();

    state.getClaimsResult = { data: { claims: { email: "x@y.z" } }, error: null };
    expect(await getAuthClaims()).toBeNull();
  });

  it("email/authRole son null si no vienen en el claim", async () => {
    state.getClaimsResult = {
      data: { claims: { sub: "22222222-2222-2222-2222-222222222222" } },
      error: null,
    };
    expect(await getAuthClaims()).toMatchObject({ email: null, authRole: null });
  });

  it("excepción de getClaims() -> null (fail-closed, no lanza)", async () => {
    state.getClaimsThrow = new Error("fallo de verificación / red");
    expect(await getAuthClaims()).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("config ausente/inválida -> MisconfiguredError (503), NUNCA null permisivo", async () => {
    state.serverThrow = new SupabaseConfigError("faltan variables");
    await expect(getAuthClaims()).rejects.toBeInstanceOf(MisconfiguredError);
  });

  it("otro error al construir el cliente se propaga tal cual", async () => {
    state.serverThrow = new Error("error raro");
    await expect(getAuthClaims()).rejects.toThrow("error raro");
  });
});

describe("requireAuthClaims", () => {
  it("lanza UnauthenticatedError (401) sin sesión", async () => {
    state.getClaimsResult = { data: null, error: { message: "no session" } };
    await expect(requireAuthClaims()).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("propaga MisconfiguredError (503) si la config falta", async () => {
    state.serverThrow = new SupabaseConfigError("faltan variables");
    await expect(requireAuthClaims()).rejects.toBeInstanceOf(MisconfiguredError);
  });

  it("devuelve los claims si hay sesión", async () => {
    state.getClaimsResult = {
      data: { claims: { sub: "33333333-3333-3333-3333-333333333333" } },
      error: null,
    };
    expect((await requireAuthClaims()).sub).toBe("33333333-3333-3333-3333-333333333333");
  });
});
