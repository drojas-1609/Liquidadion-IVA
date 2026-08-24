import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Tax Liquidator",
  description: "Professional Tax Liquidation App",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
