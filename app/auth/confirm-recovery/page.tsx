import type { Metadata } from "next";

import { sanitizeNext } from "@/lib/auth/origin";
import { isWellFormedTokenHash } from "@/lib/auth/token-hash";

import { ConfirmRecoveryForm } from "./confirm-recovery-form";

/**
 * Página intermedia anti-escáner del flujo de recuperación.
 *
 * El GET NO llama a `verifyOtp` y NO consume el token: sólo valida la FORMA de
 * `token_hash` / `type` / `next` y muestra un botón. Sólo el POST explícito
 * (`confirmRecoveryAction`) verifica y consume el token.
 *
 * - `no-store`: la página es dinámica (Next envía `Cache-Control: private,
 *   no-cache, no-store, max-age=0, must-revalidate`).
 * - `noindex` + `no-referrer`: vía `metadata` (metaetiquetas honradas por el
 *   navegador; `no-referrer` evita filtrar el query string del enlace).
 * - Los 6 headers de seguridad los aplica `next.config.ts` (`/:path*`).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recuperación de contraseña",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function ConfirmRecoveryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const tokenHash = first(sp.token_hash);
  const type = first(sp.type);
  const next = sanitizeNext(first(sp.next) || null, "/update-password");

  const wellFormed = type === "recovery" && isWellFormedTokenHash(tokenHash);

  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--spacing-xl)",
      }}
    >
      {wellFormed ? (
        <ConfirmRecoveryForm tokenHash={tokenHash} next={next} />
      ) : (
        <div className="card" style={{ width: "100%", maxWidth: "360px" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-md)" }}>
            Enlace no válido
          </h1>
          <p style={{ fontSize: "0.9rem", marginBottom: "var(--spacing-md)" }}>
            El enlace de recuperación no es válido o expiró.
          </p>
          <a href="/reset-password" className="btn btn-primary" style={{ width: "100%" }}>
            Pedir un enlace nuevo
          </a>
        </div>
      )}
    </div>
  );
}
