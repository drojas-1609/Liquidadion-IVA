/**
 * `requestResetAction`: el `redirectTo` que recibe Supabase debe apuntar a
 * `/auth/confirm-recovery` (página intermedia anti-escáner) del MISMO entorno
 * válido de origen (política compartida `getSafeRedirectOrigin`). Sin enviar
 * emails reales (`resetPasswordForEmail` está mockeado).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({ auth: { resetPasswordForEmail } }),
}));

const mockHeaders: { value: Headers } = { value: new Headers() };
vi.mock("next/headers", () => ({
  headers: async () => mockHeaders.value,
}));

import { requestResetAction } from "@/app/reset-password/actions";

const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = ["NODE_ENV", "CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"];
let saved: Record<string, string | undefined>;

function setHeaders(h: Record<string, string>) {
  mockHeaders.value = new Headers(h);
}
function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}
async function redirectToFor(email = "user@dero.test"): Promise<string> {
  resetPasswordForEmail.mockClear();
  const state = await requestResetAction({ done: false }, fd({ email }));
  expect(state).toEqual({ done: true });
  expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
  const [, opts] = resetPasswordForEmail.mock.calls[0];
  return opts.redirectTo as string;
}

const SUFFIX = "/auth/confirm-recovery";

beforeEach(() => {
  resetPasswordForEmail.mockReset().mockResolvedValue({ error: null });
  mockHeaders.value = new Headers();
  saved = {};
  for (const k of ENV_KEYS) saved[k] = env[k];
  for (const k of ["CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"]) delete env[k];
  env.NODE_ENV = "production"; // simula runtime desplegado sin vars de build
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("requestResetAction — redirectTo por entorno", () => {
  it("Deploy Preview -> confirm-recovery del mismo preview", async () => {
    setHeaders({
      "x-forwarded-host": "deploy-preview-3--liquidadoriva.netlify.app",
      "x-forwarded-proto": "https",
    });
    expect(await redirectToFor()).toBe(
      `https://deploy-preview-3--liquidadoriva.netlify.app${SUFFIX}`,
    );
  });

  it("no hardcodea el número de preview", async () => {
    setHeaders({
      "x-forwarded-host": "deploy-preview-812--liquidadoriva.netlify.app",
      "x-forwarded-proto": "https",
    });
    expect(await redirectToFor()).toBe(
      `https://deploy-preview-812--liquidadoriva.netlify.app${SUFFIX}`,
    );
  });

  it("Producción (host del sitio) -> confirm-recovery de producción", async () => {
    setHeaders({ "x-forwarded-host": "liquidadoriva.netlify.app", "x-forwarded-proto": "https" });
    expect(await redirectToFor()).toBe(`https://liquidadoriva.netlify.app${SUFFIX}`);
  });

  it("Producción con AUTH_PRODUCTION_ORIGIN -> ese dominio", async () => {
    env.AUTH_PRODUCTION_ORIGIN = "https://app.derocompany.com.ar";
    setHeaders({ "x-forwarded-host": "app.derocompany.com.ar", "x-forwarded-proto": "https" });
    expect(await redirectToFor()).toBe(`https://app.derocompany.com.ar${SUFFIX}`);
  });

  it("localhost en desarrollo -> confirm-recovery local", async () => {
    env.NODE_ENV = "development";
    setHeaders({ host: "localhost:3000" });
    expect(await redirectToFor()).toBe(`http://localhost:3000${SUFFIX}`);
  });

  it("redirectTo apunta a /auth/confirm-recovery, sin query (el token_hash lo agrega Supabase)", async () => {
    setHeaders({ "x-forwarded-host": "liquidadoriva.netlify.app", "x-forwarded-proto": "https" });
    const url = new URL(await redirectToFor());
    expect(url.pathname).toBe("/auth/confirm-recovery");
    expect(url.search).toBe("");
  });
});

describe("requestResetAction — rechazos (nunca un host sin validar)", () => {
  const PROD = `https://liquidadoriva.netlify.app${SUFFIX}`;

  it("host reenviado malicioso -> fallback de producción", async () => {
    for (const bad of ["evil.com", "attacker.example", "phish.liquidadoriva.com"]) {
      setHeaders({ "x-forwarded-host": bad, "x-forwarded-proto": "https" });
      expect(await redirectToFor(), bad).toBe(PROD);
    }
  });

  it("hostname parecido / sufijo adicional -> rechazado", async () => {
    for (const bad of [
      "deploy-preview-3--liquidadoriva.netlify.app.evil.com",
      "evildeploy-preview-3--liquidadoriva.netlify.app",
      "deploy-preview-x--liquidadoriva.netlify.app",
      "liquidadoriva.netlify.app.attacker.io",
      "deploy-preview-3--liquidadoriva.netlify.app:8080",
    ]) {
      setHeaders({ "x-forwarded-host": bad, "x-forwarded-proto": "https" });
      expect(await redirectToFor(), bad).toBe(PROD);
    }
  });

  it("protocolo inseguro en host de Netlify -> rechazado", async () => {
    setHeaders({
      "x-forwarded-host": "deploy-preview-3--liquidadoriva.netlify.app",
      "x-forwarded-proto": "http",
    });
    expect(await redirectToFor()).toBe(PROD);
  });

  it("sin encabezados de host -> fallback seguro", async () => {
    mockHeaders.value = new Headers();
    expect(await redirectToFor()).toBe(PROD);
  });

  it("localhost NO se acepta en producción", async () => {
    setHeaders({ "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" });
    expect(await redirectToFor()).toBe(PROD);
  });
});

describe("requestResetAction — anti-enumeración y errores", () => {
  it("no revela si el email existe: misma respuesta y misma llamada para cualquier correo", async () => {
    setHeaders({ "x-forwarded-host": "liquidadoriva.netlify.app", "x-forwarded-proto": "https" });
    for (const email of ["existe@dero.test", "no-existe@ejemplo.org", "otro@correo.io"]) {
      resetPasswordForEmail.mockClear();
      const state = await requestResetAction({ done: false }, fd({ email }));
      expect(state).toEqual({ done: true });
      expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
      const [passedEmail, opts] = resetPasswordForEmail.mock.calls[0];
      expect(passedEmail).toBe(email);
      expect(opts.redirectTo).toBe(`https://liquidadoriva.netlify.app${SUFFIX}`);
    }
  });

  it("sin correo -> done, sin llamar a Supabase (sin email)", async () => {
    const state = await requestResetAction({ done: false }, fd({}));
    expect(state).toEqual({ done: true });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("error de Supabase -> respuesta genérica controlada (done), sin filtrar", async () => {
    setHeaders({ "x-forwarded-host": "liquidadoriva.netlify.app", "x-forwarded-proto": "https" });
    resetPasswordForEmail.mockRejectedValueOnce(new Error("rate limited"));
    const state = await requestResetAction({ done: false }, fd({ email: "user@dero.test" }));
    expect(state).toEqual({ done: true });
  });

  it("ningún email real: resetPasswordForEmail es un mock", () => {
    expect(vi.isMockFunction(resetPasswordForEmail)).toBe(true);
  });
});
