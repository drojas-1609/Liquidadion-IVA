import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getTrustedOrigin } from "@/lib/auth/origin";

/**
 * Cierre de sesión. Solo POST (evita logout por navegación/prefetch o CSRF via
 * <img>). Redirige a /login usando un origen confiable, nunca el Host crudo.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const supabase = await getSupabaseServerClient();
    await supabase.auth.signOut();
  } catch {
    // Sin sesión / sin config: igual mandamos a /login.
  }
  const origin = getTrustedOrigin(request);
  return NextResponse.redirect(new URL("/login", origin), { status: 303 });
}

export function GET(): NextResponse {
  return NextResponse.json(
    { error: "Usá POST para cerrar sesión." },
    { status: 405, headers: { Allow: "POST" } },
  );
}
