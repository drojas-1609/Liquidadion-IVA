/**
 * Lectura y VALIDACIÓN centralizada de la configuración pública de Supabase.
 *
 * Solo variables `NEXT_PUBLIC_*` (URL + clave publicable/anon). La
 * `service_role` NUNCA se lee acá ni se expone al bundle: vive únicamente en
 * el runtime del script de bootstrap.
 *
 * Si la configuración falta o es inválida, `getSupabasePublicEnv()` LANZA
 * `SupabaseConfigError`. Los llamadores (proxy, capa de auth) lo traducen a
 * una negación controlada (503) — nunca a un acceso anónimo permisivo.
 */
export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

export function isSupabaseConfigError(value: unknown): value is SupabaseConfigError {
  return (
    value instanceof SupabaseConfigError ||
    (value instanceof Error && value.name === "SupabaseConfigError")
  );
}

const MIN_KEY_LENGTH = 20;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function getSupabasePublicEnv(): SupabasePublicEnv {
  const isDev = process.env.NODE_ENV !== "production";
  const generic = "Configuración de autenticación no disponible.";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing: string[] = [];
  if (!url || url.trim() === "") missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey || anonKey.trim() === "") missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (missing.length > 0) {
    throw new SupabaseConfigError(
      isDev ? `Faltan variables de Supabase: ${missing.join(", ")}.` : generic,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url as string);
  } catch {
    throw new SupabaseConfigError(
      isDev ? `NEXT_PUBLIC_SUPABASE_URL no es una URL válida: "${url}".` : generic,
    );
  }
  const httpsOk = parsed.protocol === "https:";
  const httpLoopbackOk = parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
  if (!httpsOk && !httpLoopbackOk) {
    throw new SupabaseConfigError(
      isDev
        ? `NEXT_PUBLIC_SUPABASE_URL debe ser HTTPS (o http solo en loopback): "${url}".`
        : generic,
    );
  }

  if ((anonKey as string).trim().length < MIN_KEY_LENGTH) {
    throw new SupabaseConfigError(
      isDev ? "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY parece inválida (demasiado corta)." : generic,
    );
  }

  return { url: url as string, anonKey: anonKey as string };
}
