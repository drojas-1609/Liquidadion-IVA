import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
  claims: { value: null as unknown },
  hasInvitation: vi.fn(),
  accept: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({ auth: { verifyOtp: H.verifyOtp, updateUser: H.updateUser } }),
}));
vi.mock("@/lib/auth/claims", () => ({ getAuthClaims: async () => H.claims.value }));
vi.mock("@/lib/users/service", () => ({ hasAcceptableInvitation: H.hasInvitation, acceptInvitation: H.accept }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { acceptInviteAction } from "@/app/auth/accept-invite/actions";
import { ConflictError } from "@/lib/auth/errors";
import { isPublicPath } from "@/lib/auth/proxy-matcher";

const TOKEN = "pkce_0123456789abcdef0123456789abcdef";
const SUB = "aaaaaaaa-0000-4000-8000-00000000a0a1";
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const run = (fields: Record<string, string>) => acceptInviteAction({ error: null }, form(fields));

beforeEach(() => {
  vi.clearAllMocks();
  H.verifyOtp.mockResolvedValue({ error: null });
  H.updateUser.mockResolvedValue({ error: null });
  H.claims.value = { sub: SUB, email: "ana.sintetica@estudio.test", authRole: "authenticated", raw: {} };
  H.hasInvitation.mockResolvedValue(true);
  H.accept.mockResolvedValue({ organizationId: "org_a", membershipId: "m1" });
});

describe("/auth/accept-invite — acción", () => {
  it("la página es pública (fuera del gate de sesión)", () => {
    expect(isPublicPath("/auth/accept-invite")).toBe(true);
  });

  it("enlace malformado o de otro tipo: no consume el token", async () => {
    expect((await run({ token_hash: "x", type: "invite" })).error).toMatch(/no es válido/);
    expect((await run({ token_hash: TOKEN, type: "recovery" })).error).toMatch(/no es válido/);
    expect(H.verifyOtp).not.toHaveBeenCalled();
  });

  it("cuenta nueva: contraseña corta o distinta se rechaza ANTES de consumir el token", async () => {
    expect((await run({ token_hash: TOKEN, type: "invite", password: "corta", confirm: "corta" })).error).toMatch(/12 caracteres/);
    expect((await run({ token_hash: TOKEN, type: "invite", password: "a".repeat(12), confirm: "b".repeat(12) })).error).toMatch(/no coinciden/);
    expect(H.verifyOtp).not.toHaveBeenCalled();
  });

  it("sin invitación vigente para la identidad: NO cambia la contraseña ni acepta", async () => {
    H.hasInvitation.mockResolvedValue(false);
    const r = await run({ token_hash: TOKEN, type: "invite", password: "x".repeat(12), confirm: "x".repeat(12) });
    expect(r.error).toMatch(/No encontramos una invitación/);
    expect(H.updateUser).not.toHaveBeenCalled();
    expect(H.accept).not.toHaveBeenCalled();
  });

  it("sin sesión tras verificar: enlace inválido", async () => {
    H.claims.value = null;
    expect((await run({ token_hash: TOKEN, type: "magiclink" })).error).toMatch(/no es válido/);
    expect(H.accept).not.toHaveBeenCalled();
  });

  it("cuenta nueva: verifica, define la contraseña, acepta con la identidad verificada y entra", async () => {
    const pw = "una-clave-larga-sintetica";
    await expect(run({ token_hash: TOKEN, type: "invite", password: pw, confirm: pw })).rejects.toThrow("REDIRECT:http://localhost:3000/");
    expect(H.verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN, type: "invite" });
    expect(H.updateUser).toHaveBeenCalledWith({ password: pw });
    expect(H.accept).toHaveBeenCalledWith({ sub: SUB, email: "ana.sintetica@estudio.test" });
    expect(H.updateUser.mock.invocationCallOrder[0]).toBeLessThan(H.accept.mock.invocationCallOrder[0]);
  });

  it("cuenta existente (magiclink): no toca la contraseña", async () => {
    await expect(run({ token_hash: TOKEN, type: "magiclink" })).rejects.toThrow("REDIRECT:");
    expect(H.updateUser).not.toHaveBeenCalled();
    expect(H.accept).toHaveBeenCalled();
  });

  it("conflicto al aceptar (p. ej. otro estudio): mensaje legible, sin redirigir", async () => {
    H.accept.mockRejectedValue(new ConflictError("Tu cuenta ya tiene acceso activo a otro estudio."));
    expect((await run({ token_hash: TOKEN, type: "magiclink" })).error).toBe("Tu cuenta ya tiene acceso activo a otro estudio.");
  });
});
