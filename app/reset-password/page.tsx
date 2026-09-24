"use client";

import { useActionState } from "react";

import { requestResetAction, type ResetState } from "./actions";

const INITIAL: ResetState = { done: false };

export default function ResetPasswordPage() {
  const [state, formAction, pending] = useActionState(requestResetAction, INITIAL);

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
      <div className="card" style={{ width: "100%", maxWidth: "360px" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", marginBottom: "var(--spacing-md)" }}>
          Recuperar contraseña
        </h1>

        {state.done ? (
          <p style={{ fontSize: "0.9rem" }}>
            Si ese correo tiene una cuenta, te enviamos un enlace para restablecer la contraseña.
          </p>
        ) : (
          <form action={formAction}>
            <label style={{ display: "block", marginBottom: "var(--spacing-md)" }}>
              <span
                style={{ display: "block", fontSize: "0.8rem", marginBottom: "var(--spacing-xs)" }}
              >
                Correo
              </span>
              <input
                className="input"
                type="email"
                name="email"
                autoComplete="username"
                required
                style={{ width: "100%" }}
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending}
              style={{ width: "100%" }}
            >
              {pending ? "Enviando…" : "Enviar enlace"}
            </button>
          </form>
        )}

        <p style={{ marginTop: "var(--spacing-md)", fontSize: "0.8rem" }}>
          <a href="/login">Volver a ingresar</a>
        </p>
      </div>
    </div>
  );
}
