"use client";

import { useState } from "react";
import Link from "next/link";

export default function SettingsPage() {
  const [iibbRate, setIibbRate] = useState("3.0");
  const [saved, setSaved] = useState(false);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div className="container" style={{ maxWidth: "600px" }}>
      <div style={{ marginBottom: "var(--spacing-xl)" }}>
        <Link href="/" style={{ color: "var(--secondary)", fontSize: "0.875rem", marginBottom: "var(--spacing-xs)", display: "inline-block" }}>
          &larr; Volver al Inicio
        </Link>
        <h1 style={{ fontSize: "2rem", fontWeight: "bold" }}>Configuración</h1>
        <p style={{ color: "var(--secondary)" }}>Parámetros globales de liquidación de impuestos.</p>
      </div>

      <form onSubmit={handleSave} className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
        {saved && (
          <div style={{ padding: "var(--spacing-sm)", backgroundColor: "rgba(34, 197, 94, 0.1)", color: "var(--success)", borderRadius: "var(--radius-sm)" }}>
            Configuración guardada correctamente.
          </div>
        )}

        <div>
          <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>
            Alícuota Predeterminada IIBB (%)
          </label>
          <input
            type="number"
            step="0.1"
            className="input"
            value={iibbRate}
            onChange={(e) => setIibbRate(e.target.value)}
          />
          <small style={{ color: "var(--secondary)", marginTop: "var(--spacing-xs)", display: "block" }}>
            Esta alícuota se utilizará para el cálculo de Ingresos Brutos si no se especifica una personalizada por cliente.
          </small>
        </div>

        <div>
          <label style={{ display: "block", marginBottom: "var(--spacing-xs)", fontWeight: 500 }}>
            Moneda
          </label>
          <input type="text" className="input" value="ARS ($)" disabled />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--spacing-sm)", marginTop: "var(--spacing-md)" }}>
          <button type="submit" className="btn btn-primary">
            Guardar Configuración
          </button>
        </div>
      </form>
    </div>
  );
}
