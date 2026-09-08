import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SECURITY_HEADERS } from "@/lib/security-headers";

const signOut = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({ auth: { signOut } }),
}));

import { GET, POST } from "@/app/logout/route";
import { getLogoutRedirectUrl } from "@/lib/auth/origin";

const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = ["NODE_ENV", "CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"];
let saved: Record<string, string | undefined>;

function req(host: string, extra: Record<string, string> = {}) {
  return new NextRequest("https://placeholder.invalid/logout", {
    method: "POST",
    headers: { host, ...extra },
  });
}
function reqXfh(xfHost: string, proto = "https") {
  return new NextRequest("https://placeholder.invalid/logout", {
    method: "POST",
    headers: { "x-forwarded-host": xfHost, "x-forwarded-proto": proto, host: "internal.netlify" },
  });
}
function expectSecurityHeaders(res: { headers: Headers }) {
  for (const { key, value } of SECURITY_HEADERS) expect(res.headers.get(key), key).toBe(value);
}

beforeEach(() => {
  signOut.mockClear();
  saved = {};
  for (const k of ENV_KEYS) saved[k] = env[k];
  // Simula el runtime de Netlify: CONTEXT / URL / DEPLOY_PRIME_URL NO están.
  for (const k of ["CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"]) delete env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("/logout — GET", () => {
  it("405 con Allow: POST, no toca la sesión, con headers de seguridad + no-store", () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(signOut).not.toHaveBeenCalled();
    expectSecurityHeaders(res);
  });
});

describe("/logout — POST redirige al /login del MISMO entorno", () => {
  it("Deploy Preview: preserva el host del preview (bug corregido)", async () => {
    env.NODE_ENV = "production";
    const res = await POST(reqXfh("deploy-preview-3--liquidadoriva.netlify.app"));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://deploy-preview-3--liquidadoriva.netlify.app/login",
    );
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expectSecurityHeaders(res);
  });

  it("Producción: redirige al /login de producción", async () => {
    env.NODE_ENV = "production";
    const res = await POST(reqXfh("liquidadoriva.netlify.app"));
    expect(res.headers.get("location")).toBe("https://liquidadoriva.netlify.app/login");
  });

  it("Producción con dominio propio declarado (AUTH_PRODUCTION_ORIGIN)", async () => {
    env.NODE_ENV = "production";
    env.AUTH_PRODUCTION_ORIGIN = "https://app.derocompany.com.ar";
    const res = await POST(reqXfh("app.derocompany.com.ar"));
    expect(res.headers.get("location")).toBe("https://app.derocompany.com.ar/login");
  });

  it("localhost: redirige a http://localhost:3000/login", async () => {
    env.NODE_ENV = "test";
    const res = await POST(req("localhost:3000"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("localhost con otro puerto en dev", async () => {
    env.NODE_ENV = "development";
    const res = await POST(req("localhost:4321", { "x-forwarded-proto": "http" }));
    expect(res.headers.get("location")).toBe("http://localhost:4321/login");
  });

  it("redirige aunque signOut falle", async () => {
    env.NODE_ENV = "production";
    signOut.mockRejectedValueOnce(new Error("no session"));
    const res = await POST(reqXfh("deploy-preview-9--liquidadoriva.netlify.app"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://deploy-preview-9--liquidadoriva.netlify.app/login",
    );
  });
});

describe("getLogoutRedirectUrl — política de host (seguridad)", () => {
  const PROD_FALLBACK = "https://liquidadoriva.netlify.app/login";

  beforeEach(() => {
    env.NODE_ENV = "production";
  });

  it("host reenviado malicioso -> NO se usa, cae al fallback de producción", () => {
    expect(getLogoutRedirectUrl(reqXfh("evil.com"))).toBe(PROD_FALLBACK);
    expect(getLogoutRedirectUrl(reqXfh("attacker.example"))).toBe(PROD_FALLBACK);
  });

  it("hostname parecido pero inválido -> rechazado", () => {
    for (const bad of [
      "deploy-preview-3--liquidadoriva.netlify.app.evil.com", // sufijo extra
      "evildeploy-preview-3--liquidadoriva.netlify.app", // prefijo extra
      "deploy-preview-x--liquidadoriva.netlify.app", // sin número
      "deploy-preview---liquidadoriva.netlify.app", // sin número
      "deploy-preview-3--liquidadoriva-netlify.app", // punto -> guion
      "deploy-preview-3--liquidadoriva.netlify.app.attacker.io",
      "liquidadoriva.netlify.app.evil.com",
      "xliquidadoriva.netlify.app",
      "deploy-preview-3--liquidadoriva.netlify.app:8080", // puerto inesperado
    ]) {
      expect(getLogoutRedirectUrl(reqXfh(bad)), bad).toBe(PROD_FALLBACK);
    }
  });

  it("protocolo inválido -> rechazado (no se usa el host)", () => {
    expect(getLogoutRedirectUrl(reqXfh("deploy-preview-3--liquidadoriva.netlify.app", "ftp"))).toBe(
      PROD_FALLBACK,
    );
    // http (no https) para un host de Netlify en producción -> rechazado
    expect(getLogoutRedirectUrl(reqXfh("deploy-preview-3--liquidadoriva.netlify.app", "http"))).toBe(
      PROD_FALLBACK,
    );
  });

  it("localhost NO se acepta en producción", () => {
    expect(getLogoutRedirectUrl(reqXfh("localhost:3000", "http"))).toBe(PROD_FALLBACK);
  });

  it("sin cabeceras de host utilizables -> fallback seguro, nunca abierto", () => {
    const bare = { headers: new Headers() };
    expect(getLogoutRedirectUrl(bare)).toBe(PROD_FALLBACK);
  });

  it("no hardcodea el número: acepta cualquier deploy-preview-<n>", () => {
    for (const n of [1, 7, 42, 12345]) {
      expect(getLogoutRedirectUrl(reqXfh(`deploy-preview-${n}--liquidadoriva.netlify.app`))).toBe(
        `https://deploy-preview-${n}--liquidadoriva.netlify.app/login`,
      );
    }
  });
});
