import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

vi.mock("@/lib/prisma", () => ({ default: {} }));

import { lockPeriodForWrite } from "@/lib/period-lock";
import { assertTurivaIncludedUnderLock } from "@/lib/invoice-write";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { TURIVA_NOT_INCLUDED_MESSAGE } from "@/lib/invoice-model";

/**
 * Bloqueo del período antes de modificar su contenido (PR-1).
 *
 * LIMITACIÓN: sin base real ni locks reales. Se verifica la consulta emitida,
 * sus parámetros y la cantidad de bloqueos; la espera real se valida en DEV.
 */

const rawTx = (rows: unknown[]) => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("?"), values });
    return rows;
  });
  return { tx: { $queryRaw } as never, $queryRaw, calls };
};

describe("lockPeriodForWrite", () => {
  it("emite UN SELECT … FOR UPDATE parametrizado sobre Period con (id, organizationId)", async () => {
    const { tx, calls } = rawTx([{ id: "p_a" }]);
    await lockPeriodForWrite(tx, "p_a", "org_a");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/FROM "Period"/);
    expect(calls[0].sql).toMatch(/FOR UPDATE/);
    expect(calls[0].values).toEqual(["p_a", "org_a"]);
    // Parametrizado: los valores no aparecen en el texto SQL.
    expect(calls[0].sql).not.toContain("p_a");
    expect(calls[0].sql).not.toContain("org_a");
  });

  it("sin fila para (id, organización) -> NotFoundError (mismo 404 que los controles de acceso)", async () => {
    const { tx } = rawTx([]);
    await expect(lockPeriodForWrite(tx, "p_x", "org_a")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("assertTurivaIncludedUnderLock — requiere el lock previo y NO bloquea", () => {
  const txWith = (turivaIncluded: boolean | null) => {
    const { $queryRaw } = rawTx([{ id: "p_a" }]);
    const findUnique = vi.fn(async () => (turivaIncluded === null ? null : { turivaIncluded }));
    return { tx: { $queryRaw, periodVatSettings: { findUnique } } as never, $queryRaw, findUnique };
  };

  it("incluido: relee la configuración de (período, organización) sin emitir ningún bloqueo", async () => {
    const { tx, $queryRaw, findUnique } = txWith(true);
    await assertTurivaIncludedUnderLock(tx, "p_a", "org_a");
    expect($queryRaw).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({
      where: { periodId_organizationId: { periodId: "p_a", organizationId: "org_a" } },
      select: { turivaIncluded: true },
    });
  });

  it.each([[false], [null]])("sin inclusión (%s) -> 422 turivaRelationCode, sin bloqueo", async (value) => {
    const { tx, $queryRaw } = txWith(value);
    const err = await assertTurivaIncludedUnderLock(tx, "p_a", "org_a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toBe(TURIVA_NOT_INCLUDED_MESSAGE);
    expect((err as ValidationError).field).toBe("turivaRelationCode");
    expect($queryRaw).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Cobertura estructural: toda escritura del contenido del período pasa por
// lockPeriodForWrite (primera operación de su transacción), en orden único
// Period -> Invoice.
// ═════════════════════════════════════════════════════════════════════════

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

const rel = (abs: string) => relative(repo, abs).split(sep).join("/");
const read = (r: string) => readFileSync(join(repo, r), "utf8");
/** Código sin comentarios: los comentarios describen escrituras sin ejecutarlas. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Escritura directa del cliente Prisma sobre el contenido de un período, o baja del período. */
const CONTENT_WRITE_SRC =
  String.raw`\.(?:invoice|invoiceVatLine|taxRecord|periodVatSettings)\.(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(` +
  String.raw`|\.period\.(?:delete|deleteMany)\s*\(`;
const writesIn = (src: string) => [...src.matchAll(new RegExp(CONTENT_WRITE_SRC, "g"))].map((m) => m.index!);

/**
 * Inventario CERRADO de handlers productivos que escriben el contenido del
 * período. Una ruta nueva que escriba y no esté acá hace fallar la detección:
 * se agrega SÓLO tras aplicar lockPeriodForWrite y revisar el orden de locks.
 */
const WRITERS: Record<string, readonly string[]> = {
  "app/api/invoices/route.ts": ["POST"],
  "app/api/invoices/[id]/route.ts": ["PATCH", "DELETE"],
  "app/api/taxes/route.ts": ["POST"],
  "app/api/periods/[id]/vat-settings/route.ts": ["PATCH"],
  "app/api/periods/[id]/route.ts": ["DELETE"],
};

const productionFiles = [...walk(join(repo, "app")), ...walk(join(repo, "lib"))].map(rel).sort();

/** Segmento de código de cada handler exportado (`export const METHOD = …`) y el preámbulo del archivo. */
function splitHandlers(src: string): { prelude: string; handlers: Record<string, string> } {
  const marks = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = /g)].map((m) => ({ method: m[1], at: m.index! }));
  const handlers: Record<string, string> = {};
  marks.forEach((m, i) => (handlers[m.method] = src.slice(m.at, marks[i + 1]?.at ?? src.length)));
  return { prelude: src.slice(0, marks[0]?.at ?? src.length), handlers };
}

describe("cobertura estructural — detección de escrituras del contenido del período", () => {
  it("sanity: el patrón detecta escrituras y no lecturas", () => {
    for (const s of ["tx.invoice.create(", "prisma.invoiceVatLine.deleteMany(", "tx.taxRecord.update (", "tx.periodVatSettings.upsert(", "tx.period.delete("]) {
      expect(writesIn(s), s).toHaveLength(1);
    }
    for (const s of ["tx.invoice.findFirst(", "tx.taxRecord.count(", "tx.period.findFirst(", "tx.period.create("]) {
      expect(writesIn(s), s).toHaveLength(0);
    }
    expect(productionFiles.length).toBeGreaterThan(20);
  });

  it("los archivos productivos (app/**, lib/**) que escriben son EXACTAMENTE los del inventario", () => {
    const writers = productionFiles.filter((f) => writesIn(code(read(f))).length > 0);
    expect(writers).toEqual(Object.keys(WRITERS).sort());
  });

  it("en cada archivo, los handlers que escriben son EXACTAMENTE los del inventario y el preámbulo no escribe", () => {
    for (const [file, methods] of Object.entries(WRITERS)) {
      const { prelude, handlers } = splitHandlers(code(read(file)));
      const writing = Object.keys(handlers).filter((m) => writesIn(handlers[m]).length > 0).sort();
      expect(writing, file).toEqual([...methods].sort());
      expect(writesIn(prelude), `${file} (preámbulo)`).toHaveLength(0);
    }
  });

  it("ningún archivo productivo usa $executeRaw ni $queryRawUnsafe", () => {
    const offenders = productionFiles.filter((f) => /\$executeRaw|\$queryRawUnsafe/.test(code(read(f))));
    expect(offenders).toEqual([]);
  });
});

/**
 * Violaciones del orden de locks en el código de UN handler (vacío = correcto):
 *  - una sola transacción interactiva `prisma.$transaction(async (tx) => {`;
 *  - su PRIMER `await` es `lockPeriodForWrite(tx, <período>, organizationId)`;
 *  - un único lockPeriodForWrite, dentro de la transacción;
 *  - toda escritura del contenido, después del bloqueo;
 *  - lockInvoiceForUpdate / lockedRowWithLines / assertTurivaIncludedUnderLock,
 *    siempre después del bloqueo del Period (nunca Invoice -> Period).
 */
function lockOrderViolations(seg: string): string[] {
  const v: string[] = [];
  const txAt = seg.indexOf("prisma.$transaction(async (tx) => {");
  if (txAt === -1) return ["sin transacción interactiva"];
  if (seg.indexOf("prisma.$transaction(", txAt + 1) !== -1) v.push("más de una transacción");

  const body = seg.slice(txAt);
  if (!/^await lockPeriodForWrite\(tx, [\w.]+, organizationId\);/.test(body.slice(body.indexOf("await ")))) {
    v.push("el bloqueo del Period no es la primera operación de la transacción");
  }

  const locks = [...seg.matchAll(/lockPeriodForWrite\(/g)].map((m) => m.index!);
  if (locks.length !== 1) v.push(`bloqueos del Period: ${locks.length}`);
  const lockAt = locks[0] ?? Number.POSITIVE_INFINITY;
  if (lockAt < txAt) v.push("bloqueo del Period fuera de la transacción");

  const writes = writesIn(seg);
  if (writes.length === 0) v.push("sin escrituras");
  if (writes.some((w) => w < lockAt)) v.push("escritura antes del bloqueo del Period");

  for (const after of ["lockInvoiceForUpdate", "lockedRowWithLines", "assertTurivaIncludedUnderLock"]) {
    for (const m of seg.matchAll(new RegExp(`${after}\\(`, "g"))) {
      if (m.index! < lockAt) v.push(`${after} antes del bloqueo del Period`);
    }
  }
  return v;
}

describe("cobertura estructural — el verificador de orden detecta violaciones (fuentes sintéticas)", () => {
  const ok = `export const POST = withApiAuthz(async () => {
    const saved = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, periodId, organizationId);
        const row = await lockInvoiceForUpdate(tx, id, organizationId);
        await assertTurivaIncludedUnderLock(tx, periodId, organizationId);
        return tx.invoice.update({});
    });
  });`;

  it("fuente correcta -> sin violaciones", () => {
    expect(lockOrderViolations(ok)).toEqual([]);
  });

  it.each([
    [
      "Invoice -> Period",
      ok
        .replace("await lockPeriodForWrite(tx, periodId, organizationId);\n", "")
        .replace("return tx.invoice.update({});", "await lockPeriodForWrite(tx, periodId, organizationId);\n return tx.invoice.update({});"),
      /no es la primera operación|lockInvoiceForUpdate antes|assertTurivaIncludedUnderLock antes/,
    ],
    ["segundo bloqueo del Period", ok.replace("return tx.invoice", "await lockPeriodForWrite(tx, periodId, organizationId);\n return tx.invoice"), /bloqueos del Period: 2/],
    ["escritura antes del bloqueo", ok.replace("await lockPeriodForWrite", "await tx.taxRecord.create({});\n await lockPeriodForWrite"), /no es la primera|escritura antes/],
    ["escritura sin bloqueo", ok.replace("await lockPeriodForWrite(tx, periodId, organizationId);\n", ""), /bloqueos del Period: 0|no es la primera/],
    ["otra organización en el bloqueo", ok.replace("lockPeriodForWrite(tx, periodId, organizationId)", "lockPeriodForWrite(tx, periodId, access.organizationId)"), /no es la primera/],
    ["bloqueo fuera de la transacción", `await lockPeriodForWrite(tx, periodId, organizationId);\n${ok.replace("await lockPeriodForWrite(tx, periodId, organizationId);\n", "")}`, /fuera de la transacción|no es la primera/],
    ["sin transacción", "export const POST = withApiAuthz(async () => { await tx.invoice.create({}); });", /sin transacción/],
  ])("%s -> violación detectada", (_l, src, expected) => {
    const v = lockOrderViolations(src);
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(" | ")).toMatch(expected);
  });
});

describe("cobertura estructural — orden único de locks por handler", () => {
  const cases = Object.entries(WRITERS).flatMap(([file, methods]) => methods.map((m) => [file, m] as const));

  it.each(cases)("%s %s: lockPeriodForWrite es la PRIMERA operación de la transacción, único, antes de toda escritura y de todo bloqueo de Invoice", (file, method) => {
    const seg = splitHandlers(code(read(file))).handlers[method];
    expect(seg, `${file} ${method}`).toBeDefined();
    expect(lockOrderViolations(seg)).toEqual([]);
  });

  it("los helpers locales de los archivos del inventario no bloquean el Period (sólo el handler, una vez)", () => {
    for (const file of Object.keys(WRITERS)) {
      const { prelude } = splitHandlers(code(read(file)));
      const withoutImports = prelude.replace(/^import[\s\S]*?;$/gm, "");
      expect(withoutImports, file).not.toMatch(/lockPeriodFor(Write|Update)\(/);
    }
  });

  it("lockInvoiceForUpdate sólo se usa en archivos del inventario (fuera de su definición)", () => {
    const users = productionFiles.filter((f) => f !== "lib/invoice-lock.ts" && /lockInvoiceForUpdate\(/.test(code(read(f))));
    for (const f of users) expect(Object.keys(WRITERS), f).toContain(f);
  });
});

describe("cobertura estructural — helpers de bloqueo", () => {
  it("lockPeriodForUpdate no se exporta ni se importa/llama fuera de lib/period-lock.ts", () => {
    const helper = code(read("lib/period-lock.ts"));
    expect(helper).not.toMatch(/export\s+(async\s+)?function\s+lockPeriodForUpdate/);
    expect(helper).not.toMatch(/export\s*\{[^}]*lockPeriodForUpdate/);
    expect(helper).toMatch(/export async function lockPeriodForWrite\(/);
    const offenders = productionFiles.filter((f) => f !== "lib/period-lock.ts" && read(f).includes("lockPeriodForUpdate"));
    expect(offenders).toEqual([]);
  });

  it("el único SELECT … FOR UPDATE sobre Period vive en lib/period-lock.ts; FOR UPDATE sólo en period-lock e invoice-lock", () => {
    const forUpdate = productionFiles.filter((f) => /FOR UPDATE/.test(code(read(f))));
    expect(forUpdate).toEqual(["lib/invoice-lock.ts", "lib/period-lock.ts"]);
    expect(code(read("lib/invoice-lock.ts"))).not.toMatch(/FROM "Period"/);
  });

  it("assertTurivaIncludedUnderLock no bloquea: sin lockPeriod*, $queryRaw ni FOR UPDATE, y lib/invoice-write no importa period-lock", () => {
    const src = code(read("lib/invoice-write.ts"));
    const start = src.indexOf("export async function assertTurivaIncludedUnderLock(");
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport ", start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    expect(body).not.toMatch(/lockPeriodFor|\$queryRaw|FOR UPDATE/);
    expect(src).not.toMatch(/from "\.\/period-lock"|from "@\/lib\/period-lock"/);
  });
});
