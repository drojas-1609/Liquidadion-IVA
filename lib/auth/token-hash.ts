/**
 * Validación de FORMA (no de valor) del `token_hash` de un enlace de correo de
 * Supabase. Se usa para decidir si mostrar el botón de confirmación y como
 * guarda previa a `verifyOtp`. Nunca se registra ni se muestra el valor.
 *
 * Los `token_hash` de GoTrue son cadenas seguras para URL (hex/base64url, a
 * veces con prefijo `pkce_`). Aceptamos ese alfabeto y un rango de largo
 * amplio; el rechazo definitivo lo hace Supabase en `verifyOtp`.
 */
const TOKEN_HASH_RE = /^[A-Za-z0-9._~-]{16,512}$/;

export function isWellFormedTokenHash(value: unknown): value is string {
  return typeof value === "string" && TOKEN_HASH_RE.test(value);
}
