import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Cobertura estructural de Usuarios del estudio (módulos y alcance de clientes).
 *
 * En app/** y en los helpers de lib/** que cargan páginas:
 *  1. Toda llamada a `requireOrganizationRole` declara `module:`, salvo que el
 *     archivo resuelva DESPUÉS el recurso con `requirePeriodAccess` (que exige
 *     IVA y alcance) o sea Configuración → Usuarios (ROLES_USER_MANAGE).
 *  2. Toda llamada a `requireClientAccess` declara `module:` (el tipo ya lo exige).
 *  3. Todo `client.findMany` (listados/búsquedas) filtra con `clientScopeWhere`,
 *     salvo la vista del propietario en lib/users/service.ts.
 *  4. Toda ruta que escribe/lee un Client por id tras `resolveActiveOrganization`
 *     verifica el alcance (`assertClientInScope`, `requireClientAccess` o
 *     `requirePeriodAccess`).
 */

const repo = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/** Texto de cada llamada `name(...)` con paréntesis balanceados. */
function calls(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

const files = [...walk(join(repo, "app")), join(repo, "lib/invoice-form-context.ts")];
const rel = (f: string) => f.slice(repo.length);

describe("Usuarios del estudio — cobertura de módulos y alcance", () => {
  it("requireOrganizationRole declara módulo (o el archivo resuelve el período / es gestión de usuarios)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const resolvesPeriod = /\brequirePeriodAccess\s*\(/.test(src);
      for (const c of calls(src, "requireOrganizationRole")) {
        if (c.includes("module:") || resolvesPeriod || c.includes("ROLES_USER_MANAGE")) continue;
        offenders.push(`${rel(f)}: ${c.replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("requireClientAccess declara módulo", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const c of calls(src, "requireClientAccess")) if (!c.includes("module:")) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it("todo listado de clientes en app/** filtra por alcance (clientScopeWhere)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const c of calls(src, "client\\.findMany")) if (!c.includes("clientScopeWhere(")) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it("rutas por id de cliente/período verifican el alcance", () => {
    const routes = [
      "app/api/clients/[id]/route.ts",
      "app/api/periods/[id]/route.ts",
      "app/api/periods/[id]/close/route.ts",
      "app/api/periods/[id]/reopen/route.ts",
      "app/api/periods/[id]/vat-settings/route.ts",
      "app/api/invoices/route.ts",
      "app/api/invoices/[id]/route.ts",
      "app/api/invoices/[id]/detail/route.ts",
      "app/api/taxes/route.ts",
      "app/api/taxes/[id]/route.ts",
      "app/api/periods/route.ts",
      "app/api/client/[id]/period/[periodId]/export/route.ts",
    ];
    for (const r of routes) {
      const src = readFileSync(join(repo, r), "utf8");
      expect(/\b(assertClientInScope|requireClientAccess|requirePeriodAccess)\s*\(/.test(src), r).toBe(true);
    }
  });

  it("la capa central relee la membresía ACTIVE y aplica alcance en requireClientAccess/requirePeriodAccess", () => {
    const src = readFileSync(join(repo, "lib/auth/authz.ts"), "utf8");
    expect(src).toMatch(/where: \{ profileId, status: "ACTIVE" \}/);
    expect(src).toMatch(/membership\.status !== "ACTIVE"/);
    expect(src.match(/await assertClientInScope\(org, /g)?.length).toBe(2);
    expect(src).toMatch(/module: "IVA"/);
  });
});
