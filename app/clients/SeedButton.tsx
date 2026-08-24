"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SeedButton({ text = "Cargar Demo" }: { text?: string }) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSeed() {
    setLoading(true);
    try {
      const res = await fetch("/api/clients/seed", { method: "POST" });
      if (res.ok) {
        router.refresh();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={handleSeed} disabled={loading} className="btn btn-secondary">
      {loading ? "Cargando..." : text}
    </button>
  );
}
