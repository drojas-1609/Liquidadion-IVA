"use client";

import { useActionState } from "react";

import { updatePasswordAction, type UpdatePasswordState } from "./actions";

const INITIAL: UpdatePasswordState = { error: null };

export function UpdatePasswordForm() {
  const [state, formAction, pending] = useActionState(updatePasswordAction, INITIAL);

  return (
    <form action={formAction} className="card" style={{ width: "100%", maxWidth: "360px" }}>
      <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-md)" }}>
        Nueva contraseña
      </h1>

      <label style={{ display: "block", marginBottom: "var(--spacing-md)" }}>
        <span style={{ display: "block", fontSize: "0.8rem", marginBottom: "var(--spacing-xs)" }}>
          Contraseña (mínimo 12 caracteres)
        </span>
        <input
          className="input"
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={12}
          required
          style={{ width: "100%" }}
        />
      </label>

      <label style={{ display: "block", marginBottom: "var(--spacing-md)" }}>
        <span style={{ display: "block", fontSize: "0.8rem", marginBottom: "var(--spacing-xs)" }}>
          Repetir contraseña
        </span>
        <input
          className="input"
          type="password"
          name="confirm"
          autoComplete="new-password"
          minLength={12}
          required
          style={{ width: "100%" }}
        />
      </label>

      {state.error && (
        <p className="text-error" style={{ fontSize: "0.85rem", marginBottom: "var(--spacing-md)" }}>
          {state.error}
        </p>
      )}

      <button type="submit" className="btn btn-primary" disabled={pending} style={{ width: "100%" }}>
        {pending ? "Guardando…" : "Guardar contraseña"}
      </button>
    </form>
  );
}
