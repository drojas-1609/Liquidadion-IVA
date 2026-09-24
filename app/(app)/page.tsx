import Link from "next/link";

export default function Home() {
  return (
    <div className="container">
      <header style={{ marginBottom: "var(--spacing-xl)" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: "bold", marginBottom: "var(--spacing-sm)" }}>
          Dashboard
        </h1>
        <p style={{ color: "var(--secondary)" }}>Bienvenido al sistema de liquidación de impuestos.</p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "var(--spacing-lg)" }}>
        <div className="card">
          <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)" }}>Clientes</h3>
          <p style={{ marginBottom: "var(--spacing-lg)", color: "var(--secondary)" }}>
            Gestiona tus clientes y sus datos fiscales.
          </p>
          <Link href="/clients" className="btn btn-primary">
            Ver Clientes
          </Link>
        </div>

        <div className="card">
          <h3 style={{ fontSize: "1.25rem", marginBottom: "var(--spacing-md)" }}>Liquidaciones Recientes</h3>
          <p style={{ marginBottom: "var(--spacing-lg)", color: "var(--secondary)" }}>
            Accede a las últimas liquidaciones generadas.
          </p>
          <button className="btn btn-secondary">Ver Historial</button>
        </div>
      </div>
    </div>
  );
}
