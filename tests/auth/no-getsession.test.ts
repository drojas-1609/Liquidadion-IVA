import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("regla de seguridad: nunca getSession() para decidir acceso", () => {
  it("ningún archivo de app/lib/scripts llama a .getSession(", () => {
    const roots = ["app", "lib", "scripts"].map((d) => repo + d);
    const offenders: string[] = [];
    for (const root of roots) {
      let files: string[];
      try {
        files = walk(root);
      } catch {
        continue; // el directorio puede no existir todavía
      }
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        if (/\.getSession\s*\(/.test(src)) offenders.push(f.replace(repo, ""));
      }
    }
    expect(offenders, `getSession() encontrado en: ${offenders.join(", ")}`).toEqual([]);
  });

  it("la capa de auth usa getClaims()", () => {
    const claims = readFileSync(repo + "lib/auth/claims.ts", "utf8");
    expect(claims).toMatch(/\.getClaims\s*\(/);
  });
});
