"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getSupabasePublicEnv } from "./env";

/**
 * Cliente de Supabase para el navegador. Solo se usa para operaciones que el
 * flujo SSR delega en el cliente (p. ej. leer cookies del token). Ninguna
 * decisión de autorización depende de este cliente.
 */
export function getSupabaseBrowserClient() {
  const { url, anonKey } = getSupabasePublicEnv();
  return createBrowserClient(url, anonKey);
}
