/**
 * Lectura centralizada de la configuración pública de Supabase.
 *
 * Solo variables `NEXT_PUBLIC_*` (URL + clave publicable/anon). La
 * `service_role` NUNCA se lee acá ni se expone al bundle: vive únicamente en
 * el runtime del script de bootstrap.
 */
export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

export function getSupabasePublicEnv(): SupabasePublicEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Configuración de Supabase incompleta: faltan NEXT_PUBLIC_SUPABASE_URL " +
        "y/o NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }
  return { url, anonKey };
}
