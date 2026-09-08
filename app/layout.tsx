import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

import { getAuthClaims } from "@/lib/auth/claims";

export const metadata: Metadata = {
  title: "Tax Liquidator",
  description: "Professional Tax Liquidation App",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Etapa 3A: si Supabase todavía no está configurado localmente, la app
  // sigue renderizando sin sesión.
  let userLabel: string | null = null;
  try {
    const claims = await getAuthClaims();
    userLabel = claims ? claims.email ?? claims.sub : null;
  } catch {
    userLabel = null;
  }

  return (
    <html lang="es">
      <body>
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <aside
            style={{
              width: "250px",
              backgroundColor: "var(--surface)",
              borderRight: "1px solid var(--border)",
              padding: "var(--spacing-md)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ marginBottom: "var(--spacing-xl)", padding: "0 var(--spacing-sm)" }}>
              <h1 style={{ fontSize: "1.25rem", fontWeight: "bold", color: "var(--primary)" }}>
                TaxLiquidator
              </h1>
            </div>
            <nav style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-xs)" }}>
              <NavLink href="/">Dashboard</NavLink>
              <NavLink href="/clients">Clientes</NavLink>
              <NavLink href="/settings">Configuración</NavLink>
            </nav>
            {userLabel && (
              <div
                style={{
                  marginTop: "auto",
                  paddingTop: "var(--spacing-lg)",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <p
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--secondary)",
                    marginBottom: "var(--spacing-sm)",
                    wordBreak: "break-all",
                  }}
                >
                  {userLabel}
                </p>
                <form method="post" action="/logout">
                  <button type="submit" className="btn btn-secondary" style={{ width: "100%" }}>
                    Cerrar sesión
                  </button>
                </form>
              </div>
            )}
          </aside>
          <main style={{ flex: 1, padding: "var(--spacing-xl)", overflowY: "auto" }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      style={{
        display: "block",
        padding: "var(--spacing-sm) var(--spacing-md)",
        borderRadius: "var(--radius-md)",
        color: "var(--foreground)",
        textDecoration: "none",
        transition: "background-color 0.2s",
      }}
      className="nav-link"
    >
      {children}
    </Link>
  );
}
