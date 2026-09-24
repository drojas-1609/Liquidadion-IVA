"use client";

import { useActionState } from "react";

import { confirmRecoveryAction, type ConfirmRecoveryState } from "./actions";

const INITIAL: ConfirmRecoveryState = { error: null };

/**
 * El `token_hash` viaja en un input OCULTO (cuerpo del POST), no en la URL de
 * la acción. Con `Referrer-Policy: no-referrer` en la página, el navegador no
 * envía `Referer` con el query string del enlace.
 */
export function ConfirmRecoveryForm({ tokenHash, next }: { tokenHash: string; next: string }) {
  const [state, formAction, pending] = useActionState(confirmRecoveryAction, INITIAL);

  return (
    <form action={formAction} className="card" style={{ width: "100%", maxWidth: "360px" }}>
      <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-md)" }}>
        Recuperación de contraseña
      </h1>
      <p style={{ fontSize: "0.9rem", marginBottom: "var(--spacing-md)" }}>
        Confirmá que pediste cambiar tu contraseña para continuar.
      </p>

      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value="recovery" />
      <input type="hidden" name="next" value={next} />

      {state.error && (
        <p className="text-error" style={{ fontSize: "0.85rem", marginBottom: "var(--spacing-md)" }}>
          {state.error}{" "}
          <a href="/reset-password">Pedir un enlace nuevo</a>
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending} style={{ width: "100%" }}>
        {pending ? "Confirmando…" : "Confirmar recuperación de contraseña"}
      </button>
    </form>
  );
}
