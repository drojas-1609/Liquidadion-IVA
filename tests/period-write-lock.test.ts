import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

vi.mock("@/lib/prisma", () => ({ default: {} }));

import { Prisma } from "@prisma/client";
import { lockPeriodForStatusChange, lockPeriodForWrite } from "@/lib/period-lock";
import { assertTurivaIncludedUnderLock } from "@/lib/invoice-write";
import {
  AuthError,
  NotFoundError,
  PeriodBusyError,
  PeriodClosedError,
  PERIOD_BUSY_MESSAGE,
  PERIOD_CLOSED_MESSAGE,
  ValidationError,
} from "@/lib/auth/errors";
import { TURIVA_NOT_INCLUDED_MESSAGE } from "@/lib/invoice-model";
import { analyzeSource, codesOf } from "./_period-lock-structure";

/**
 * Bloqueo del período antes de modificar su contenido (PR-1).
 *
 * LIMITACIÓN: sin base real ni locks reales. Se verifica la consulta emitida,
 * sus parámetros y la cantidad de bloqueos; la espera real se valida en DEV.
 */

/** SQL normalizado (espacios colapsados); los parámetros quedan como `?`. */
const norm = (strings: TemplateStringsArray) => strings.join("?").replace(/\s+/g, " ").trim();

const READ_TIMEOUT = `SELECT current_setting('lock_timeout') AS "lockTimeout"`;
const SET_TIMEOUT = "SELECT set_config('lock_timeout', '3000ms', true)";
const RESTORE_TIMEOUT = "SELECT set_config('lock_timeout', ?, true)";

/**
 * `tx` con `$queryRaw` simulado. `current_setting` devuelve `previous`;
 * `set_config` su fila; el FOR UPDATE devuelve `rows` o lanza `lockError`.
 * `fail` hace fallar la consulta número `at` (0-based). Registra cada consulta
 * en orden.
 */
const rawTx = (
  rows: unknown[],
  opts: { previous?: unknown[]; lockError?: unknown; fail?: { at: number; error: unknown } } = {},
) => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const $queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = norm(strings);
    calls.push({ sql, values });
    if (opts.fail && calls.length - 1 === opts.fail.at) throw opts.fail.error;
    if (sql === READ_TIMEOUT) return opts.previous ?? [{ lockTimeout: "0" }];
    if (/set_config/.test(sql)) return [{ set_config: values[0] ?? "3000ms" }];
    if (opts.lockError !== undefined) throw opts.lockError;
    return rows;
  });
  return { tx: { $queryRaw } as never, $queryRaw, calls };
};

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError("detalle interno", { code, clientVersion: "6.19.3", meta });

const isForUpdate = (sql: string) => /FROM "Period"/.test(sql) && /FOR UPDATE/.test(sql);

describe("lockPeriodForWrite", () => {
  it.each([["0"], ["1500ms"]])(
    "éxito (lock_timeout previo %s): lee -> set 3000ms -> SELECT … FOR UPDATE parametrizado -> restaura EXACTAMENTE el previo; 4 consultas en orden",
    async (previous) => {
      const { tx, calls } = rawTx([{ id: "p_a", status: "OPEN" }], { previous: [{ lockTimeout: previous }] });
      await lockPeriodForWrite(tx, "p_a", "org_a");
      expect(calls).toHaveLength(4);

      // 1. valor vigente en la transacción.
      expect(calls[0]).toEqual({ sql: READ_TIMEOUT, values: [] });
      // 2. lock_timeout local a la transacción (is_local = true), sin parámetros.
      expect(calls[1]).toEqual({ sql: SET_TIMEOUT, values: [] });
      // 3. el bloqueo del Period, parametrizado.
      expect(isForUpdate(calls[2].sql)).toBe(true);
      expect(calls[2].values).toEqual(["p_a", "org_a"]);
      expect(calls[2].sql).not.toContain("p_a");
      expect(calls[2].sql).not.toContain("org_a");
      // 4. restauración: el valor previo viaja como PARÁMETRO, nunca en el texto SQL.
      expect(calls[3]).toEqual({ sql: RESTORE_TIMEOUT, values: [previous] });
      expect(calls[3].sql).not.toContain(`'${previous}'`);
      expect(calls[3].sql).not.toContain("1500ms");
    },
  );

  it.each([["0"], ["1500ms"]])(
    "sin fila para (id, organización), previo %s -> 4 consultas y restaura ANTES de lanzar NotFoundError (mismo 404 que los controles de acceso)",
    async (previous) => {
      const { tx, calls } = rawTx([], { previous: [{ lockTimeout: previous }] });
      await expect(lockPeriodForWrite(tx, "p_x", "org_a")).rejects.toBeInstanceOf(NotFoundError);
      expect(calls).toHaveLength(4);
      expect(calls[0].sql).toBe(READ_TIMEOUT);
      expect(calls[1].sql).toBe(SET_TIMEOUT);
      expect(isForUpdate(calls[2].sql)).toBe(true);
      expect(calls[3]).toEqual({ sql: RESTORE_TIMEOUT, values: [previous] });
    },
  );

  it("P2010 con 55P03 en el FOR UPDATE -> PeriodBusyError (409 PERIOD_BUSY); 3 consultas, sin restaurar en la transacción abortada", async () => {
    const lockError = prismaError("P2010", { code: "55P03", message: "canceling statement due to lock timeout" });
    const { tx, calls } = rawTx([], { lockError });
    const err = await lockPeriodForWrite(tx, "p_a", "org_a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeriodBusyError);
    expect(err).toMatchObject({ code: "PERIOD_BUSY", status: 409, message: PERIOD_BUSY_MESSAGE });
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toBe(READ_TIMEOUT);
    expect(calls[1].sql).toBe(SET_TIMEOUT);
    expect(isForUpdate(calls[2].sql)).toBe(true);
  });

  it.each([
    ["P2010 40P01 (deadlock)", prismaError("P2010", { code: "40P01", message: "deadlock detected" })],
    ["P2010 57014 (statement_timeout)", prismaError("P2010", { code: "57014", message: "canceling statement due to statement timeout" })],
    ["P2010 sin meta", prismaError("P2010")],
    ["P2028 (timeout de la transacción)", prismaError("P2028", { error: "Transaction already closed" })],
    ["P2034 (conflicto de escritura)", prismaError("P2034")],
    ["Error genérico", new Error("boom")],
    ["Error genérico que menciona 55P03", Object.assign(new Error("55P03"), { code: "55P03" })],
  ])("%s en el FOR UPDATE -> se relanza el MISMO error; 3 consultas, sin restaurar", async (_l, lockError) => {
    const { tx, calls } = rawTx([], { lockError });
    const err = await lockPeriodForWrite(tx, "p_a", "org_a").catch((e: unknown) => e);
    expect(err).toBe(lockError);
    expect(err).not.toBeInstanceOf(PeriodBusyError);
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.sql === RESTORE_TIMEOUT)).toBe(false);
  });

  it("falla la lectura de current_setting -> se relanza el MISMO error sin traducir; 1 consulta", async () => {
    const readError = prismaError("P2010", { code: "55P03" });
    const { tx, calls } = rawTx([{ id: "p_a" }], { fail: { at: 0, error: readError } });
    const err = await lockPeriodForWrite(tx, "p_a", "org_a").catch((e: unknown) => e);
    expect(err).toBe(readError);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["sin filas", []],
    ["dos filas", [{ lockTimeout: "0" }, { lockTimeout: "0" }]],
    ["string vacío", [{ lockTimeout: "" }]],
    ["null", [{ lockTimeout: null }]],
    ["número", [{ lockTimeout: 0 }]],
    ["columna ausente", [{ other: "0" }]],
  ])("current_setting inválido (%s) -> Error genérico (no AuthError); 1 consulta, sin set ni bloqueo", async (_l, previous) => {
    const { tx, calls } = rawTx([{ id: "p_a" }], { previous });
    const err = await lockPeriodForWrite(tx, "p_a", "org_a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AuthError);
    expect(calls).toHaveLength(1);
  });

  it("falla el set inicial -> se relanza el MISMO error sin traducir; 2 consultas, sin bloqueo", async () => {
    const setError = prismaError("P2010", { code: "55P03" });
    const { tx, calls } = rawTx([{ id: "p_a" }], { fail: { at: 1, error: setError } });
    const err = await lockPeriodForWrite(tx, "p_a", "org_a").catch((e: unknown) => e);
    expect(err).toBe(setError);
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => isForUpdate(c.sql))).toBe(false);
  });

  it.each([
    ["fila encontrada", [{ id: "p_a" }]],
    ["sin fila (no llega al 404)", []],
  ])("falla la restauración (%s) -> se relanza el MISMO error sin traducir; 4 consultas", async (_l, rows) => {
    const restoreError = prismaError("P2010", { code: "55P03" });
    const { tx, calls } = rawTx(rows, { fail: { at: 3, error: restoreError } });
    const err = await lockPeriodForWrite(tx, "p_a", "org_a").catch((e: unknown) => e);
    expect(err).toBe(restoreError);
    expect(calls).toHaveLength(4);
    expect(calls[3].sql).toBe(RESTORE_TIMEOUT);
  });
});

describe("lockPeriodForWrite — período cerrado (estado leído en el MISMO FOR UPDATE)", () => {
  it("el FOR UPDATE lee id y status (texto) del Period, parametrizado", async () => {
    const { tx, calls } = rawTx([{ id: "p_a", status: "OPEN" }]);
    await lockPeriodForWrite(tx, "p_a", "org_a");
    expect(calls[2].sql).toBe(`SELECT "id", "status"::text AS "status" FROM "Period" WHERE "id" = ? AND "organizationId" = ? FOR UPDATE`);
    expect(calls[2].values).toEqual(["p_a", "org_a"]);
  });

  it.each([["0"], ["1500ms"]])(
    "CLOSED (previo %s) -> PeriodClosedError (409 PERIOD_CLOSED) DESPUÉS de restaurar el lock_timeout; 4 consultas",
    async (previous) => {
      const { tx, calls } = rawTx([{ id: "p_a", status: "CLOSED" }], { previous: [{ lockTimeout: previous }] });
      const err = await lockPeriodForWrite(tx, "p_a", "org_a").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PeriodClosedError);
      expect(err).toMatchObject({ code: "PERIOD_CLOSED", status: 409, message: PERIOD_CLOSED_MESSAGE });
      expect(calls).toHaveLength(4);
      expect(calls[3]).toEqual({ sql: RESTORE_TIMEOUT, values: [previous] });
    },
  );

  it.each([
    ["estado desconocido", [{ id: "p_a", status: "ARCHIVED" }]],
    ["estado vacío", [{ id: "p_a", status: "" }]],
    ["estado ausente", [{ id: "p_a" }]],
    ["estado null", [{ id: "p_a", status: null }]],
    ["minúsculas", [{ id: "p_a", status: "open" }]],
  ])("falla cerrada: %s -> PeriodClosedError", async (_l, rows) => {
    const { tx } = rawTx(rows);
    await expect(lockPeriodForWrite(tx, "p_a", "org_a")).rejects.toBeInstanceOf(PeriodClosedError);
  });

  it("sin fila -> NotFoundError (no PeriodClosedError)", async () => {
    const { tx } = rawTx([]);
    await expect(lockPeriodForWrite(tx, "p_x", "org_a")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("lockPeriodForStatusChange — mismo bloqueo, NO rechaza el período cerrado", () => {
  it.each([["OPEN"], ["CLOSED"]] as const)("%s -> devuelve el estado; misma secuencia de 4 consultas que lockPeriodForWrite", async (status) => {
    const { tx, calls } = rawTx([{ id: "p_a", status }], { previous: [{ lockTimeout: "1500ms" }] });
    await expect(lockPeriodForStatusChange(tx, "p_a", "org_a")).resolves.toBe(status);
    expect(calls.map((c) => c.sql)).toEqual([
      READ_TIMEOUT,
      SET_TIMEOUT,
      `SELECT "id", "status"::text AS "status" FROM "Period" WHERE "id" = ? AND "organizationId" = ? FOR UPDATE`,
      RESTORE_TIMEOUT,
    ]);
    expect(calls[3].values).toEqual(["1500ms"]);
  });

  it.each([
    ["estado desconocido", [{ id: "p_a", status: "ARCHIVED" }]],
    ["estado ausente", [{ id: "p_a" }]],
  ])("%s -> Error genérico (500), nunca una transición ni un AuthError", async (_l, rows) => {
    const { tx } = rawTx(rows);
    const err = await lockPeriodForStatusChange(tx, "p_a", "org_a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AuthError);
  });

  it("sin fila -> NotFoundError; 55P03 -> PeriodBusyError", async () => {
    await expect(lockPeriodForStatusChange(rawTx([]).tx, "p_x", "org_a")).rejects.toBeInstanceOf(NotFoundError);
    const lockError = prismaError("P2010", { code: "55P03", message: "canceling statement due to lock timeout" });
    await expect(lockPeriodForStatusChange(rawTx([], { lockError }).tx, "p_a", "org_a")).rejects.toBeInstanceOf(PeriodBusyError);
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
// Cobertura estructural (AST de TypeScript, inventario cerrado): toda
// escritura del contenido del período pasa por lockPeriodForWrite (primera
// operación awaited de su transacción), en orden único Period -> Invoice; el
// único SQL crudo es el inventariado; el helper acota y restaura lock_timeout.
// Ver tests/_period-lock-structure.ts.
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

/**
 * Inventario CERRADO de handlers productivos que escriben el contenido del
 * período. Una ruta nueva que escriba y no esté acá hace fallar la detección:
 * se agrega SÓLO tras aplicar lockPeriodForWrite y revisar el orden de locks.
 */
const WRITERS: Record<string, readonly string[]> = {
  "app/api/invoices/route.ts": ["POST"],
  "app/api/invoices/[id]/route.ts": ["PATCH", "DELETE"],
  "app/api/taxes/route.ts": ["POST"],
  "app/api/taxes/[id]/route.ts": ["PATCH", "DELETE"],
  "app/api/periods/[id]/vat-settings/route.ts": ["PATCH"],
  "app/api/periods/[id]/route.ts": ["DELETE"],
  "app/api/periods/[id]/close/route.ts": ["POST"],
  "app/api/periods/[id]/reopen/route.ts": ["POST"],
};

/**
 * Handlers del inventario que son TRANSICIONES de estado del período (cerrar /
 * reabrir): bloquean con lockPeriodForStatusChange y sólo modifican Period.
 */
const TRANSITIONS: Record<string, readonly string[]> = {
  "app/api/periods/[id]/close/route.ts": ["POST"],
  "app/api/periods/[id]/reopen/route.ts": ["POST"],
};

const productionFiles = [...walk(join(repo, "app")), ...walk(join(repo, "lib"))].map(rel).sort();

/** Reemplazo que exige encontrar el texto (una fuente sintética nunca queda igual por error). */
function mutate(src: string, from: string, to: string): string {
  expect(src.includes(from), `fuente sintética: no se encontró ${JSON.stringify(from)}`).toBe(true);
  return src.replace(from, to);
}

const codes = (file: string, src: string, methods?: readonly string[], transitions?: readonly string[]) =>
  codesOf(analyzeSource(file, src, methods, transitions));
const details = (file: string, src: string, methods?: readonly string[]) => analyzeSource(file, src, methods).map((v) => v.detail).join(" | ");

describe("cobertura estructural — producción", () => {
  it("el inventario es exacto: 10 handlers en 8 archivos (8 writers del contenido + 2 transiciones de estado)", () => {
    expect(Object.keys(WRITERS)).toHaveLength(8);
    expect(Object.values(WRITERS).flat()).toHaveLength(10);
    expect(Object.values(TRANSITIONS).flat()).toHaveLength(2);
    for (const [f, ms] of Object.entries(TRANSITIONS)) for (const m of ms) expect(WRITERS[f], f).toContain(m);
    expect(productionFiles.length).toBeGreaterThan(20);
  });

  it("ningún archivo productivo (app/**, lib/**) tiene violaciones", () => {
    const all = productionFiles.flatMap((f) => analyzeSource(f, read(f), WRITERS[f], TRANSITIONS[f]));
    expect(all).toEqual([]);
  });

  it("lockPeriodForStatusChange sólo se usa en los handlers de transición; PeriodClosedError sólo en lib/period-lock.ts", () => {
    const statusUsers = productionFiles.filter((f) => f !== "lib/period-lock.ts" && /lockPeriodForStatusChange\(/.test(code(read(f))));
    expect(statusUsers).toEqual(Object.keys(TRANSITIONS).sort());
    const closedUsers = productionFiles.filter((f) => /new PeriodClosedError\(/.test(code(read(f))));
    expect(closedUsers).toEqual(["lib/period-lock.ts"]);
  });

  it("lib/prisma.ts construye un único PrismaClient y lib/period-lock.ts / lib/invoice-lock.ts / lib/tax-record-lock.ts tienen el SQL inventariado", () => {
    expect(read("lib/prisma.ts").match(/new PrismaClient\(/g)).toHaveLength(1);
    expect(productionFiles.filter((f) => /new PrismaClient\(/.test(code(read(f))))).toEqual(["lib/prisma.ts"]);
    expect(code(read("lib/period-lock.ts")).match(/\.\$queryRaw/g)).toHaveLength(4);
    expect(code(read("lib/invoice-lock.ts")).match(/\.\$queryRaw/g)).toHaveLength(1);
    expect(code(read("lib/tax-record-lock.ts")).match(/\.\$queryRaw/g)).toHaveLength(1);
  });
});

// ── Fuentes sintéticas: transición de estado (cerrar / reabrir) ──────────

const TRANSITION_OK = `export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { organizationId } = await resolveActiveOrganization(profileId);
    const result = await prisma.$transaction(async (tx) => {
        const status = await lockPeriodForStatusChange(tx, id, organizationId);
        const period = await tx.period.findFirst({ where: { id, organizationId } });
        if (status === "CLOSED") return period;
        const updated = await tx.period.update({ where: { id_organizationId: { id, organizationId } }, data: { status: "CLOSED", closedById: profileId } });
        await recordAudit(tx, {});
        return updated;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json(result);
});`;
const STATUS_LOCK_LINE = "const status = await lockPeriodForStatusChange(tx, id, organizationId);";
const PERIOD_UPDATE_LINE = 'const updated = await tx.period.update({ where: { id_organizationId: { id, organizationId } }, data: { status: "CLOSED", closedById: profileId } });';
const transitionCodes = (src: string) => codes("app/api/synthetic/route.ts", src, ["POST"], ["POST"]);

describe("cobertura estructural — fuentes sintéticas: transición de estado", () => {
  it("fuente correcta -> sin violaciones", () => {
    expect(transitionCodes(TRANSITION_OK)).toEqual([]);
  });

  it("la misma fuente inventariada como writer del contenido -> LOCK_KIND, PERIOD_UPDATE_OUTSIDE_TRANSITION y STATUS_LOCK_OUTSIDE_TRANSITION", () => {
    expect(codes("app/api/synthetic/route.ts", TRANSITION_OK, ["POST"])).toEqual([
      "LOCK_KIND",
      "PERIOD_UPDATE_OUTSIDE_TRANSITION",
      "STATUS_LOCK_OUTSIDE_TRANSITION",
    ]);
  });

  it.each([
    ["lockPeriodForWrite en lugar de lockPeriodForStatusChange", () => mutate(TRANSITION_OK, STATUS_LOCK_LINE, "await lockPeriodForWrite(tx, id, organizationId);\n        const status = \"OPEN\";"), ["LOCK_KIND"]],
    ["sin bloqueo del Period", () => mutate(TRANSITION_OK, STATUS_LOCK_LINE, 'const status = "OPEN";'), ["BEFORE_LOCK", "LOCK_COUNT", "LOCK_NOT_FIRST"]],
    ["lectura antes del bloqueo", () => mutate(TRANSITION_OK, STATUS_LOCK_LINE, "const pre = await tx.period.count({});\n        " + STATUS_LOCK_LINE), ["BEFORE_LOCK", "LOCK_NOT_FIRST"]],
    ["dos bloqueos (status + write)", () => mutate(TRANSITION_OK, STATUS_LOCK_LINE, STATUS_LOCK_LINE + "\n        await lockPeriodForWrite(tx, id, organizationId);"), ["LOCK_COUNT", "LOCK_KIND"]],
    ["escritura del contenido en la transición", () => mutate(TRANSITION_OK, PERIOD_UPDATE_LINE, PERIOD_UPDATE_LINE + "\n        await tx.invoice.deleteMany({ where: { periodId: id } });"), ["TRANSITION_CONTENT_WRITE"]],
    ["period.delete en la transición", () => mutate(TRANSITION_OK, PERIOD_UPDATE_LINE, PERIOD_UPDATE_LINE + "\n        await tx.period.delete({ where: { id } });"), ["TRANSITION_CONTENT_WRITE"]],
    ["period.update con escritura anidada", () => mutate(TRANSITION_OK, 'data: { status: "CLOSED", closedById: profileId }', "data: { taxRecords: { deleteMany: {} } }"), ["NESTED_WRITE"]],
    ["recordAudit antes del bloqueo", () => mutate(TRANSITION_OK, STATUS_LOCK_LINE, "await recordAudit(tx, {});\n        " + STATUS_LOCK_LINE), ["BEFORE_LOCK", "LOCK_NOT_FIRST"]],
    ["opciones de la transacción distintas", () => mutate(TRANSITION_OK, "{ maxWait: 5000, timeout: 10000 }", "{ maxWait: 5000, timeout: 3000 }"), ["TX_TIMEOUT_INVALID"]],
    ["lock con otra organización", () => mutate(TRANSITION_OK, STATUS_LOCK_LINE, "const status = await lockPeriodForStatusChange(tx, id, access.organizationId);"), ["LOCK_ARGS"]],
    ["sin escrituras", () => mutate(mutate(TRANSITION_OK, PERIOD_UPDATE_LINE, "const updated = period;"), "await recordAudit(tx, {});\n", ""), ["NO_WRITES"]],
  ] as const)("%s -> exactamente las violaciones previstas", (_l, src, expected) => {
    expect(transitionCodes(src())).toEqual([...expected]);
  });
});

// ── Fuentes sintéticas: handler ──────────────────────────────────────────

const HANDLER_FILE = "app/api/synthetic/route.ts";
const HANDLER_OK = `export const POST = withApiAuthz(async (request: Request) => {
    const { organizationId } = await resolveActiveOrganization(profileId);
    const saved = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, periodId, organizationId);
        const row = await lockInvoiceForUpdate(tx, id, organizationId);
        await assertTurivaIncludedUnderLock(tx, periodId, organizationId);
        const settings = await tx.periodVatSettings.findUnique({});
        const n = await tx.invoice.count({});
        const updated = await tx.invoice.update({});
        await recordAudit(tx, {});
        return updated;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json(saved);
});`;
const TX_OPTIONS = "{ maxWait: 5000, timeout: 10000 }";
/** HANDLER_OK con otras opciones (o sin ellas) en su $transaction. */
const withTxOptions = (replacement: string) => mutate(HANDLER_OK, `}, ${TX_OPTIONS});`, replacement);
const LOCK_LINE = "await lockPeriodForWrite(tx, periodId, organizationId);\n";
const UPDATE_LINE = "const updated = await tx.invoice.update({});";
const handler = (src: string) => codes(HANDLER_FILE, src, ["POST"]);

describe("cobertura estructural — fuentes sintéticas: handler inventariado", () => {
  it("fuente correcta -> sin violaciones", () => {
    expect(handler(HANDLER_OK)).toEqual([]);
  });

  it.each([
    // #1 DML por $queryRaw (también dentro de un handler, después del lock).
    ["$queryRaw extra con UPDATE en el handler", mutate(HANDLER_OK, UPDATE_LINE, UPDATE_LINE + '\n        await tx.$queryRaw`UPDATE "Invoice" SET "number" = ${n} WHERE "id" = ${id}`;'), "RAW_NOT_INVENTORIED", /fuera de lib\/period-lock.ts/],
    // #3 period.create con escritura anidada (period.update: ver transiciones).
    ["period.create con escritura anidada", mutate(HANDLER_OK, UPDATE_LINE, UPDATE_LINE + "\n        await tx.period.create({ data: { invoices: { create: {} } } });"), "NESTED_WRITE", /anida la relación invoices/],
    // Un writer del contenido no puede modificar la fila Period (estado incluido).
    ["period.update en un writer del contenido", mutate(HANDLER_OK, UPDATE_LINE, UPDATE_LINE + "\n        await tx.period.update({ where: { id: periodId }, data: { updatedById: profileId } });"), "PERIOD_UPDATE_OUTSIDE_TRANSITION", /fuera de una transición de estado/],
    ["period.upsert en un writer del contenido", mutate(HANDLER_OK, UPDATE_LINE, UPDATE_LINE + "\n        await tx.period.upsert({ where: { id: periodId }, create: {}, update: { status: \"OPEN\" } });"), "PERIOD_UPDATE_OUTSIDE_TRANSITION", /fuera de una transición de estado/],
    ["PeriodClosedError construido en el handler", mutate(HANDLER_OK, UPDATE_LINE, "if (closed) throw new PeriodClosedError();\n        " + UPDATE_LINE), "CLOSED_OUTSIDE_HELPER", /sólo lo construye lockPeriodForWrite/],
    // #4 acceso por corchetes.
    ["acceso por corchetes", mutate(HANDLER_OK, "tx.invoice.update({})", 'tx["invoice"].update({})'), "BRACKET_MODEL", /corchetes al modelo invoice/],
    ["acceso dinámico", mutate(HANDLER_OK, UPDATE_LINE, UPDATE_LINE + "\n        await tx[model].findFirst({});"), "DYNAMIC_ACCESS", /no inventariado sobre el cliente/],
    // #5 alias de modelo.
    ["alias de modelo", mutate(HANDLER_OK, UPDATE_LINE, "const m = tx.invoice;\n        const updated = await m.update({});"), "MODEL_ALIAS", /modelo usado como valor/],
    ["alias de modelo por desestructuración", mutate(HANDLER_OK, UPDATE_LINE, "const { invoice } = tx;\n        const updated = await invoice.update({});"), "MODEL_ALIAS", /desestructurado del cliente: invoice/],
    // #6 alias del cliente transaccional.
    ["alias del cliente transaccional", mutate(HANDLER_OK, UPDATE_LINE, "const t = tx;\n        const updated = await t.invoice.update({});"), "CLIENT_ALIAS", /alias del cliente: t = tx/],
    // #8 escrituras y dependencias antes del lock (sin await: el lock sigue siendo la primera operación awaited).
    ["escritura antes del lock", mutate(HANDLER_OK, LOCK_LINE, "tx.taxRecord.create({});\n        " + LOCK_LINE), "BEFORE_LOCK", /escritura antes de lockPeriodForWrite/],
    ["recordAudit antes del lock", mutate(HANDLER_OK, LOCK_LINE, "recordAudit(tx, {});\n        " + LOCK_LINE), "BEFORE_LOCK", /recordAudit antes/],
    ["lectura TurIVA antes del lock", mutate(HANDLER_OK, LOCK_LINE, "tx.periodVatSettings.findUnique({});\n        " + LOCK_LINE), "BEFORE_LOCK", /lectura TurIVA antes/],
    ["conteo antes del lock", mutate(HANDLER_OK, LOCK_LINE, "tx.taxRecord.count({});\n        " + LOCK_LINE), "BEFORE_LOCK", /conteo antes/],
    // #17 Invoice -> Period.
    ["Invoice -> Period", mutate(HANDLER_OK, LOCK_LINE, "const pending = lockInvoiceForUpdate(tx, id, organizationId);\n        " + LOCK_LINE), "BEFORE_LOCK", /lock de Invoice antes/],
    // #16 doble lock de Period.
    ["doble lock de Period", mutate(HANDLER_OK, "return updated;", LOCK_LINE + "        return updated;"), "LOCK_COUNT", /2 bloqueos del Period/],
    ["el lock no es la primera operación awaited", mutate(HANDLER_OK, LOCK_LINE, "await tx.client.findFirst({});\n        " + LOCK_LINE), "LOCK_NOT_FIRST", /no es la primera operación awaited/],
    ["lock con otra organización", mutate(HANDLER_OK, "lockPeriodForWrite(tx, periodId, organizationId)", "lockPeriodForWrite(tx, periodId, access.organizationId)"), "LOCK_ARGS", /otros argumentos/],
    ["escritura después de la transacción", mutate(HANDLER_OK, "return NextResponse.json(saved);", "await prisma.taxRecord.create({});\n    return NextResponse.json(saved);"), "WRITE_OUTSIDE_TX", /fuera de la transacción/],
    ["sin transacción", "export const POST = withApiAuthz(async () => { await prisma.invoice.create({}); });", "HANDLER_NO_TX", /sin transacción interactiva/],
    ["dos transacciones", mutate(HANDLER_OK, "return NextResponse.json(saved);", "await prisma.$transaction(async (tx2) => { await tx2.client.findMany(); });\n    return NextResponse.json(saved);"), "HANDLER_MULTI_TX", /más de una transacción/],
    ["handler inventariado sin escrituras", mutate(mutate(HANDLER_OK, UPDATE_LINE, "const updated = await tx.invoice.findFirst({});"), "const n = await tx.invoice.count({});\n", ""), "NO_WRITES", /sin escrituras/],
  ] as const)("%s -> exactamente la violación prevista", (_l, src, expected, message) => {
    expect(handler(src)).toEqual([expected]);
    expect(details(HANDLER_FILE, src, ["POST"])).toMatch(message);
  });

  it("period.update con escritura anidada en un writer -> NESTED_WRITE y PERIOD_UPDATE_OUTSIDE_TRANSITION", () => {
    const src = mutate(HANDLER_OK, UPDATE_LINE, UPDATE_LINE + "\n        await tx.period.update({ where: { id: periodId }, data: { invoices: { create: {} } } });");
    expect(handler(src)).toEqual(["NESTED_WRITE", "PERIOD_UPDATE_OUTSIDE_TRANSITION"]);
  });

  it("lockPeriodForStatusChange en un writer del contenido -> LOCK_KIND y STATUS_LOCK_OUTSIDE_TRANSITION", () => {
    const src = mutate(HANDLER_OK, LOCK_LINE, "await lockPeriodForStatusChange(tx, periodId, organizationId);\n");
    expect(handler(src)).toEqual(["LOCK_KIND", "STATUS_LOCK_OUTSIDE_TRANSITION"]);
  });

  it.each([
    ["negativo #5: `.period` de un objeto que no es un cliente", mutate(HANDLER_OK, UPDATE_LINE, "const p = access.period;\n        const c = access.period.clientId;\n        " + UPDATE_LINE)],
    ["negativo #6: pasar tx a un helper no es un alias", mutate(HANDLER_OK, "await recordAudit(tx, {});", "await recordAudit(tx, {});\n        await assertNoDuplicateVoucher(tx, where);")],
    ["negativo #8/#17: las mismas operaciones después del lock", mutate(HANDLER_OK, UPDATE_LINE, UPDATE_LINE + "\n        tx.taxRecord.create({});\n        recordAudit(tx, {});\n        lockInvoiceForUpdate(tx, id, organizationId);")],
    ["negativo #16: un lock, y lecturas antes de la transacción", mutate(HANDLER_OK, "const saved =", "const preload = await prisma.invoice.findFirst({});\n    const saved =")],
  ])("%s -> sin violaciones", (_l, src) => {
    expect(handler(src)).toEqual([]);
  });

  it("lockPeriodForStatusChange fuera de un handler inventariado (archivo no inventariado o preámbulo) -> STATUS_LOCK_OUTSIDE_TRANSITION", () => {
    expect(codes("lib/synthetic.ts", "export async function f(tx) { await lockPeriodForStatusChange(tx, id, organizationId); }")).toEqual(["STATUS_LOCK_OUTSIDE_TRANSITION"]);
    expect(codes(HANDLER_FILE, "async function helper(tx) { return lockPeriodForStatusChange(tx, id, organizationId); }\n" + TRANSITION_OK, ["POST"], ["POST"])).toEqual(["STATUS_LOCK_OUTSIDE_TRANSITION"]);
  });

  it("inventario: escritura en el preámbulo, en un handler no inventariado o handler inventariado ausente", () => {
    expect(codes(HANDLER_FILE, "async function helper(tx) { await tx.invoice.create({}); }\n" + HANDLER_OK, ["POST"])).toEqual(["WRITE_IN_PRELUDE"]);
    expect(codes(HANDLER_FILE, HANDLER_OK + "\nexport const GET = withApiAuthz(async () => { await prisma.invoice.delete({}); });", ["POST"])).toEqual(["WRITE_IN_UNLISTED_HANDLER"]);
    expect(codes(HANDLER_FILE, HANDLER_OK, ["POST", "DELETE"])).toEqual(["HANDLER_MISSING"]);
  });
});

describe("cobertura estructural — fuentes sintéticas: opciones de la transacción del handler", () => {
  it.each([
    // Opciones ausentes o no evaluables en conjunto.
    ["sin opciones", withTxOptions("});"), "TX_OPTIONS_MISSING", /sin \{ maxWait: 5000, timeout: 10000 \}/],
    ["opciones por identificador", withTxOptions("}, txOptions);"), "TX_OPTIONS_UNEVALUABLE", /no literales: txOptions/],
    ["opciones por llamada", withTxOptions("}, periodWriteTxOptions());"), "TX_OPTIONS_UNEVALUABLE", /no literales: periodWriteTxOptions\(\)/],
    ["opciones entre paréntesis", withTxOptions(`}, (${TX_OPTIONS}));`), "TX_OPTIONS_UNEVALUABLE", /no literales/],
    ["spread ambiguo", withTxOptions("}, { ...base, maxWait: 5000, timeout: 10000 });"), "TX_OPTIONS_UNEVALUABLE", /spread en las opciones de \$transaction: \.\.\.base/],
    ["spread después de los valores", withTxOptions("}, { maxWait: 5000, timeout: 10000, ...override });"), "TX_OPTIONS_UNEVALUABLE", /spread en las opciones/],
    ["clave calculada", withTxOptions("}, { [key]: 1, maxWait: 5000, timeout: 10000 });"), "TX_OPTIONS_UNEVALUABLE", /clave no evaluable/],
    ["tercer argumento", withTxOptions(`}, ${TX_OPTIONS}, extra);`), "TX_OPTIONS_UNEVALUABLE", /argumentos no inventariados/],
    ["opción ajena", withTxOptions('}, { maxWait: 5000, timeout: 10000, isolationLevel: "Serializable" });'), "TX_OPTIONS_UNEXPECTED", /no inventariada: isolationLevel/],
    // maxWait.
    ["maxWait ausente", withTxOptions("}, { timeout: 10000 });"), "TX_MAX_WAIT_MISSING", /falta maxWait: 5000/],
    ["maxWait 2000", withTxOptions("}, { maxWait: 2000, timeout: 10000 });"), "TX_MAX_WAIT_INVALID", /maxWait 2000 \(se exige exactamente 5000\)/],
    ["maxWait 5_000 (otra escritura del valor)", withTxOptions("}, { maxWait: 5_000, timeout: 10000 });"), "TX_MAX_WAIT_INVALID", /maxWait 5_000/],
    ["maxWait 5e3", withTxOptions("}, { maxWait: 5e3, timeout: 10000 });"), "TX_MAX_WAIT_INVALID", /maxWait 5e3/],
    ["maxWait negativo", withTxOptions("}, { maxWait: -5000, timeout: 10000 });"), "TX_MAX_WAIT_INVALID", /maxWait -5000/],
    ["maxWait por identificador", withTxOptions("}, { maxWait: MAX_WAIT_MS, timeout: 10000 });"), "TX_MAX_WAIT_UNEVALUABLE", /maxWait no es un literal numérico: MAX_WAIT_MS/],
    ["maxWait por expresión", withTxOptions("}, { maxWait: 2500 * 2, timeout: 10000 });"), "TX_MAX_WAIT_UNEVALUABLE", /no es un literal numérico: 2500 \* 2/],
    ["maxWait como string", withTxOptions('}, { maxWait: "5000", timeout: 10000 });'), "TX_MAX_WAIT_UNEVALUABLE", /no es un literal numérico: "5000"/],
    ["maxWait con aserción de tipo", withTxOptions("}, { maxWait: 5000 as number, timeout: 10000 });"), "TX_MAX_WAIT_UNEVALUABLE", /no es un literal numérico: 5000 as number/],
    ["maxWait abreviado", withTxOptions("}, { maxWait, timeout: 10000 });"), "TX_MAX_WAIT_UNEVALUABLE", /maxWait no evaluable: maxWait/],
    ["maxWait repetido", withTxOptions("}, { maxWait: 5000, timeout: 10000, maxWait: 5000 });"), "TX_MAX_WAIT_DUPLICATE", /maxWait repetido/],
    // timeout.
    ["timeout ausente", withTxOptions("}, { maxWait: 5000 });"), "TX_TIMEOUT_MISSING", /falta timeout: 10000/],
    ["timeout 5000", withTxOptions("}, { maxWait: 5000, timeout: 5000 });"), "TX_TIMEOUT_INVALID", /timeout 5000 \(se exige exactamente 10000\)/],
    ["timeout 3000 (menor que lock_timeout)", withTxOptions("}, { maxWait: 5000, timeout: 3000 });"), "TX_TIMEOUT_INVALID", /timeout 3000/],
    ["timeout 10000.0", withTxOptions("}, { maxWait: 5000, timeout: 10000.0 });"), "TX_TIMEOUT_INVALID", /timeout 10000\.0/],
    ["timeout por identificador", withTxOptions("}, { maxWait: 5000, timeout: TX_TIMEOUT_MS });"), "TX_TIMEOUT_UNEVALUABLE", /timeout no es un literal numérico: TX_TIMEOUT_MS/],
    ["timeout por variable de entorno", withTxOptions("}, { maxWait: 5000, timeout: Number(process.env.TX_TIMEOUT) });"), "TX_TIMEOUT_UNEVALUABLE", /no es un literal numérico: Number/],
    ["timeout como getter", withTxOptions("}, { maxWait: 5000, get timeout() { return 10000; } });"), "TX_TIMEOUT_UNEVALUABLE", /timeout no evaluable/],
    ["timeout repetido", withTxOptions("}, { maxWait: 5000, timeout: 10000, timeout: 10000 });"), "TX_TIMEOUT_DUPLICATE", /timeout repetido/],
  ] as const)("%s -> exactamente la violación prevista", (_l, src, expected, message) => {
    expect(handler(src)).toEqual([expected]);
    expect(details(HANDLER_FILE, src, ["POST"])).toMatch(message);
  });

  it("ambos valores incorrectos -> una violación por opción, sin otras", () => {
    expect(handler(withTxOptions("}, { maxWait: 2000, timeout: 5000 });"))).toEqual(["TX_MAX_WAIT_INVALID", "TX_TIMEOUT_INVALID"]);
    expect(handler(withTxOptions("}, {});"))).toEqual(["TX_MAX_WAIT_MISSING", "TX_TIMEOUT_MISSING"]);
  });

  it.each([
    ["claves entre comillas", withTxOptions('}, { "maxWait": 5000, "timeout": 10000 });')],
    ["orden inverso", withTxOptions("}, { timeout: 10000, maxWait: 5000 });")],
    ["coma final", withTxOptions("}, { maxWait: 5000, timeout: 10000, });")],
    ["opciones en otra línea", withTxOptions("}, {\n        maxWait: 5000,\n        timeout: 10000,\n    });")],
    // La segunda transacción ya es HANDLER_MULTI_TX; sus opciones no se suman a la regla del handler.
  ])("negativo: %s -> sin violaciones", (_l, src) => {
    expect(handler(src)).toEqual([]);
  });

  it("fuera de un handler inventariado no se exigen opciones (la regla es por handler)", () => {
    expect(lib("export async function f() { await prisma.$transaction(async (tx) => { await tx.client.findMany(); }); }")).toEqual([]);
    expect(codes(HANDLER_FILE, withTxOptions("});").replace("export const POST", "export const GET"), ["GET"])).toEqual(["TX_OPTIONS_MISSING"]);
    expect(codes(HANDLER_FILE, "export const GET = withApiAuthz(async () => prisma.$transaction(async (tx) => tx.client.findMany()));")).toEqual([]);
  });

  it("los 6 handlers productivos inventariados llevan exactamente { maxWait: 5000, timeout: 10000 } en su única transacción", () => {
    for (const [file, methods] of Object.entries(WRITERS)) {
      const { handlers } = splitHandlers(code(read(file)));
      for (const m of methods) {
        expect(handlers[m], `${file} ${m}`).toBeDefined();
        expect(handlers[m].match(/\$transaction\(/g), `${file} ${m}`).toHaveLength(1);
        expect(handlers[m], `${file} ${m}`).toContain(`}, ${TX_OPTIONS})`);
      }
    }
  });

  it("ninguna transacción productiva ajena al inventario lleva esas opciones", () => {
    const outside = productionFiles
      .filter((f) => !(f in WRITERS))
      .filter((f) => code(read(f)).includes(TX_OPTIONS));
    expect(outside).toEqual([]);
  });
});

// ── Fuentes sintéticas: edición/baja de TaxRecord ─────────────────────────

const TAX_HANDLER_OK = `export const PATCH = withApiAuthz(async (request: Request) => {
    const { organizationId } = await resolveActiveOrganization(profileId);
    const saved = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, periodId, organizationId);
        const period = await tx.period.findFirst({});
        const locked = await lockTaxRecordForUpdate(tx, id, organizationId);
        const updated = await tx.taxRecord.update({});
        await recordAudit(tx, {});
        return updated;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json(saved);
});`;
const TAX_ROW_LOCK_LINE = "const locked = await lockTaxRecordForUpdate(tx, id, organizationId);\n        ";
const TAX_PERIOD_READ_LINE = "const period = await tx.period.findFirst({});\n        ";
const taxHandler = (src: string) => codes(HANDLER_FILE, src, ["PATCH"]);
const taxDetails = (src: string) => details(HANDLER_FILE, src, ["PATCH"]);

describe("cobertura estructural — fuentes sintéticas: handler de TaxRecord (Period -> TaxRecord)", () => {
  it("fuente correcta (update y deleteMany) -> sin violaciones", () => {
    expect(taxHandler(TAX_HANDLER_OK)).toEqual([]);
    expect(taxHandler(mutate(TAX_HANDLER_OK, "tx.taxRecord.update({})", "tx.taxRecord.deleteMany({})"))).toEqual([]);
  });

  it.each([
    [
      "lock de TaxRecord antes del de Period",
      mutate(mutate(TAX_HANDLER_OK, TAX_ROW_LOCK_LINE, ""), LOCK_LINE, "const pending = lockTaxRecordForUpdate(tx, id, organizationId);\n        " + LOCK_LINE),
      "BEFORE_LOCK",
      /lock de TaxRecord antes de lockPeriodForWrite/,
    ],
    ["lock de TaxRecord ausente (update)", mutate(TAX_HANDLER_OK, TAX_ROW_LOCK_LINE, ""), "TAX_RECORD_LOCK_MISSING", /tx\.taxRecord\.update sin lockTaxRecordForUpdate/],
    [
      "lock de TaxRecord ausente (deleteMany)",
      mutate(mutate(TAX_HANDLER_OK, TAX_ROW_LOCK_LINE, ""), "tx.taxRecord.update({})", "tx.taxRecord.deleteMany({})"),
      "TAX_RECORD_LOCK_MISSING",
      /tx\.taxRecord\.deleteMany sin lockTaxRecordForUpdate/,
    ],
    [
      "escritura de TaxRecord antes de su lock",
      mutate(TAX_HANDLER_OK, TAX_ROW_LOCK_LINE, "await tx.taxRecord.deleteMany({});\n        " + TAX_ROW_LOCK_LINE),
      "TAX_RECORD_WRITE_BEFORE_LOCK",
      /tx\.taxRecord\.deleteMany antes de lockTaxRecordForUpdate/,
    ],
    [
      "AuditLog antes del lock de TaxRecord",
      mutate(TAX_HANDLER_OK, TAX_ROW_LOCK_LINE, "await recordAudit(tx, {});\n        " + TAX_ROW_LOCK_LINE),
      "TAX_RECORD_WRITE_BEFORE_LOCK",
      /recordAudit antes de lockTaxRecordForUpdate/,
    ],
    ["timeout incorrecto en el handler de TaxRecord", mutate(TAX_HANDLER_OK, "timeout: 10000", "timeout: 5000"), "TX_TIMEOUT_INVALID", /timeout 5000/],
    ["maxWait ausente en el handler de TaxRecord", mutate(TAX_HANDLER_OK, "maxWait: 5000, ", ""), "TX_MAX_WAIT_MISSING", /falta maxWait/],
    ["sin opciones en el handler de TaxRecord", mutate(TAX_HANDLER_OK, "}, { maxWait: 5000, timeout: 10000 });", "});"), "TX_OPTIONS_MISSING", /sin \{ maxWait/],
  ] as const)("%s -> exactamente la violación prevista", (_l, src, expected, message) => {
    expect(taxHandler(src)).toEqual([expected]);
    expect(taxDetails(src)).toMatch(message);
  });

  it.each([
    ["el alta (create) no exige lock de fila", mutate(mutate(TAX_HANDLER_OK, TAX_ROW_LOCK_LINE, ""), "tx.taxRecord.update({})", "tx.taxRecord.create({})")],
    ["lecturas de TaxRecord antes del lock de fila", mutate(TAX_HANDLER_OK, TAX_ROW_LOCK_LINE, "const n = await tx.taxRecord.findFirst({});\n        " + TAX_ROW_LOCK_LINE)],
    ["relectura del Period entre ambos locks", TAX_HANDLER_OK],
    ["sin relectura del Period", mutate(TAX_HANDLER_OK, TAX_PERIOD_READ_LINE, "")],
  ])("negativo: %s -> sin violaciones", (_l, src) => {
    expect(taxHandler(src)).toEqual([]);
  });

  it("uso del helper fuera del inventario: archivo no inventariado, preámbulo o handler no listado", () => {
    expect(codes("lib/synthetic.ts", "export async function f(tx) { await lockTaxRecordForUpdate(tx, id, organizationId); }")).toEqual(["TAX_RECORD_LOCK_OUTSIDE_INVENTORY"]);
    expect(codes(HANDLER_FILE, "async function helper(tx) { return lockTaxRecordForUpdate(tx, id, organizationId); }\n" + TAX_HANDLER_OK, ["PATCH"])).toEqual(["TAX_RECORD_LOCK_OUTSIDE_INVENTORY"]);
    expect(
      codes(HANDLER_FILE, TAX_HANDLER_OK + "\nexport const GET = withApiAuthz(async () => { await prisma.$transaction(async (tx) => { await lockTaxRecordForUpdate(tx, id, organizationId); }); });", ["PATCH"]),
    ).toEqual(["TAX_RECORD_LOCK_OUTSIDE_INVENTORY"]);
  });
});

describe("cobertura estructural — fuentes sintéticas: lib/tax-record-lock.ts", () => {
  const TAX_LOCK_FILE = "lib/tax-record-lock.ts";
  const helperSrc = read(TAX_LOCK_FILE);
  const taxLock = (src: string) => codes(TAX_LOCK_FILE, src);
  const RAW_CALL = /const rows = await tx\.\$queryRaw<LockedTaxRecordRow\[\]>`[\s\S]*?FOR UPDATE`;/;
  const replaceRaw = (to: string) => {
    expect(RAW_CALL.test(helperSrc)).toBe(true);
    return helperSrc.replace(RAW_CALL, to);
  };

  it("el helper real -> sin violaciones", () => {
    expect(taxLock(helperSrc)).toEqual([]);
  });

  it.each([
    ["SQL mutado: sin FOR UPDATE", () => mutate(helperSrc, "\n        FOR UPDATE`", "`"), "RAW_NOT_INVENTORIED", /no inventariado/],
    ["SQL mutado: otra tabla", () => mutate(helperSrc, 'FROM "TaxRecord"', 'FROM "Invoice"'), "RAW_NOT_INVENTORIED", /FROM "Invoice"/],
    ["parámetro cambiado (id)", () => mutate(helperSrc, '"id" = ${taxRecordId}', '"id" = ${id}'), "RAW_NOT_INVENTORIED", /\[id, organizationId\]/],
    ["parámetro cambiado (organización)", () => mutate(helperSrc, '"organizationId" = ${organizationId}', '"organizationId" = ${orgId}'), "RAW_NOT_INVENTORIED", /\[taxRecordId, orgId\]/],
    ["filtro sin organización", () => mutate(helperSrc, ' AND "organizationId" = ${organizationId}', ""), "RAW_NOT_INVENTORIED", /no inventariado/],
    ["columna inesperada", () => mutate(helperSrc, '"description", "updatedAt"', '"description", "createdById", "updatedAt"'), "RAW_NOT_INVENTORIED", /"createdById"/],
    ["columna faltante", () => mutate(helperSrc, '"amount", "description"', '"amount"'), "RAW_NOT_INVENTORIED", /no inventariado/],
    ["FOR UPDATE repetido", () => mutate(helperSrc, "    return rows.length", "    await tx.$queryRaw`SELECT \"id\", \"organizationId\", \"periodId\", \"type\", \"date\", \"amount\", \"description\", \"updatedAt\" FROM \"TaxRecord\" WHERE \"id\" = ${taxRecordId} AND \"organizationId\" = ${organizationId} FOR UPDATE`;\n    return rows.length"), "RAW_NOT_INVENTORIED", /repetido/],
    ["FOR UPDATE ausente", () => replaceRaw("const rows: LockedTaxRecordRow[] = [];"), "RAW_MISSING", /falta el FOR UPDATE de TaxRecord/],
    ["consulta que menciona Period", () => mutate(helperSrc, 'FROM "TaxRecord"', 'FROM "TaxRecord" JOIN "Period" ON "Period"."id" = "TaxRecord"."periodId"'), "TAX_RECORD_LOCK_PERIOD", /consulta Period/],
    ["bloqueo de Period dentro del helper", () => mutate(helperSrc, "    const rows = await", "    await lockPeriodForWrite(tx, taxRecordId, organizationId);\n    const rows = await"), "TAX_RECORD_LOCK_PERIOD", /bloquea Period: lockPeriodForWrite/],
    ["lectura de Period dentro del helper", () => mutate(helperSrc, "    const rows = await", "    await tx.period.findFirst({});\n    const rows = await"), "TAX_RECORD_LOCK_PERIOD", /usa Period: tx\.period\.findFirst/],
  ] as const)("%s -> exactamente la violación prevista", (_l, src, expected, message) => {
    expect(taxLock(src())).toEqual([expected]);
    expect(details(TAX_LOCK_FILE, src())).toMatch(message);
  });
});

// ── Fuentes sintéticas: archivos no inventariados ─────────────────────────

const LIB_FILE = "lib/synthetic.ts";
const lib = (src: string) => codes(LIB_FILE, src);

describe("cobertura estructural — fuentes sintéticas: archivos no inventariados", () => {
  it.each([
    // #1 $queryRaw extra con UPDATE.
    ["$queryRaw extra con UPDATE", 'export async function f(tx) { await tx.$queryRaw`UPDATE "Invoice" SET "number" = ${n} WHERE "id" = ${id}`; }', "RAW_NOT_INVENTORIED"],
    // #2 $queryRaw(Prisma.sql…).
    ["$queryRaw(Prisma.sql…)", "export async function f(tx) { await tx.$queryRaw(Prisma.sql`SELECT 1`); }", "RAW_FORM"],
    ["$executeRaw", "export async function f(tx) { await tx.$executeRaw`SELECT 1`; }", "RAW_BANNED"],
    ["$queryRawUnsafe", 'export async function f(tx) { await tx.$queryRawUnsafe("SELECT 1"); }', "RAW_BANNED"],
    ["period.create con escritura anidada", "export async function f(tx) { await tx.period.create({ data: { month: 1, taxRecords: { create: [] } } }); }", "NESTED_WRITE"],
    ["period.update fuera del inventario", "export async function f(tx) { await tx.period.update({ where: {}, data: { month: 2 } }); }", "WRITE_OUTSIDE_INVENTORY"],
    ["escritura por alias de cliente fuera del inventario", "export async function f(client) { await client.invoiceVatLine.deleteMany({}); }", "WRITE_OUTSIDE_INVENTORY"],
    // #7 $transaction([...]).
    ["$transaction([...])", "export async function f() { await prisma.$transaction([prisma.client.findMany()]); }", "TX_BATCH"],
    ["$transaction no interactiva", "export async function f(fn) { await prisma.$transaction(fn); }", "TX_NOT_INTERACTIVE"],
    // #15 timeout de transacción ≤ 3000.
    ["$transaction con timeout 3000", "export async function f() { await prisma.$transaction(async (tx) => { await tx.client.findMany(); }, { timeout: 3000 }); }", "TX_TIMEOUT_LOW"],
    ["$transaction con timeout no evaluable", "export async function f(ms) { await prisma.$transaction(async (tx) => { await tx.client.findMany(); }, { timeout: ms }); }", "TX_TIMEOUT_UNEVALUABLE"],
    ["PeriodBusyError fuera del helper", "export function f() { throw new PeriodBusyError(); }", "BUSY_OUTSIDE_HELPER"],
  ] as const)("%s -> exactamente la violación prevista", (_l, src, expected) => {
    expect(lib(src)).toEqual([expected]);
  });

  it.each([
    ["negativo #1: lectura por el cliente, sin raw", "export async function f(tx) { await tx.invoice.findFirst({}); }"],
    ["negativo #3: period.create sin relaciones del contenido", "export async function f(tx) { await tx.period.create({ data: { month: 1, year: 2026 } }); }"],
    ["negativo #7: transacción interactiva sólo con lecturas", "export async function f() { await prisma.$transaction(async (tx) => { await tx.client.findMany(); }); }"],
    ["negativo #15: timeout de transacción 5000", "export async function f() { await prisma.$transaction(async (tx) => { await tx.client.findMany(); }, { timeout: 5000 }); }"],
  ])("%s -> sin violaciones", (_l, src) => {
    expect(lib(src)).toEqual([]);
  });

  it("negativo #2: el FOR UPDATE de Invoice en tagged template, en lib/invoice-lock.ts", () => {
    expect(codes("lib/invoice-lock.ts", read("lib/invoice-lock.ts"))).toEqual([]);
    expect(codes("lib/invoice-lock.ts", mutate(read("lib/invoice-lock.ts"), 'FROM "Invoice"', 'FROM "Period"'))).toEqual(["RAW_MISSING", "RAW_NOT_INVENTORIED"]);
  });

  it("#15 lib/prisma.ts: transactionOptions.timeout ≤ 3000 o no evaluable", () => {
    const prismaSrc = read("lib/prisma.ts");
    const withOptions = (opts: string) => mutate(prismaSrc, "new PrismaClient()", `new PrismaClient(${opts})`);
    expect(codes("lib/prisma.ts", prismaSrc)).toEqual([]);
    expect(codes("lib/prisma.ts", withOptions("{ transactionOptions: { timeout: 8000 } }"))).toEqual([]);
    expect(codes("lib/prisma.ts", withOptions("{ transactionOptions: { timeout: 2000 } }"))).toEqual(["TX_TIMEOUT_LOW"]);
    expect(codes("lib/prisma.ts", withOptions("{ transactionOptions: { timeout: 3000 } }"))).toEqual(["TX_TIMEOUT_LOW"]);
    expect(codes("lib/prisma.ts", withOptions("{ transactionOptions: opts }"))).toEqual(["TX_TIMEOUT_UNEVALUABLE"]);
    expect(codes("lib/prisma.ts", withOptions("{ transactionOptions: { timeout: Number(process.env.TX_TIMEOUT) } }"))).toEqual(["TX_TIMEOUT_UNEVALUABLE"]);
    expect(codes("lib/prisma.ts", withOptions("options"))).toEqual(["TX_TIMEOUT_UNEVALUABLE"]);
  });
});

// ── Fuentes sintéticas: lib/period-lock.ts ────────────────────────────────

const HELPER = "lib/period-lock.ts";
const SET_LINE = "    await tx.$queryRaw`SELECT set_config('lock_timeout', '3000ms', true)`;\n";
const RESTORE_LINE = "    await tx.$queryRaw`SELECT set_config('lock_timeout', ${previousLockTimeout}, true)`;\n";
const READ_LINE = "    const previousLockTimeout = await currentLockTimeout(tx);\n";
const NOT_FOUND_LINE = "    if (rows.length !== 1) throw new NotFoundError();\n";

describe("cobertura estructural — fuentes sintéticas: lockPeriodForWrite", () => {
  const helperSrc = read(HELPER);
  const helper = (src: string) => codes(HELPER, src);

  it("el helper real -> sin violaciones", () => {
    expect(helper(helperSrc)).toEqual([]);
  });

  it.each([
    // #9 timeout ausente.
    ["timeout ausente", () => mutate(helperSrc, SET_LINE, ""), "TIMEOUT_SET_MISSING"],
    // #10 timeout distinto de 3000 ms.
    ["timeout distinto de 3000 ms", () => mutate(helperSrc, "'3000ms', true", "'5000ms', true"), "TIMEOUT_NOT_3000"],
    // #11 timeout no local.
    ["timeout no local", () => mutate(helperSrc, "'3000ms', true", "'3000ms', false"), "TIMEOUT_NOT_LOCAL"],
    // #12 restauración ausente.
    ["restauración ausente", () => mutate(helperSrc, RESTORE_LINE, ""), "RESTORE_MISSING"],
    // #13 restauración fija en 0 (literal o parámetro literal).
    ["restauración fija en '0'", () => mutate(helperSrc, "${previousLockTimeout}, true)", "'0', true)"), "RESTORE_FIXED"],
    ["restauración con parámetro literal", () => mutate(helperSrc, "${previousLockTimeout}, true)", '${"0"}, true)'), "RESTORE_FIXED"],
    ["restauración no local", () => mutate(helperSrc, "${previousLockTimeout}, true)", "${previousLockTimeout}, false)"), "RESTORE_NOT_LOCAL"],
    // #14 restauración antes del FOR UPDATE.
    ["restauración antes del FOR UPDATE", () => mutate(mutate(helperSrc, RESTORE_LINE, ""), "    let rows:", RESTORE_LINE + "    let rows:"), "RESTORE_BEFORE_LOCK"],
    ["sin leer el valor previo", () => mutate(helperSrc, READ_LINE, '    const previousLockTimeout = "0";\n'), "TIMEOUT_READ_MISSING"],
    ["lectura después del set", () => mutate(mutate(helperSrc, READ_LINE, ""), SET_LINE, SET_LINE + READ_LINE), "READ_AFTER_SET"],
    ["NotFound antes de restaurar", () => mutate(mutate(helperSrc, NOT_FOUND_LINE, ""), RESTORE_LINE, NOT_FOUND_LINE + RESTORE_LINE), "NOTFOUND_BEFORE_RESTORE"],
    ["55P03 sin traducir", () => mutate(helperSrc, "if (isLockNotAvailable(err)) throw new PeriodBusyError();", ""), "BUSY_TRANSLATION"],
    ["traducción de otro código (P2028)", () => mutate(helperSrc, 'err.code === "P2010"', 'err.code === "P2028"'), "BUSY_TRANSLATION"],
    ["traducción fuera del FOR UPDATE (set dentro del try)", () => mutate(mutate(helperSrc, SET_LINE, ""), "    try {\n", "    try {\n    " + SET_LINE), "BUSY_TRANSLATION"],
    ["$queryRaw extra en el helper", () => mutate(helperSrc, RESTORE_LINE, RESTORE_LINE + '    await tx.$queryRaw`UPDATE "Period" SET "month" = 1`;\n'), "RAW_NOT_INVENTORIED"],
    ["sin FOR UPDATE de Period", () => mutate(helperSrc, "FOR UPDATE`", "`"), "LOCK_QUERY_MISSING"],
    // Cierre del período.
    ["FOR UPDATE sin leer el estado", () => mutate(helperSrc, 'SELECT "id", "status"::text AS "status" FROM "Period"', 'SELECT "id" FROM "Period"'), "LOCK_QUERY_MISSING"],
    ["sin rechazo del período cerrado", () => mutate(helperSrc, '    if (status !== "OPEN") throw new PeriodClosedError();\n', "    void status;\n"), "CLOSED_CHECK"],
    ["rechazo del cerrado también en lockPeriodForStatusChange", () => mutate(helperSrc, "    return status;\n}\n", '    if (status === "CLOSED") throw new PeriodClosedError();\n    return status;\n}\n'), "CLOSED_CHECK"],
    ["lockPeriodForWrite sin lockPeriodForUpdate", () => mutate(helperSrc, "    const status = await lockPeriodForUpdate(tx, periodId, organizationId);\n    if (status !== \"OPEN\")", '    const status = "OPEN";\n    if (status !== "OPEN")'), "CLOSED_CHECK"],
  ] as const)("%s -> exactamente la violación prevista", (_l, src, expected) => {
    expect(helper(src())).toEqual(expected === "LOCK_QUERY_MISSING" ? ["LOCK_QUERY_MISSING", "RAW_NOT_INVENTORIED"] : [expected]);
  });
});

// ── Helpers de bloqueo (texto) ────────────────────────────────────────────

/** Segmento de código de cada handler exportado (`export const METHOD = …`) y el preámbulo del archivo. */
function splitHandlers(src: string): { prelude: string; handlers: Record<string, string> } {
  const marks = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = /g)].map((m) => ({ method: m[1], at: m.index! }));
  const handlers: Record<string, string> = {};
  marks.forEach((m, i) => (handlers[m.method] = src.slice(m.at, marks[i + 1]?.at ?? src.length)));
  return { prelude: src.slice(0, marks[0]?.at ?? src.length), handlers };
}

describe("cobertura estructural — helpers de bloqueo", () => {
  it("los helpers locales de los archivos del inventario no bloquean el Period (sólo el handler, una vez)", () => {
    for (const file of Object.keys(WRITERS)) {
      const { prelude } = splitHandlers(code(read(file)));
      const withoutImports = prelude.replace(/^import[\s\S]*?;$/gm, "");
      expect(withoutImports, file).not.toMatch(/lockPeriodFor(Write|Update|StatusChange)\(/);
    }
  });

  it("lockInvoiceForUpdate sólo se usa en archivos del inventario (fuera de su definición)", () => {
    const users = productionFiles.filter((f) => f !== "lib/invoice-lock.ts" && /lockInvoiceForUpdate\(/.test(code(read(f))));
    for (const f of users) expect(Object.keys(WRITERS), f).toContain(f);
  });

  it("lockPeriodForUpdate no se exporta ni se importa/llama fuera de lib/period-lock.ts", () => {
    const helper = code(read("lib/period-lock.ts"));
    expect(helper).not.toMatch(/export\s+(async\s+)?function\s+lockPeriodForUpdate/);
    expect(helper).not.toMatch(/export\s*\{[^}]*lockPeriodForUpdate/);
    expect(helper).toMatch(/export async function lockPeriodForWrite\(/);
    expect(helper).toMatch(/export async function lockPeriodForStatusChange\(/);
    const offenders = productionFiles.filter((f) => f !== "lib/period-lock.ts" && read(f).includes("lockPeriodForUpdate"));
    expect(offenders).toEqual([]);
  });

  it("el único SELECT … FOR UPDATE sobre Period vive en lib/period-lock.ts; FOR UPDATE sólo en period-lock, invoice-lock y tax-record-lock", () => {
    const forUpdate = productionFiles.filter((f) => /FOR UPDATE/.test(code(read(f))));
    expect(forUpdate).toEqual(["lib/invoice-lock.ts", "lib/period-lock.ts", "lib/tax-record-lock.ts"]);
    expect(code(read("lib/invoice-lock.ts"))).not.toMatch(/FROM "Period"/);
  });

  it("lib/tax-record-lock.ts: server-only, un único export público (lockTaxRecordForUpdate) y ninguna mención de Period en el código", () => {
    const src = read("lib/tax-record-lock.ts");
    expect(src.startsWith('import "server-only";')).toBe(true);
    const helper = code(src);
    expect([...helper.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1])).toEqual(["lockTaxRecordForUpdate"]);
    expect(helper).not.toMatch(/export\s+(const|let|var|default|\{)/);
    expect(helper).not.toMatch(/Period/);
    expect(helper).not.toMatch(/\$queryRawUnsafe|\$executeRaw|\$transaction/);
  });

  it("lockTaxRecordForUpdate sólo se usa en archivos del inventario (fuera de su definición)", () => {
    const users = productionFiles.filter((f) => f !== "lib/tax-record-lock.ts" && /lockTaxRecordForUpdate\(/.test(code(read(f))));
    expect(users).toEqual(["app/api/taxes/[id]/route.ts"]);
    for (const f of users) expect(Object.keys(WRITERS), f).toContain(f);
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
