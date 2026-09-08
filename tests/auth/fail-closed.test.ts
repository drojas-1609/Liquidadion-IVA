/**
 * Matriz fail-closed de autenticación (revisión correctiva Tarea 3A).
 *
 * Cubre: variables ausentes en production, URL inválida, publishable key
 * ausente, excepción de getClaims(), cookie inválida, API protegida con config
 * ausente, página protegida con config ausente, y la confirmación de que
 * ningún caso continúa hacia el handler protegido (passthrough).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import { SupabaseConfigError } from "@/lib/supabase/env";

// ── mocks con estado mutable (sin promesas rechazadas colgando) ──────────────
const mockProxy: { throw: unknown; value: unknown } = { throw: null, value: null };
vi.mock("@/lib/supabase/proxy-session", () => ({
  resolveProxySession: async () => {
    if (mockProxy.throw) throw mockProxy.throw;
    return mockProxy.value;
  },
}));

const mockServer: { throw: unknown; auth: unknown } = { throw: null, auth: null };
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => {
    if (mockServer.throw) throw mockServer.throw;
    return { auth: mockServer.auth };
  },
}));

import { proxy } from "@/proxy";
import { getAuthClaims } from "@/lib/auth/claims";
import { MisconfiguredError } from "@/lib/auth/errors";
import { loginAction } from "@/app/login/actions";
import { getSupabasePublicEnv } from "@/lib/supabase/env";

const PROTECTED_PAGES = ["/", "/clients", "/client/abc/period/1", "/settings"];
const PROTECTED_APIS = ["/api/clients", "/api/periods", "/api/invoices"];

function req(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}
function fd(o: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
}

beforeEach(() => {
  mockProxy.throw = null;
  mockProxy.value = null;
  mockServer.throw = null;
  mockServer.auth = { getClaims: vi.fn(), signInWithPassword: vi.fn() };
});

// ── 1-3 · validación de configuración ───────────────────────────────────────
describe("config inválida se detecta antes de crear el cliente", () => {
  const envRef = process.env as Record<string, string | undefined>;
  const KEYS = ["NODE_ENV", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = envRef[k];
      delete envRef[k];
    }
    envRef.NODE_ENV = "production";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete envRef[k];
      else envRef[k] = saved[k];
    }
  });

  it("(1) variables ausentes en production -> SupabaseConfigError genérico", () => {
    expect(() => getSupabasePublicEnv()).toThrow(SupabaseConfigError);
    try {
      getSupabasePublicEnv();
    } catch (e) {
      expect((e as Error).message).toBe("Configuración de autenticación no disponible.");
    }
  });

  it("(2) URL inválida -> SupabaseConfigError", () => {
    envRef.NEXT_PUBLIC_SUPABASE_URL = "http://evil";
    envRef.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_larga_pero_dummy_1";
    expect(() => getSupabasePublicEnv()).toThrow(SupabaseConfigError);
  });

  it("(3) publishable key ausente -> SupabaseConfigError", () => {
    envRef.NEXT_PUBLIC_SUPABASE_URL = "https://ejemploref.supabase.co";
    expect(() => getSupabasePublicEnv()).toThrow(SupabaseConfigError);
  });
});

// ── 4 · excepción de getClaims() ────────────────────────────────────────────
describe("(4) excepción de getClaims()", () => {
  it("getAuthClaims() devuelve null (no lanza) y no autoriza", async () => {
    mockServer.auth = {
      getClaims: vi.fn().mockImplementation(() => {
        throw new Error("boom en verificación");
      }),
    };
    await expect(getAuthClaims()).resolves.toBeNull();
  });
});

// ── 5 · cookie inválida ────────────────────────────────────────────────────
describe("(5) cookie / token inválido", () => {
  it("getClaims devuelve error -> getAuthClaims null", async () => {
    mockServer.auth = {
      getClaims: vi.fn().mockResolvedValue({ data: null, error: { message: "invalid JWT" } }),
    };
    await expect(getAuthClaims()).resolves.toBeNull();
  });

  it("proxy con isAuthenticated=false -> página redirige a /login, API 401", async () => {
    mockProxy.value = { response: NextResponse.next(), isAuthenticated: false };
    const page = await proxy(req("/clients"));
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toContain("/login");

    const api = await proxy(req("/api/clients"));
    expect(api.status).toBe(401);
    expect((await api.json()).error.code).toBe("UNAUTHENTICATED");
    expect(api.headers.get("cache-control")).toBe("no-store, max-age=0");
  });
});

// ── config ausente: claims + proxy ─────────────────────────────────────────
describe("config ausente en la capa de auth", () => {
  it("getAuthClaims() lanza MisconfiguredError (503), NO devuelve anónimo", async () => {
    mockServer.throw = new SupabaseConfigError("faltan variables");
    await expect(getAuthClaims()).rejects.toBeInstanceOf(MisconfiguredError);
  });

  it("(6) API protegida con config ausente -> 503 JSON controlado", async () => {
    mockProxy.throw = new SupabaseConfigError("faltan variables");
    for (const p of PROTECTED_APIS) {
      const res = await proxy(req(p));
      expect(res.status, p).toBe(503);
      expect((await res.json()).error.code).toBe("MISCONFIGURED");
      expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    }
  });

  it("(7) página protegida con config ausente -> 503 controlado, sin contenido fiscal", async () => {
    mockProxy.throw = new SupabaseConfigError("faltan variables");
    for (const p of PROTECTED_PAGES) {
      const res = await proxy(req(p));
      expect(res.status, p).toBe(503);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    }
  });

  it("login action con config ausente -> error genérico, sin redirect", async () => {
    mockServer.throw = new SupabaseConfigError("faltan variables");
    const state = await loginAction({ error: null }, fd({ email: "a@b.com", password: "x".repeat(12) }));
    expect(state.error).toMatch(/no está disponible/i);
  });
});

// ── 8 · ningún caso continúa hacia el handler protegido ────────────────────
describe("(8) ningún camino hace passthrough hacia contenido protegido", () => {
  const scenarios: Array<[string, () => void]> = [
    ["config ausente", () => (mockProxy.throw = new SupabaseConfigError("x"))],
    ["error inesperado", () => (mockProxy.throw = new Error("x"))],
    ["sin sesión", () => (mockProxy.value = { response: NextResponse.next(), isAuthenticated: false })],
  ];

  for (const [label, setup] of scenarios) {
    it(`${label}: status de denegación (>=300) para toda ruta protegida`, async () => {
      setup();
      for (const p of [...PROTECTED_PAGES, ...PROTECTED_APIS]) {
        const res = await proxy(req(p));
        expect(res.status, `${label} ${p}`).toBeGreaterThanOrEqual(300);
        expect(res.status === 200, `${label} ${p} passthrough`).toBe(false);
      }
    });
  }

  it("solo con isAuthenticated=true se devuelve el passthrough", async () => {
    const passthrough = NextResponse.next();
    mockProxy.value = { response: passthrough, isAuthenticated: true };
    expect(await proxy(req("/clients"))).toBe(passthrough);
  });
});
