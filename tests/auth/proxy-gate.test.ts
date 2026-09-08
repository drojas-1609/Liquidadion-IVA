import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { SupabaseConfigError } from "@/lib/supabase/env";

// Estado controlable del mock (sin vi.fn().mockRejectedValue, que puede dejar
// promesas rechazadas sin manejar entre tests).
const mockSession: {
  calls: number;
  throw: unknown;
  value: { response: NextResponse; isAuthenticated: boolean } | null;
} = { calls: 0, throw: null, value: null };

vi.mock("@/lib/supabase/proxy-session", () => ({
  resolveProxySession: async () => {
    mockSession.calls += 1;
    if (mockSession.throw) throw mockSession.throw;
    return mockSession.value;
  },
}));

import { proxy, config } from "@/proxy";
import { isPublicPath, PROXY_MATCHER, PUBLIC_PREFIXES } from "@/lib/auth/proxy-matcher";
import { SECURITY_HEADERS } from "@/lib/security-headers";

function makeReq(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}
function expectSecurityHeaders(res: NextResponse) {
  for (const { key, value } of SECURITY_HEADERS) {
    expect(res.headers.get(key), key).toBe(value);
  }
}
function sessionOk(isAuthenticated: boolean, response = NextResponse.next()) {
  mockSession.value = { response, isAuthenticated };
  mockSession.throw = null;
}
function sessionThrows(err: unknown) {
  mockSession.throw = err;
  mockSession.value = null;
}

beforeEach(() => {
  mockSession.calls = 0;
  mockSession.throw = null;
  mockSession.value = null;
});

describe("proxy — gate de sesión", () => {
  it("con sesión: devuelve la respuesta de passthrough sin tocarla", async () => {
    const passthrough = NextResponse.next();
    sessionOk(true, passthrough);
    expect(await proxy(makeReq("/clients"))).toBe(passthrough);
  });

  it("sin sesión en /clients: 303 a /login?next=%2Fclients + headers de seguridad", async () => {
    sessionOk(false);
    const out = await proxy(makeReq("/clients?x=1"));
    expect(out.status).toBe(303);
    const loc = out.headers.get("location")!;
    expect(loc).toContain("/login");
    expect(loc).toContain("next=%2Fclients%3Fx%3D1");
    expect(out.headers.get("cache-control")).toBe("no-store, max-age=0");
    expectSecurityHeaders(out);
  });

  it("sin sesión en /: 303 a /login sin parámetro next", async () => {
    sessionOk(false);
    const out = await proxy(makeReq("/"));
    expect(out.status).toBe(303);
    expect(out.headers.get("location")!).toMatch(/\/login$/);
  });

  it("propaga cookies de sesión refrescadas al redirect, con todos sus atributos", async () => {
    const response = NextResponse.next();
    response.cookies.set("sb-ref-auth-token", "refreshed", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3600,
    });
    sessionOk(false, response);
    const out = await proxy(makeReq("/clients"));
    const c = out.cookies.get("sb-ref-auth-token");
    expect(c?.value).toBe("refreshed");
    expect(c?.httpOnly).toBe(true);
    expect(c?.secure).toBe(true);
    expect(c?.sameSite).toBe("lax");
    expect(c?.path).toBe("/");
    expect(c?.maxAge).toBe(3600);
    // los headers de seguridad no interfieren con Set-Cookie
    expectSecurityHeaders(out);
  });

  it("ruta pública: no invoca resolveProxySession", async () => {
    const out = await proxy(makeReq("/login"));
    expect(mockSession.calls).toBe(0);
    expect(out.status).toBe(200);
  });

  it("sin sesión en /api/*: 401 JSON (no redirect) + headers de seguridad", async () => {
    sessionOk(false);
    const out = await proxy(makeReq("/api/clients"));
    expect(out.status).toBe(401);
    expect(out.headers.get("location")).toBeNull();
    expect((await out.json()).error.code).toBe("UNAUTHENTICATED");
    expect(out.headers.get("cache-control")).toBe("no-store, max-age=0");
    expectSecurityHeaders(out);
  });

  it("config ausente: 503 JSON en /api/*, 503 texto en página + headers de seguridad", async () => {
    sessionThrows(new SupabaseConfigError("faltan variables"));
    const api = await proxy(makeReq("/api/clients"));
    expect(api.status).toBe(503);
    expect((await api.json()).error.code).toBe("MISCONFIGURED");
    expect(api.headers.get("cache-control")).toBe("no-store, max-age=0");
    expectSecurityHeaders(api);

    const page = await proxy(makeReq("/clients"));
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toContain("text/plain");
    expect(page.headers.get("cache-control")).toBe("no-store, max-age=0");
    expectSecurityHeaders(page);
  });

  it("error inesperado resolviendo la sesión: 500 controlado + headers, nunca passthrough", async () => {
    sessionThrows(new Error("kaboom"));
    const page = await proxy(makeReq("/clients"));
    expect(page.status).toBe(500);
    expectSecurityHeaders(page);
    const api = await proxy(makeReq("/api/clients"));
    expect(api.status).toBe(500);
    expect((await api.json()).error.code).toBe("INTERNAL");
    expectSecurityHeaders(api);
  });
});

describe("isPublicPath vs rutas protegidas", () => {
  it("son públicas las rutas de auth y los assets", () => {
    for (const p of [
      "/login",
      "/reset-password",
      "/update-password",
      "/logout",
      "/auth/callback",
      "/auth/confirm-recovery",
    ]) {
      expect(isPublicPath(p), p).toBe(true);
      expect(isPublicPath(p + "/algo"), p + "/algo").toBe(true);
    }
    for (const p of ["/favicon.ico", "/robots.txt", "/_next/static/chunk.js", "/logo.svg", "/app.css"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it("NO son públicas las rutas de negocio ni la API", () => {
    for (const p of ["/", "/clients", "/client/abc", "/client/abc/period/1", "/api/clients", "/api/periods", "/settings"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("match por segmento EXACTO: /logout-x, /loginX, /update-password-fake NO son públicas", () => {
    for (const p of ["/logout-fake", "/loginX", "/login-attacker", "/update-password-data", "/auth/callbackX", "/auth/confirm-recoveryX", "/reset-password-x"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

describe("PROXY_MATCHER y PUBLIC_PREFIXES coinciden con isPublicPath", () => {
  const matcherRe = new RegExp("^" + PROXY_MATCHER + "$");

  it("config.matcher expone exactamente PROXY_MATCHER", () => {
    expect(config.matcher).toEqual([PROXY_MATCHER]);
  });

  it("el matcher NO alcanza las rutas públicas", () => {
    for (const p of [
      "/login",
      "/reset-password",
      "/update-password",
      "/logout",
      "/auth/callback",
      "/auth/confirm-recovery",
      "/_next/static/x.js",
      "/favicon.ico",
      "/logo.svg",
    ]) {
      expect(matcherRe.test(p), p).toBe(false);
    }
  });

  it("el matcher SÍ alcanza las rutas protegidas", () => {
    for (const p of ["/", "/clients", "/client/abc/period/1", "/api/clients", "/settings"]) {
      expect(matcherRe.test(p), p).toBe(true);
    }
  });

  it("el matcher SÍ alcanza rutas que solo parecen públicas (segmento no exacto)", () => {
    for (const p of ["/logout-fake", "/loginX", "/update-password-data", "/auth/callbackX", "/auth/confirm-recoveryX"]) {
      expect(matcherRe.test(p), p).toBe(true);
    }
  });

  it("todo PUBLIC_PREFIXES es efectivamente público", () => {
    for (const p of PUBLIC_PREFIXES) expect(isPublicPath(p)).toBe(true);
  });
});
