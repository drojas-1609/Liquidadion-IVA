import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repo = fileURLToPath(new URL("../", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Checklist anti-IDOR (Tarea 3B §18.8).
 *
 * Toda ocurrencia de `prisma.<algo>` bajo `app/**` debe estar en un archivo que
 * TAMBIÉN pase por la capa central de autorización (`lib/auth/authz`). Si
 * aparece un acceso "desnudo" a Prisma en `app/**`, este test lo delata.
 */
const AUTHZ_MARKERS = [
  "withApiAuthz",
  "guardPage",
  "requireAuthenticatedProfile",
  "requireOrganizationRole",
  "requireClientAccess",
  "requirePeriodAccess",
  "resolveActiveOrganization",
];

// Archivos bajo app/** que legítimamente usan prisma sin authz. Debe quedar
// VACÍO: cualquier entrada aquí es una excepción documentada y revisada.
const ALLOWLIST: string[] = [];

const PRISMA_USE = /\bprisma\s*\.\s*[a-zA-Z$]/;

describe("anti-IDOR — todo prisma.* en app/** pasa por lib/auth/authz", () => {
  const files = walk(join(repo, "app"));

  it("hay archivos .ts/.tsx bajo app/ (sanity)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("ningún acceso a prisma en app/** sin un helper de authz en el mismo archivo", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(repo.length);
      const src = readFileSync(f, "utf8");
      if (!PRISMA_USE.test(src)) continue;
      if (ALLOWLIST.includes(rel)) continue;
      const guarded = AUTHZ_MARKERS.some((mk) => src.includes(mk));
      if (!guarded) offenders.push(rel);
    }
    expect(offenders, `prisma sin authz en: ${offenders.join(", ")}`).toEqual([]);
  });

  it("las rutas API bajo app/api/** envuelven el handler en withApiAuthz", () => {
    const apiRoutes = walk(join(repo, "app/api")).filter((f) => f.endsWith("route.ts"));
    expect(apiRoutes.length).toBeGreaterThanOrEqual(5);
    for (const f of apiRoutes) {
      const src = readFileSync(f, "utf8");
      expect(src, f.slice(repo.length)).toMatch(/withApiAuthz\s*\(/);
    }
  });

  it("las páginas SSR con prisma usan guardPage", () => {
    const pages = walk(join(repo, "app")).filter((f) => f.endsWith("page.tsx"));
    for (const f of pages) {
      const src = readFileSync(f, "utf8");
      if (!PRISMA_USE.test(src)) continue;
      expect(src, f.slice(repo.length)).toMatch(/guardPage\s*\(/);
    }
  });

  it("el ALLOWLIST está vacío (sin excepciones)", () => {
    expect(ALLOWLIST).toEqual([]);
  });
});
