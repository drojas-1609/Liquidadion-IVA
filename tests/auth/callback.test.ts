import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SECURITY_HEADERS } from "@/lib/security-headers";

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({
    auth: { exchangeCodeForSession, verifyOtp },
  }),
}));

import { GET } from "@/app/auth/callback/route";

const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = ["NODE_ENV", "CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"];
let saved: Record<string, string | undefined>;

/** callback en localhost (host desde la URL). */
function call(qs: string) {
  return GET(new NextRequest(`http://localhost:3000/auth/callback${qs}`));
}
/** callback con X-Forwarded-Host (simula Netlify). */
function callFrom(host: string, qs: string, proto = "https") {
  return GET(
    new NextRequest(`https://internal.netlify/auth/callback${qs}`, {
      headers: { "x-forwarded-host": host, "x-forwarded-proto": proto, host: "internal.netlify" },
    }),
  );
}
function expectSecurityHeaders(res: { headers: Headers }) {
  for (const { key, value } of SECURITY_HEADERS) expect(res.headers.get(key), key).toBe(value);
}

beforeEach(() => {
  exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  saved = {};
  for (const k of ENV_KEYS) saved[k] = env[k];
  for (const k of ["CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"]) delete env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("/auth/callback — intercambio / verificación (intactos)", () => {
  it("flujo code: exchangeCodeForSession y redirige a next interno", async () => {
    const res = await call("?code=abc123&next=%2Fclients");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/clients");
  });

  it("flujo code sin next: redirige a la raíz", async () => {
    const res = await call("?code=abc123");
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("flujo token_hash: verifyOtp con el type recibido", async () => {
    const res = await call("?token_hash=xyz&type=recovery&next=%2Fupdate-password");
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "xyz", type: "recovery" });
    expect(res.headers.get("location")).toBe("http://localhost:3000/update-password");
  });

  it("type desconocido: 400 y no toca Supabase", async () => {
    const res = await call("?token_hash=xyz&type=bogus");
    expect(res.status).toBe(400);
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("sin parámetros válidos: 400 controlado + no-store + headers de seguridad", async () => {
    const res = await call("");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Parámetros de callback inválidos." });
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expectSecurityHeaders(res);
  });

  it("fallo de intercambio: /login?error=auth, sin fuga, con headers", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: "bad code" } });
    const res = await call("?code=bad");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=auth");
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expectSecurityHeaders(res);
  });

  it("fallo de verifyOtp: /login?error=auth", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "expired" } });
    const res = await call("?token_hash=xyz&type=recovery");
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=auth");
  });

  it("next absoluto/externo se descarta -> raíz del origen seguro", async () => {
    const res = await call("?code=abc&next=https%3A%2F%2Fevil.com%2Fx");
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
  });
});

describe("/auth/callback — redirige al MISMO entorno de origen", () => {
  it("code desde Deploy Preview -> mismo preview + next interno", async () => {
    env.NODE_ENV = "production";
    const res = await callFrom(
      "deploy-preview-3--liquidadoriva.netlify.app",
      "?code=abc&next=%2Fclients",
    );
    expect(res.headers.get("location")).toBe(
      "https://deploy-preview-3--liquidadoriva.netlify.app/clients",
    );
    expectSecurityHeaders(res);
  });

  it("token_hash desde Deploy Preview -> mismo preview", async () => {
    env.NODE_ENV = "production";
    const res = await callFrom(
      "deploy-preview-12--liquidadoriva.netlify.app",
      "?token_hash=xyz&type=recovery&next=%2Fupdate-password",
    );
    expect(res.headers.get("location")).toBe(
      "https://deploy-preview-12--liquidadoriva.netlify.app/update-password",
    );
  });

  it("desde producción -> producción", async () => {
    env.NODE_ENV = "production";
    const res = await callFrom("liquidadoriva.netlify.app", "?code=abc&next=%2F");
    expect(res.headers.get("location")).toBe("https://liquidadoriva.netlify.app/");
  });

  it("host reenviado malicioso -> NO se usa, cae al origen de producción", async () => {
    env.NODE_ENV = "production";
    const res = await callFrom("evil.com", "?code=abc&next=%2Fclients");
    expect(res.headers.get("location")).toBe("https://liquidadoriva.netlify.app/clients");
  });

  it("hostname parecido / sufijo extra -> rechazado", async () => {
    env.NODE_ENV = "production";
    for (const bad of [
      "deploy-preview-3--liquidadoriva.netlify.app.evil.com",
      "evildeploy-preview-3--liquidadoriva.netlify.app",
      "deploy-preview-x--liquidadoriva.netlify.app",
    ]) {
      const res = await callFrom(bad, "?code=abc");
      expect(res.headers.get("location"), bad).toBe("https://liquidadoriva.netlify.app/");
    }
  });

  it("protocolo inválido -> rechazado", async () => {
    env.NODE_ENV = "production";
    const res = await callFrom("deploy-preview-3--liquidadoriva.netlify.app", "?code=abc", "ftp");
    expect(res.headers.get("location")).toBe("https://liquidadoriva.netlify.app/");
  });
});
