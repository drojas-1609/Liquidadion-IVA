import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

// Utilidades server-only: importan Prisma.Decimal y/o hacen cálculo autoritativo
// y/o acceden a la base / identidad.
const SERVER_ONLY_LIBS = [
  "lib/decimal.ts",
  "lib/validation/decimal.ts",
  "lib/liquidation-calc.ts",
  "lib/api-input.ts",
  "lib/serializers.ts",
  "lib/excel.ts",
  "lib/auth/authz.ts",
  "lib/auth/audit.ts",
];

describe("límite de responsabilidades server-only (punto 3)", () => {
  it("cada utilidad autoritativa declara `import \"server-only\"`", () => {
    for (const rel of SERVER_ONLY_LIBS) {
      const src = readFileSync(join(repo, rel), "utf8");
      expect(src.startsWith('import "server-only";'), `${rel} debe empezar con import "server-only"`).toBe(true);
    }
  });

  it("ningún componente \"use client\" importa una utilidad server-only (ni directa ni transitivamente)", () => {
    const files = walk(join(repo, "app"), [".tsx", ".ts"]);
    const clientFiles = files.filter((f) => {
      const s = readFileSync(f, "utf8");
      return /^\s*["']use client["']/m.test(s.split("\n").slice(0, 3).join("\n"));
    });
    expect(clientFiles.length).toBeGreaterThan(0); // hay formularios cliente

    const forbidden = /@\/lib\/(decimal|liquidation-calc|api-input|serializers|excel)\b|@\/lib\/validation\/decimal\b/;
    for (const f of clientFiles) {
      const s = readFileSync(f, "utf8");
      expect(forbidden.test(s), `${f.slice(repo.length)} importa una utilidad server-only`).toBe(false);
    }
  });

  it("los formularios cliente NO envían vatAmount ni totalAmount", () => {
    for (const rel of [
      "app/client/[id]/period/[periodId]/sales/new/page.tsx",
      "app/client/[id]/period/[periodId]/purchases/new/page.tsx",
    ]) {
      const s = readFileSync(join(repo, rel), "utf8");
      // el body del POST no incluye esas claves (se ignoran los comentarios)
      const body = s
        .slice(s.indexOf("JSON.stringify("), s.indexOf("});", s.indexOf("JSON.stringify(")))
        .replace(/\/\/.*$/gm, "");
      expect(body).not.toMatch(/vatAmount\s*[:,]/);
      expect(body).not.toMatch(/totalAmount\s*[:,]/);
    }
  });

  it("lib/format.ts (permitido en cliente) NO importa Prisma", () => {
    const s = readFileSync(join(repo, "lib/format.ts"), "utf8");
    expect(s).not.toMatch(/@prisma\/client|server-only/);
  });
});
