import { describe, it, expect, vi, beforeEach } from "vitest";

const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
const updateUser = vi.fn().mockResolvedValue({ error: null });
const getAuthClaims = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({
    auth: { resetPasswordForEmail, updateUser },
  }),
}));
vi.mock("@/lib/auth/claims", () => ({
  getAuthClaims: () => getAuthClaims(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
}));

import { requestResetAction } from "@/app/reset-password/actions";
import { updatePasswordAction } from "@/app/update-password/actions";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  resetPasswordForEmail.mockClear();
  updateUser.mockClear();
  getAuthClaims.mockReset();
});

describe("requestResetAction — respuesta siempre genérica", () => {
  it("con correo: dispara el envío y responde done", async () => {
    const state = await requestResetAction({ done: false }, fd({ email: "user@dero.test" }));
    expect(state).toEqual({ done: true });
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
    const [, opts] = resetPasswordForEmail.mock.calls[0];
    expect(opts.redirectTo).toBe("http://localhost:3000/auth/confirm-recovery");
  });

  it("sin correo: no dispara nada pero responde done igual", async () => {
    const state = await requestResetAction({ done: false }, fd({}));
    expect(state).toEqual({ done: true });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("si el proveedor falla, la respuesta no cambia", async () => {
    resetPasswordForEmail.mockRejectedValueOnce(new Error("smtp down"));
    const state = await requestResetAction({ done: false }, fd({ email: "user@dero.test" }));
    expect(state).toEqual({ done: true });
  });
});

describe("updatePasswordAction — exige sesión de recuperación válida", () => {
  it("sin sesión: error y NO llama updateUser", async () => {
    getAuthClaims.mockResolvedValue(null);
    const state = await updatePasswordAction(
      { error: null },
      fd({ password: "unpassword-larguito", confirm: "unpassword-larguito" }),
    );
    expect(state.error).toMatch(/no es válido o expiró/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("contraseña corta: error antes de mirar la sesión", async () => {
    const state = await updatePasswordAction({ error: null }, fd({ password: "corta", confirm: "corta" }));
    expect(state.error).toMatch(/al menos 12/i);
    expect(getAuthClaims).not.toHaveBeenCalled();
  });

  it("no coinciden: error", async () => {
    const state = await updatePasswordAction(
      { error: null },
      fd({ password: "unpassword-larguito", confirm: "otra-larguita-1234" }),
    );
    expect(state.error).toMatch(/no coinciden/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("con sesión válida: llama updateUser y redirige", async () => {
    getAuthClaims.mockResolvedValue({ sub: "u1", email: null, authRole: "authenticated", raw: {} });
    let threw: unknown;
    try {
      await updatePasswordAction(
        { error: null },
        fd({ password: "unpassword-larguito", confirm: "unpassword-larguito" }),
      );
    } catch (e) {
      threw = e;
    }
    expect(updateUser).toHaveBeenCalledWith({ password: "unpassword-larguito" });
    // redirect() lanza NEXT_REDIRECT
    expect((threw as { digest?: string })?.digest ?? "").toContain("NEXT_REDIRECT");
  });
});
