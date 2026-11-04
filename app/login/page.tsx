"use client";

import Image from "next/image";
import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";

import styles from "./login.module.css";
import { loginAction, type LoginState } from "./actions";

const INITIAL: LoginState = { error: null };

function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL);
  const next = useSearchParams().get("next") ?? "/";

  return (
    <form action={formAction} className="card" style={{ width: "100%", maxWidth: "360px" }}>
      <header className={styles.brand}>
        <Image
          src="/branding/dero-company.png"
          alt=""
          width={125}
          height={100}
          className={styles.logo}
        />
        <h1>Dero Company Gestión</h1>
        <p>Gestión integral para estudios contables</p>
      </header>

      <input type="hidden" name="next" value={next} />

      <label style={{ display: "block", marginBottom: "var(--spacing-md)" }}>
        <span style={{ display: "block", fontSize: "0.8rem", marginBottom: "var(--spacing-xs)" }}>
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

      <label style={{ display: "block", marginBottom: "var(--spacing-md)" }}>
        <span style={{ display: "block", fontSize: "0.8rem", marginBottom: "var(--spacing-xs)" }}>
          Contraseña
        </span>
        <input
          className="input"
          type="password"
          name="password"
          autoComplete="current-password"
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
        {pending ? "Ingresando…" : "Ingresar"}
      </button>

      <p style={{ marginTop: "var(--spacing-md)", fontSize: "0.8rem" }}>
        <a href="/reset-password">¿Olvidaste tu contraseña?</a>
      </p>

      <div className={styles.studio}>
        <h2>Estudio Contable y Jurídico</h2>
        <p>Asesoramiento para tu empresa, desde los impuestos hasta las decisiones de todos los días.</p>
        <a href="https://www.derocompany.com.ar/" target="_blank" rel="noopener noreferrer">
          Conocé el estudio <span aria-hidden="true">↗</span><span className={styles.srOnly}>(abre en una pestaña nueva)</span>
        </a>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className={styles.login}>
      <div className={styles.cover} aria-hidden="true" />
      <div className={styles.access}>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
