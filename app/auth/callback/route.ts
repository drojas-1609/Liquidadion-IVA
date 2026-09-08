import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigError } from "@/lib/supabase/env";
import { buildSafeRedirect } from "@/lib/auth/origin";
import { applySecurityHeaders } from "@/lib/security-headers";

/**
 * Callback de los enlaces de correo de Supabase.
 *
 * Soporta LOS DOS formatos y usa el que llegue:
 *   - `?code=...`               -> exchangeCodeForSession (flujo PKCE).
 *   - `?token_hash=...&type=...` -> verifyOtp (flujo de token hasheado).
 *
 * Redirige SIEMPRE a un path interno (`next` saneado) sobre el origen VALIDADO
 * del entorno donde se originó la request (`buildSafeRedirect` ->
 * `getSafeRedirectOrigin`, misma allow-list estricta que el logout). Nunca a
 * una URL provista por el cliente ni a un Host crudo.
 */
const NO_STORE = "no-store, max-age=0";

const OTP_TYPES: readonly EmailOtpType[] = [
  "email",
  "recovery",
  "invite",
  "magiclink",
  "signup",
  "email_change",
];

/** Encabezados terminales: no-store + set de seguridad (sin tocar cookies). */
function terminal(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", NO_STORE);
  applySecurityHeaders(res.headers);
  return res;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const next = params.get("next");

  let supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>;
  try {
    supabase = await getSupabaseServerClient();
  } catch (err) {
    if (isSupabaseConfigError(err)) {
      return terminal(
        NextResponse.redirect(buildSafeRedirect("/login?error=config", request), { status: 303 }),
      );
    }
    throw err;
  }

  let ok: boolean;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  } else if (tokenHash && type && (OTP_TYPES as readonly string[]).includes(type)) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    ok = !error;
  } else {
    return terminal(
      NextResponse.json({ error: "Parámetros de callback inválidos." }, { status: 400 }),
    );
  }

  const target = ok
    ? buildSafeRedirect(next, request)
    : buildSafeRedirect("/login?error=auth", request);

  return terminal(NextResponse.redirect(target, { status: 303 }));
}
