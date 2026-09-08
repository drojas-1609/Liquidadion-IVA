import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { buildSafeRedirect } from "@/lib/auth/origin";

/**
 * Callback de los enlaces de correo de Supabase.
 *
 * Soporta LOS DOS formatos y usa el que llegue:
 *   - `?code=...`               -> exchangeCodeForSession (flujo PKCE).
 *   - `?token_hash=...&type=...` -> verifyOtp (flujo de token hasheado).
 *
 * Redirige SIEMPRE a un path interno (`next` saneado) sobre un origen
 * confiable; nunca a una URL provista por el cliente. La elección final del
 * formato y el ajuste de las plantillas de correo se cierran cuando haya
 * acceso a Supabase (fuera de la Etapa A).
 */
const OTP_TYPES: readonly EmailOtpType[] = [
  "email",
  "recovery",
  "invite",
  "magiclink",
  "signup",
  "email_change",
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const next = params.get("next");

  const supabase = await getSupabaseServerClient();
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
    return NextResponse.json({ error: "Parámetros de callback inválidos." }, { status: 400 });
  }

  const target = ok
    ? buildSafeRedirect(next, request)
    : buildSafeRedirect("/login?error=auth", request);

  return NextResponse.redirect(target, { status: 303 });
}
