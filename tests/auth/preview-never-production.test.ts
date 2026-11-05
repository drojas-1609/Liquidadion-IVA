/**
 * Un build de Deploy Preview / branch deploy NUNCA redirige recuperación, callback,
 * logout ni el destino de invitación al origen de producción (incidente del
 * 05/11/2026: tras renombrar el sitio, la recuperación de una cuenta DEV en una
 * Preview terminó en /update-password de producción con la sesión del OWNER).
 *
 * `AUTH_BUILD_CONTEXT` / `AUTH_BUILD_PRIME_URL` los inyecta next.config.ts en el
 * build; acá se simulan en el entorno, sin `CONTEXT` (que no existe en runtime).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";

const auth = {
  verifyOtp: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  signOut: vi.fn(),
};
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: async () => ({ auth }) }));
const mockHeaders: { value: Headers } = { value: new Headers() };
vi.mock("next/headers", () => ({ headers: async () => mockHeaders.value }));

import { getSafeRedirectOrigin, getTrustedOrigin, UnsafeRedirectOriginError } from "@/lib/auth/origin";
import { confirmRecoveryAction } from "@/app/auth/confirm-recovery/actions";
import { requestResetAction } from "@/app/reset-password/actions";
import { GET as callback } from "@/app/auth/callback/route";
import { POST as logout } from "@/app/logout/route";

const PREVIEW = "deploy-preview-30--derocompanygestion.netlify.app";
const PROD = "derocompanygestion.netlify.app";
const OLD = "liquidadoriva.netlify.app";
const GOOD_TH = "pkce_" + "a1b2c3d4e5f60718".repeat(3);

const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = ["NODE_ENV", "CONTEXT", "URL", "DEPLOY_PRIME_URL", "DEPLOY_URL", "AUTH_PRODUCTION_ORIGIN", "AUTH_BUILD_CONTEXT", "AUTH_BUILD_PRIME_URL"];
let saved: Record<string, string | undefined>;

const xfh = (host: string) => ({ "x-forwarded-host": host, "x-forwarded-proto": "https", host: "internal.netlify" });
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (digest.includes("NEXT_REDIRECT")) return digest.split(";")[2] ?? "";
    throw e;
  }
  throw new Error("se esperaba un redirect");
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = env[k];
  for (const k of ENV_KEYS) delete env[k];
  env.NODE_ENV = "production";
  env.AUTH_BUILD_CONTEXT = "deploy-preview";
  env.AUTH_BUILD_PRIME_URL = `https://${PREVIEW}`;
  // Aunque producción esté configurada, un build de preview no la usa.
  env.AUTH_PRODUCTION_ORIGIN = `https://${PROD}`;
  for (const f of Object.values(auth)) f.mockReset();
  auth.verifyOtp.mockResolvedValue({ error: null });
  auth.exchangeCodeForSession.mockResolvedValue({ error: null });
  auth.resetPasswordForEmail.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue({ error: null });
  mockHeaders.value = new Headers();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("origen en un build de Deploy Preview", () => {
  it("request del mismo preview -> ese preview", () => {
    expect(getSafeRedirectOrigin({ headers: new Headers(xfh(PREVIEW)) })).toBe(`https://${PREVIEW}`);
  });

  it("request con host de producción o del nombre anterior -> el propio preview, nunca producción", () => {
    for (const host of [PROD, OLD, "evil.com", `deploy-preview-30--${OLD}`]) {
      expect(getSafeRedirectOrigin({ headers: new Headers(xfh(host)) })).toBe(`https://${PREVIEW}`);
      expect(getTrustedOrigin({ headers: new Headers(xfh(host)) })).toBe(`https://${PREVIEW}`);
    }
  });

  it("sin origen de preview válido -> error, nunca producción", () => {
    delete env.AUTH_BUILD_PRIME_URL;
    for (const host of [PROD, OLD, "evil.com"]) {
      expect(() => getSafeRedirectOrigin({ headers: new Headers(xfh(host)) })).toThrow(UnsafeRedirectOriginError);
    }
    expect(() => getSafeRedirectOrigin()).toThrow(UnsafeRedirectOriginError);
    env.AUTH_BUILD_PRIME_URL = `https://${PROD}`; // prime URL de producción: tampoco
    expect(() => getSafeRedirectOrigin()).toThrow(UnsafeRedirectOriginError);
  });

  it("branch deploy -> su propio host de rama", () => {
    env.AUTH_BUILD_CONTEXT = "branch-deploy";
    env.AUTH_BUILD_PRIME_URL = `https://codex-rol--${PROD}`;
    expect(getSafeRedirectOrigin({ headers: new Headers(xfh(`codex-rol--${PROD}`)) })).toBe(`https://codex-rol--${PROD}`);
    expect(getSafeRedirectOrigin({ headers: new Headers(xfh(PROD)) })).toBe(`https://codex-rol--${PROD}`);
  });
});

describe("rutas de autenticación en un build de Deploy Preview", () => {
  it("recuperación (POST Confirmar) -> /update-password del preview, aunque la request diga producción", async () => {
    for (const host of [PREVIEW, PROD]) {
      mockHeaders.value = new Headers(xfh(host));
      const to = await redirectOf(confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery" })));
      expect(to).toBe(`https://${PREVIEW}/update-password`);
    }
  });

  it("recuperación sin origen de preview -> no redirige a producción", async () => {
    delete env.AUTH_BUILD_PRIME_URL;
    mockHeaders.value = new Headers(xfh(PROD));
    await expect(confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery" }))).rejects.toThrow(UnsafeRedirectOriginError);
  });

  it("pedido de recuperación -> redirectTo del preview; sin origen válido no se envía nada", async () => {
    mockHeaders.value = new Headers(xfh(PROD));
    expect(await requestResetAction({ done: false }, fd({ email: "a@dero.test" }))).toEqual({ done: true });
    expect(auth.resetPasswordForEmail.mock.calls[0][1].redirectTo).toBe(`https://${PREVIEW}/auth/confirm-recovery`);
    auth.resetPasswordForEmail.mockClear();
    delete env.AUTH_BUILD_PRIME_URL;
    expect(await requestResetAction({ done: false }, fd({ email: "a@dero.test" }))).toEqual({ done: true });
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("callback -> mismo preview", async () => {
    for (const host of [PREVIEW, PROD]) {
      const res = await callback(new NextRequest("https://internal.netlify/auth/callback?code=abc&next=%2Fclients", { headers: xfh(host) }));
      expect(res.headers.get("location")).toBe(`https://${PREVIEW}/clients`);
    }
  });

  it("logout -> /login del preview", async () => {
    for (const host of [PREVIEW, PROD]) {
      const res = await logout(new NextRequest("https://placeholder.invalid/logout", { method: "POST", headers: xfh(host) }));
      expect(res.headers.get("location")).toBe(`https://${PREVIEW}/login`);
    }
  });
});

describe("producción y nombre anterior", () => {
  it("build de producción: host del sitio actual; el nombre anterior no se acepta ni es fallback", () => {
    env.AUTH_BUILD_CONTEXT = "production";
    delete env.AUTH_BUILD_PRIME_URL;
    delete env.AUTH_PRODUCTION_ORIGIN;
    expect(getSafeRedirectOrigin({ headers: new Headers(xfh(PROD)) })).toBe(`https://${PROD}`);
    for (const host of [OLD, `deploy-preview-3--${OLD}`, "evil.com"]) {
      expect(getSafeRedirectOrigin({ headers: new Headers(xfh(host)) })).toBe(`https://${PROD}`);
    }
    expect(getTrustedOrigin()).toBe(`https://${PROD}`);
  });

  it("next.config.ts inyecta el contexto del build y nada en lib/ apunta al nombre anterior como destino", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const cfg = readFileSync(root + "next.config.ts", "utf8");
    expect(cfg).toMatch(/AUTH_BUILD_CONTEXT\s*=\s*process\.env\.CONTEXT/);
    expect(cfg).toMatch(/env:\s*\{\s*AUTH_BUILD_CONTEXT,\s*AUTH_BUILD_PRIME_URL,/);
    const origin = readFileSync(root + "lib/auth/origin.ts", "utf8");
    expect(origin).toContain('const SITE = "derocompanygestion.netlify.app"');
    expect(origin.split("\n").filter((l) => l.includes(OLD) && !l.trim().startsWith("*"))).toEqual([]);
  });
});
