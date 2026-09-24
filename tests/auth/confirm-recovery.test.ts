/**
 * Flujo anti-escáner de recuperación: `/auth/confirm-recovery`.
 * El GET NO consume el token; sólo el POST explícito llama a `verifyOtp`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── mocks con estado mutable ────────────────────────────────────────────────
const verifyOtp = vi.fn();
const serverClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: (...a: unknown[]) => serverClient(...a),
}));
const mockHeaders: { value: Headers } = { value: new Headers() };
vi.mock("next/headers", () => ({ headers: async () => mockHeaders.value }));

import ConfirmRecoveryPage, { metadata, dynamic } from "@/app/auth/confirm-recovery/page";
import { confirmRecoveryAction } from "@/app/auth/confirm-recovery/actions";
import { SupabaseConfigError } from "@/lib/supabase/env";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const GOOD_TH = "pkce_" + "a1b2c3d4e5f60718".repeat(3); // 64+ chars, alfabeto válido

const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = ["NODE_ENV", "CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"];
let saved: Record<string, string | undefined>;

function fd(o: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
}
function setHeaders(h: Record<string, string>) {
  mockHeaders.value = new Headers(h);
}
/** Devuelve la URL destino de un redirect() de Next a partir del error lanzado. */
async function runExpectingRedirect(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    expect(digest).toContain("NEXT_REDIRECT");
    return digest.split(";")[2] ?? "";
  }
  throw new Error("se esperaba un redirect");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Recorre el árbol de elementos React: nombres de componentes + texto plano + props del form. */
function inspect(node: any): { names: Set<string>; text: string; formProps: any } {
  const names = new Set<string>();
  let text = "";
  let formProps: any = null;
  const visit = (n: any) => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      text += String(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (typeof n === "object" && "type" in n) {
      const t = (n as any).type;
      if (typeof t === "function") {
        const name = t.name || t.displayName || "anon";
        names.add(name);
        if (name === "ConfirmRecoveryForm") formProps = (n as any).props;
      }
      visit((n as any).props?.children);
    }
  };
  visit(node);
  return { names, text, formProps };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  verifyOtp.mockReset().mockResolvedValue({ error: null });
  serverClient.mockReset().mockResolvedValue({ auth: { verifyOtp } });
  mockHeaders.value = new Headers();
  saved = {};
  for (const k of ENV_KEYS) saved[k] = env[k];
  for (const k of ["CONTEXT", "URL", "DEPLOY_PRIME_URL", "AUTH_PRODUCTION_ORIGIN"]) delete env[k];
  env.NODE_ENV = "production";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("GET /auth/confirm-recovery (página intermedia)", () => {
  it("metadata: noindex + no-referrer; ruta dinámica (no-store)", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("la página NO importa el cliente de Supabase (no puede consumir el token)", () => {
    const src = readFileSync(repo + "app/auth/confirm-recovery/page.tsx", "utf8");
    // sin import de la capa de servidor de Supabase ni llamadas de verificación
    expect(src).not.toMatch(/^\s*import[^\n]*["']@?\/?lib\/supabase\/server["']/m);
    expect(src).not.toMatch(/\.\s*verifyOtp\s*\(/);
    expect(src).not.toMatch(/\.\s*exchangeCodeForSession\s*\(/);
  });

  it("GET con token_hash y type válidos: NO llama a verifyOtp y renderiza el form", async () => {
    const node = await ConfirmRecoveryPage({
      searchParams: Promise.resolve({ token_hash: GOOD_TH, type: "recovery" }),
    });
    expect(serverClient).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
    const { names, text, formProps } = inspect(node);
    expect(names.has("ConfirmRecoveryForm")).toBe(true);
    expect(text).not.toContain("Enlace no válido");
    // el token viaja como prop (input oculto), no como texto visible
    expect(formProps?.tokenHash).toBe(GOOD_TH);
    expect(formProps?.next).toBe("/update-password");
    expect(text).not.toContain(GOOD_TH);
  });

  it("GET sin token / malformado / type != recovery: pantalla genérica 'Enlace no válido'", async () => {
    for (const sp of [
      {},
      { token_hash: "corto", type: "recovery" },
      { token_hash: GOOD_TH, type: "email" },
      { token_hash: GOOD_TH, type: "signup" },
      { token_hash: "espacios y símbolos !!", type: "recovery" },
    ]) {
      const node = await ConfirmRecoveryPage({ searchParams: Promise.resolve(sp) });
      const { names, text } = inspect(node);
      expect(text, JSON.stringify(sp)).toContain("Enlace no válido");
      expect(names.has("ConfirmRecoveryForm")).toBe(false);
    }
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("POST confirmRecoveryAction (botón explícito)", () => {
  it("un GET (nunca esta acción) no ocurre; sólo el POST llama a verifyOtp una vez", async () => {
    setHeaders({ "x-forwarded-host": "liquidadoriva.netlify.app", "x-forwarded-proto": "https" });
    await runExpectingRedirect(
      confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery" })),
    );
    expect(verifyOtp).toHaveBeenCalledTimes(1);
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: GOOD_TH, type: "recovery" });
  });

  it("POST exitoso: verifyOtp OK -> redirige a /update-password del origen validado", async () => {
    setHeaders({
      "x-forwarded-host": "deploy-preview-3--liquidadoriva.netlify.app",
      "x-forwarded-proto": "https",
    });
    const to = await runExpectingRedirect(
      confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery" })),
    );
    expect(to).toBe("https://deploy-preview-3--liquidadoriva.netlify.app/update-password");
  });

  it("funciona sin ninguna cookie PKCE previa (verifyOtp no la necesita)", async () => {
    setHeaders({ "x-forwarded-host": "liquidadoriva.netlify.app", "x-forwarded-proto": "https" });
    // no se setea ninguna cookie en el test
    const to = await runExpectingRedirect(
      confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery" })),
    );
    expect(to).toBe("https://liquidadoriva.netlify.app/update-password");
  });

  it("type != recovery -> rechazado, sin llamar a verifyOtp, error genérico", async () => {
    for (const bad of ["email", "signup", "magiclink", "", "recovery "]) {
      verifyOtp.mockClear();
      const st = await confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: bad }));
      expect(st.error).toMatch(/no es válido/i);
      expect(verifyOtp).not.toHaveBeenCalled();
    }
  });

  it("token_hash ausente o malformado -> error genérico, sin verifyOtp", async () => {
    for (const th of ["", "corto", "tiene espacios", "a".repeat(600), "x<script>"]) {
      verifyOtp.mockClear();
      const st = await confirmRecoveryAction({ error: null }, fd({ token_hash: th, type: "recovery" }));
      expect(st.error).toMatch(/no es válido/i);
      expect(verifyOtp).not.toHaveBeenCalled();
    }
  });

  it("token usado/expirado (verifyOtp devuelve error) -> mensaje genérico, sin fuga", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid", status: 403 } });
    const st = await confirmRecoveryAction(
      { error: null },
      fd({ token_hash: GOOD_TH, type: "recovery" }),
    );
    expect(st.error).toBe(
      "El enlace de recuperación no es válido, ya fue usado o expiró. Pedí uno nuevo.",
    );
    expect(st.error).not.toMatch(/token|expired|403|invalid/i);
  });

  it("config ausente -> 'servicio no disponible', sin filtrar", async () => {
    serverClient.mockRejectedValue(new SupabaseConfigError("faltan variables"));
    const st = await confirmRecoveryAction(
      { error: null },
      fd({ token_hash: GOOD_TH, type: "recovery" }),
    );
    expect(st.error).toMatch(/no está disponible/i);
  });

  it("excepción inesperada de verifyOtp -> mensaje genérico", async () => {
    verifyOtp.mockRejectedValue(new Error("network boom"));
    const st = await confirmRecoveryAction(
      { error: null },
      fd({ token_hash: GOOD_TH, type: "recovery" }),
    );
    expect(st.error).toMatch(/no es válido/i);
    expect(st.error).not.toMatch(/boom|network/i);
  });

  it("next externo/malicioso -> descartado a /update-password", async () => {
    setHeaders({ "x-forwarded-host": "liquidadoriva.netlify.app", "x-forwarded-proto": "https" });
    for (const bad of ["https://evil.com/x", "//evil.com", "/\\evil", "javascript:alert(1)"]) {
      const to = await runExpectingRedirect(
        confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery", next: bad })),
      );
      expect(to, bad).toBe("https://liquidadoriva.netlify.app/update-password");
    }
  });

  it("next interno válido se conserva", async () => {
    setHeaders({ "x-forwarded-host": "liquidadoriva.netlify.app", "x-forwarded-proto": "https" });
    const to = await runExpectingRedirect(
      confirmRecoveryAction(
        { error: null },
        fd({ token_hash: GOOD_TH, type: "recovery", next: "/update-password?x=1" }),
      ),
    );
    expect(to).toBe("https://liquidadoriva.netlify.app/update-password?x=1");
  });

  it("host/protocolo malicioso en la redirección -> fallback de producción", async () => {
    setHeaders({ "x-forwarded-host": "evil.com", "x-forwarded-proto": "https" });
    const a = await runExpectingRedirect(
      confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery" })),
    );
    expect(a).toBe("https://liquidadoriva.netlify.app/update-password");

    setHeaders({
      "x-forwarded-host": "deploy-preview-3--liquidadoriva.netlify.app",
      "x-forwarded-proto": "http",
    });
    const b = await runExpectingRedirect(
      confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery" })),
    );
    expect(b).toBe("https://liquidadoriva.netlify.app/update-password");
  });

  it("localhost en dev conserva su origen", async () => {
    env.NODE_ENV = "development";
    setHeaders({ host: "localhost:3000" });
    const to = await runExpectingRedirect(
      confirmRecoveryAction({ error: null }, fd({ token_hash: GOOD_TH, type: "recovery" })),
    );
    expect(to).toBe("http://localhost:3000/update-password");
  });

  it("el token_hash nunca aparece en el ConfirmRecoveryState devuelto", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "bad" } });
    const st = await confirmRecoveryAction(
      { error: null },
      fd({ token_hash: GOOD_TH, type: "recovery" }),
    );
    expect(JSON.stringify(st)).not.toContain(GOOD_TH);
  });
});
