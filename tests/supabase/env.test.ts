import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getSupabasePublicEnv,
  SupabaseConfigError,
  isSupabaseConfigError,
} from "@/lib/supabase/env";

const KEYS = [
  "NODE_ENV",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined>;

const VALID_URL = "https://ejemploref.supabase.co";
const VALID_KEY = "sb_publishable_dummy_pero_larga_1234";

beforeEach(() => {
  saved = {};
  for (const k of KEYS) saved[k] = env[k];
  for (const k of KEYS) delete env[k];
  env.NODE_ENV = "production";
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("getSupabasePublicEnv — validación fail-closed", () => {
  it("devuelve {url, anonKey} cuando todo es válido", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = VALID_URL;
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = VALID_KEY;
    expect(getSupabasePublicEnv()).toEqual({ url: VALID_URL, anonKey: VALID_KEY });
  });

  it("acepta NEXT_PUBLIC_SUPABASE_ANON_KEY como alias", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = VALID_URL;
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = VALID_KEY;
    expect(getSupabasePublicEnv().anonKey).toBe(VALID_KEY);
  });

  it("lanza SupabaseConfigError si faltan AMBAS variables (production)", () => {
    try {
      getSupabasePublicEnv();
      throw new Error("no lanzó");
    } catch (e) {
      expect(isSupabaseConfigError(e)).toBe(true);
      // en production el mensaje es genérico (no revela qué falta)
      expect((e as Error).message).toBe("Configuración de autenticación no disponible.");
    }
  });

  it("lanza si falta solo la publishable key", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = VALID_URL;
    expect(() => getSupabasePublicEnv()).toThrow(SupabaseConfigError);
  });

  it("lanza si falta solo la URL", () => {
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = VALID_KEY;
    expect(() => getSupabasePublicEnv()).toThrow(SupabaseConfigError);
  });

  it("lanza si la URL es inválida (no parseable)", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = "no-es-una-url";
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = VALID_KEY;
    expect(() => getSupabasePublicEnv()).toThrow(SupabaseConfigError);
  });

  it("lanza si la URL no es HTTPS (y no es loopback)", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = "http://ejemploref.supabase.co";
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = VALID_KEY;
    expect(() => getSupabasePublicEnv()).toThrow(SupabaseConfigError);
  });

  it("permite http SOLO en loopback", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = VALID_KEY;
    expect(getSupabasePublicEnv().url).toBe("http://127.0.0.1:54321");
  });

  it("lanza si la key es demasiado corta", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = VALID_URL;
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "corta";
    expect(() => getSupabasePublicEnv()).toThrow(SupabaseConfigError);
  });

  it("en desarrollo el mensaje puede detallar qué falta", () => {
    env.NODE_ENV = "development";
    try {
      getSupabasePublicEnv();
      throw new Error("no lanzó");
    } catch (e) {
      expect((e as Error).message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    }
  });
});
