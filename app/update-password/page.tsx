import { getAuthClaims } from "@/lib/auth/claims";

import { UpdatePasswordForm } from "./update-password-form";

/**
 * Esta ruta está EXCLUIDA del matcher de `proxy.ts` (para que el enlace de
 * recuperación pueda abrirla), así que valida la sesión acá: si el callback no
 * dejó una sesión válida, no se muestra el formulario.
 */
export default async function UpdatePasswordPage() {
  let hasSession = false;
  try {
    hasSession = (await getAuthClaims()) != null;
  } catch {
    hasSession = false;
  }

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
      {hasSession ? (
        <UpdatePasswordForm />
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
