/**
 * Regresión: la barra lateral autenticada NO debe aparecer en las páginas
 * públicas de auth (antes vivía en el layout raíz y se veía en /login, también
 * tras el logout). Se resuelve la cadena de layouts que Next aplica a cada
 * página (layout.tsx desde app/ hasta la carpeta de la página, route groups
 * incluidos) y se renderiza de verdad con react-dom/server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest, NextResponse } from "next/server";

const mockClaims: { value: { sub: string; email: string | null } | null } = { value: null };
vi.mock("@/lib/auth/claims", () => ({
  getAuthClaims: async () => mockClaims.value,
}));

const mockSession: { value: { response: NextResponse; isAuthenticated: boolean } | null } = {
  value: null,
};
vi.mock("@/lib/supabase/proxy-session", () => ({
  resolveProxySession: async () => mockSession.value,
}));

const signOut = vi.fn().mockResolvedValue({ error: null });
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: async () => ({ auth: { signOut } }),
}));

import { proxy } from "@/proxy";
import { POST as logoutPOST } from "@/app/logout/route";
import { isPublicPath } from "@/lib/auth/proxy-matcher";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const appDir = join(repo, "app");
const SHELL_LAYOUT = join(appDir, "(app)", "layout.tsx");
const MARKER = "contenido-de-la-pagina";

function walkPages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkPages(full));
    else if (name === "page.tsx") out.push(full);
  }
  return out;
}

/** URL que Next asigna a un page.tsx (los route groups `(x)` no cuentan). */
function routeOf(pageFile: string): string {
  const segs = relative(appDir, pageFile).split(sep).slice(0, -1);
  return "/" + segs.filter((s) => !/^\(.+\)$/.test(s)).join("/");
}

/** Layouts que envuelven la página, de afuera hacia adentro. */
function layoutChain(pageFile: string): string[] {
  const segs = relative(appDir, pageFile).split(sep).slice(0, -1);
  const chain: string[] = [];
  let dir = appDir;
  for (const s of ["", ...segs]) {
    dir = s ? join(dir, s) : dir;
    const l = join(dir, "layout.tsx");
    if (existsSync(l)) chain.push(l);
  }
  return chain;
}

type Layout = (p: { children: ReactNode }) => ReactNode | Promise<ReactNode>;

async function renderWithLayouts(chain: string[]): Promise<string> {
  let node: ReactNode = createElement("p", null, MARKER);
  for (const file of [...chain].reverse()) {
    const mod = (await import(file)) as { default: Layout };
    node = await mod.default({ children: node });
  }
  return renderToStaticMarkup(node as React.ReactElement);
}

const pages = walkPages(appDir);
const byRoute = new Map(pages.map((p) => [routeOf(p), p]));
const AUTH_PAGES = ["/login", "/reset-password", "/update-password", "/auth/confirm-recovery"];
const protectedPages = pages.filter((p) => !isPublicPath(routeOf(p)));

beforeEach(() => {
  mockClaims.value = null;
  mockSession.value = null;
});

describe("layout — páginas públicas de auth sin barra lateral", () => {
  it.each(AUTH_PAGES)("%s existe y solo hereda el layout raíz", (route) => {
    const page = byRoute.get(route);
    expect(page, route).toBeDefined();
    expect(layoutChain(page!)).toEqual([join(appDir, "layout.tsx")]);
  });

  it.each(AUTH_PAGES)("%s renderiza sin <aside> ni navegación autenticada (aun con sesión)", async (route) => {
    mockClaims.value = { sub: "sub-test", email: "persona@example.test" };
    const html = await renderWithLayouts(layoutChain(byRoute.get(route)!));
    expect(html).toContain(MARKER);
    expect(html).not.toContain("<aside");
    expect(html).not.toContain("Cerrar sesión");
    expect(html).not.toContain('href="/clients"');
    expect(html).not.toContain("persona@example.test");
  });

  it("el layout raíz no lee la sesión ni dibuja el shell", async () => {
    const html = await renderWithLayouts([join(appDir, "layout.tsx")]);
    expect(html).toBe(`<html lang="es"><head></head><body><p>${MARKER}</p></body></html>`);
    expect(html).not.toContain("<aside");
  });
});

describe("layout — páginas autenticadas con barra lateral", () => {
  it("hay páginas protegidas y TODAS están bajo el shell (app)", () => {
    expect(protectedPages.map(routeOf)).toEqual(
      expect.arrayContaining(["/", "/clients", "/clients/new", "/settings"]),
    );
    for (const p of protectedPages) expect(layoutChain(p), routeOf(p)).toContain(SHELL_LAYOUT);
  });

  it("ninguna página pública queda dentro del shell (app)", () => {
    for (const p of pages.filter((p) => isPublicPath(routeOf(p)))) {
      expect(layoutChain(p), routeOf(p)).not.toContain(SHELL_LAYOUT);
    }
  });

  it("con sesión, /clients muestra barra lateral, navegación y logout por POST nativo", async () => {
    mockClaims.value = { sub: "sub-test", email: "persona@example.test" };
    const html = await renderWithLayouts(layoutChain(byRoute.get("/clients")!));
    expect(html).toContain("<aside");
    expect(html).toContain('href="/clients"');
    expect(html).toContain(MARKER);
    // Formulario HTML nativo: el logout es una navegación de documento completa,
    // no una transición del router cliente que conserve el shell montado.
    expect(html).toContain('<form action="/logout" method="post">');
  });
});

describe("logout — el shell autenticado desaparece", () => {
  it("POST /logout redirige (303) a /login, que se renderiza sin shell", async () => {
    const res = await logoutPOST(
      new NextRequest("http://localhost:3000/logout", { method: "POST", headers: { host: "localhost:3000" } }),
    );
    expect(signOut).toHaveBeenCalled();
    expect(res.status).toBe(303);
    const target = new URL(res.headers.get("location")!);
    expect(target.pathname).toBe("/login");

    // Tras el signOut ya no hay claims; /login igual no tiene shell.
    mockClaims.value = null;
    const html = await renderWithLayouts(layoutChain(byRoute.get(target.pathname)!));
    expect(html).not.toContain("<aside");
    expect(html).not.toContain("Cerrar sesión");
  });
});

describe("acceso anónimo — el contenido protegido nunca se entrega", () => {
  const sample = (route: string) => route.replace(/\[[^\]]+\]/g, "x1");

  it.each(protectedPages.map((p) => sample(routeOf(p))))(
    "%s sin sesión: 303 a /login con next seguro, sin passthrough",
    async (route) => {
      const passthrough = NextResponse.next();
      mockSession.value = { response: passthrough, isAuthenticated: false };
      const res = await proxy(new NextRequest(`http://localhost:3000${route}`));
      expect(res).not.toBe(passthrough);
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin).toBe("http://localhost:3000");
      expect(loc.pathname).toBe("/login");
      if (route === "/") expect(loc.searchParams.has("next")).toBe(false);
      else expect(loc.searchParams.get("next")).toBe(route);
    },
  );

  it("/clients sin sesión conserva next=%2Fclients", async () => {
    mockSession.value = { response: NextResponse.next(), isAuthenticated: false };
    const res = await proxy(new NextRequest("http://localhost:3000/clients"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fclients");
  });
});
