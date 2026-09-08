import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// Needles construidos por fragmentos para que este archivo de test no cuente
// como "referencia residual".
const NEEDLES = [
  "/api/clients/" + "seed",
  "ROBIN" + "SON S.A.",
  "30-7112" + "3456-8",
  "Cargar Cliente " + "Modelo",
  "Seed" + "Button",
];

describe("endpoint de seed eliminado (punto 5)", () => {
  it("la ruta app/api/clients/seed/route.ts no existe", () => {
    expect(existsSync(join(repo, "app/api/clients/seed/route.ts"))).toBe(false);
    expect(existsSync(join(repo, "app/api/clients/seed"))).toBe(false);
  });

  it("SeedButton no existe", () => {
    expect(existsSync(join(repo, "app/clients/SeedButton.tsx"))).toBe(false);
  });

  it("no quedan referencias al endpoint ni a ROBINSON S.A. en app/ ni lib/", () => {
    const files = [...walk(join(repo, "app")), ...walk(join(repo, "lib"))].filter((f) => /\.(ts|tsx)$/.test(f));
    const hits: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      for (const needle of NEEDLES) {
        if (s.includes(needle)) hits.push(`${f.slice(repo.length)} :: ${needle}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("estructuralmente el build no puede exponer /api/clients/seed (no hay carpeta de ruta)", () => {
    // Next crea la ruta a partir de app/api/clients/seed/route.ts; sin ese
    // archivo/carpeta, /api/clients/seed responde 404.
    const clientsApi = readdirSync(join(repo, "app/api/clients"));
    expect(clientsApi).toEqual(["route.ts"]);
  });
});
