import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const resolveProxySession = vi.fn();
vi.mock("@/lib/supabase/proxy-session", () => ({
  resolveProxySession: (...args: unknown[]) => resolveProxySession(...args),
}));

import { proxy, config } from "@/proxy";
import { isPublicPath, PROXY_MATCHER, PUBLIC_PREFIXES } from "@/lib/auth/proxy-matcher";

function makeReq(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

beforeEach(() => resolveProxySession.mockReset());

describe("proxy — gate de sesión", () => {
  it("con sesión: devuelve la respuesta de passthrough sin tocarla", async () => {
    const passthrough = NextResponse.next();
    resolveProxySession.mockResolvedValue({ response: passthrough, isAuthenticated: true });

    const out = await proxy(makeReq("/clients"));
    expect(out).toBe(passthrough);
  });

  it("sin sesión en /clients: 303 a /login?next=%2Fclients", async () => {
    resolveProxySession.mockResolvedValue({
      response: NextResponse.next(),
      isAuthenticated: false,
    });

    const out = await proxy(makeReq("/clients?x=1"));
    expect(out.status).toBe(303);
    const loc = out.headers.get("location")!;
    expect(loc).toContain("/login");
    expect(loc).toContain("next=%2Fclients%3Fx%3D1");
    expect(out.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("sin sesión en /: 303 a /login sin parámetro next", async () => {
    resolveProxySession.mockResolvedValue({
      response: NextResponse.next(),
      isAuthenticated: false,
    });
    const out = await proxy(makeReq("/"));
    expect(out.status).toBe(303);
    const loc = out.headers.get("location")!;
    expect(loc).toMatch(/\/login$/);
  });

  it("propaga cookies de sesión refrescadas al redirect", async () => {
    const response = NextResponse.next();
    response.cookies.set("sb-ref-auth-token", "refreshed");
    resolveProxySession.mockResolvedValue({ response, isAuthenticated: false });

    const out = await proxy(makeReq("/clients"));
    expect(out.cookies.get("sb-ref-auth-token")?.value).toBe("refreshed");
  });

  it("ruta pública: no llama a resolveProxySession", async () => {
    const out = await proxy(makeReq("/login"));
    expect(resolveProxySession).not.toHaveBeenCalled();
    expect(out.status).toBe(200);
  });
});

describe("isPublicPath vs rutas protegidas", () => {
  it("son públicas las rutas de auth y los assets", () => {
    for (const p of ["/login", "/reset-password", "/update-password", "/logout", "/auth/callback"]) {
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

  it("todo PUBLIC_PREFIXES es efectivamente público", () => {
    for (const p of PUBLIC_PREFIXES) expect(isPublicPath(p)).toBe(true);
  });
});
