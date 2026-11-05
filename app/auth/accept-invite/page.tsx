import type { Metadata } from "next";

import { isWellFormedTokenHash } from "@/lib/auth/token-hash";

import { AcceptInviteForm } from "./accept-invite-form";

/**
 * Activación de la cuenta invitada (Configuración → Usuarios).
 *
 * Pública (fuera del gate de proxy.ts), igual que la recuperación: el GET NO
 * llama a `verifyOtp` ni consume el token (un escáner de enlaces no la
 * activa); sólo valida la FORMA de `token_hash` / `type` y muestra el
 * formulario. El POST explícito (`acceptInviteAction`) verifica el token, deja
 * a la persona definir su contraseña y convierte la invitación en acceso.
 *
 * `type=invite`: cuenta nueva -> contraseña obligatoria.
 * `type=magiclink`: la cuenta ya existía -> conserva su contraseña.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Activar acceso",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const tokenHash = first(sp.token_hash);
  const type = first(sp.type);
  const wellFormed = (type === "invite" || type === "magiclink") && isWellFormedTokenHash(tokenHash);

  return (
    <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--spacing-xl)" }}>
      {wellFormed ? (
        <AcceptInviteForm tokenHash={tokenHash} type={type as "invite" | "magiclink"} />
      ) : (
        <div className="card" style={{ width: "100%", maxWidth: "380px" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-md)" }}>Enlace no válido</h1>
          <p style={{ fontSize: "0.9rem" }}>
            El enlace de invitación no es válido o expiró. Pedile al estudio que te reenvíe la invitación.
          </p>
        </div>
      )}
    </div>
  );
}
