"use client";

import { useActionState } from "react";

import { acceptInviteAction, type AcceptInviteState } from "./actions";

const INITIAL: AcceptInviteState = { error: null };

/** El `token_hash` viaja en un input oculto (cuerpo del POST), nunca en la URL de la acción. */
export function AcceptInviteForm({ tokenHash, type }: { tokenHash: string; type: "invite" | "magiclink" }) {
  const [state, formAction, pending] = useActionState(acceptInviteAction, INITIAL);
  const newAccount = type === "invite";

  return (
    <form action={formAction} className="card" style={{ width: "100%", maxWidth: "380px", display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
      <h1 style={{ fontSize: "1.25rem", fontWeight: "bold" }}>Activar tu acceso</h1>
      <p style={{ fontSize: "0.9rem" }}>
        {newAccount
          ? "Te invitaron a Dero Company Gestión. Definí tu contraseña para activar la cuenta."
          : "Te invitaron a Dero Company Gestión. Confirmá para sumar el acceso a tu cuenta existente."}
      </p>

      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />

      {newAccount && (
        <>
          <label>
            <span style={{ display: "block", fontWeight: 500, marginBottom: "var(--spacing-xs)" }}>Contraseña (mínimo 12 caracteres)</span>
            <input className="input" type="password" name="password" required minLength={12} autoComplete="new-password" />
          </label>
          <label>
            <span style={{ display: "block", fontWeight: 500, marginBottom: "var(--spacing-xs)" }}>Repetí la contraseña</span>
            <input className="input" type="password" name="confirm" required minLength={12} autoComplete="new-password" />
          </label>
        </>
      )}

      {state.error && (
        <p className="text-error" role="alert" style={{ fontSize: "0.85rem" }}>
          {state.error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending} style={{ width: "100%" }}>
        {pending ? "Activando…" : "Activar acceso"}
      </button>
    </form>
  );
}
