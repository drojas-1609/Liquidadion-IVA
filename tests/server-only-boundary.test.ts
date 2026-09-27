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
  "lib/invoice-form-context.ts",
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

    const forbidden = /@\/lib\/(decimal|liquidation-calc|api-input|serializers|excel|invoice-form-context)\b|@\/lib\/validation\/decimal\b/;
    for (const f of clientFiles) {
      const s = readFileSync(f, "utf8");
      expect(forbidden.test(s), `${f.slice(repo.length)} importa una utilidad server-only`).toBe(false);
    }
  });

  const INVOICE_FORM = "app/(app)/client/[id]/period/[periodId]/_components/invoice-form.tsx";
  const INVOICE_FORM_CLIENT = "lib/invoice-form-client.ts";

  it("el formulario compartido de comprobantes es cliente y sus módulos de lib son puros (también transitivamente)", () => {
    expect(readFileSync(join(repo, INVOICE_FORM), "utf8").startsWith('"use client";')).toBe(true);
    // Cierre transitivo de los imports relativos/alias a lib/ desde el formulario.
    const seen = new Set<string>();
    const queue = ["lib/invoice-form-client.ts", "lib/invoice-form-options.ts"];
    while (queue.length) {
      const rel = queue.shift() as string;
      if (seen.has(rel)) continue;
      seen.add(rel);
      const s = readFileSync(join(repo, rel), "utf8");
      expect(/^import\s+["']server-only["']/m.test(s), `${rel} es server-only`).toBe(false);
      expect(/from\s+["']@prisma\/client["']/.test(s), `${rel} importa Prisma`).toBe(false);
      for (const m of s.matchAll(/from\s+["'](\.{1,2}\/[^"']+|@\/lib\/[^"']+)["']/g)) {
        const spec = m[1];
        const target = spec.startsWith("@/")
          ? spec.slice(2)
          : join(rel, "..", spec).replace(/\\/g, "/");
        queue.push(`${target}.ts`);
      }
    }
    expect(seen.has("lib/arca/document-rules.ts")).toBe(true);
    for (const rel of seen) expect(SERVER_ONLY_LIBS, rel).not.toContain(rel);
  });

  it("el formulario de comprobantes NO envía importes ni datos derivados", () => {
    // El formulario sólo envía por submitInvoice(buildInvoiceV2Body(...)): no arma JSON propio.
    const form = readFileSync(join(repo, INVOICE_FORM), "utf8");
    expect(form).not.toMatch(/JSON\.stringify\(/);
    expect(form).not.toMatch(/fetch\(/);
    expect(form).toMatch(/buildInvoiceV2Body\(/);
    expect(form).toMatch(/submitInvoice\(/);

    // Cuerpo real: el literal que devuelve buildInvoiceV2Body (sin comentarios).
    const lib = readFileSync(join(repo, INVOICE_FORM_CLIENT), "utf8");
    const fn = lib.slice(lib.indexOf("export function buildInvoiceV2Body"));
    const literal = fn.slice(fn.indexOf("body: {"), fn.indexOf("\n}\n")).replace(/\/\/.*$/gm, "");
    expect(literal.length).toBeGreaterThan(0);
    for (const key of ["vatAmount", "totalAmount", "legalClass", "mandatoryLegend", "lidSection", "source", "organizationId", "clientId", "clientCondition", "partialValidation"]) {
      expect(literal, key).not.toMatch(new RegExp(`\\b${key}\\s*[:,]`));
    }
  });

  it("lib/format.ts (permitido en cliente) NO importa Prisma", () => {
    const s = readFileSync(join(repo, "lib/format.ts"), "utf8");
    expect(s).not.toMatch(/@prisma\/client|server-only/);
  });
});
