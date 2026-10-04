import { expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { Role } from "@prisma/client";
import { cuitCheckDigit } from "@/lib/cuit";

/**
 * Utilidades compartidas para los tests de rutas API de la Tarea 3B.
 *
 * NO llama a `vi.mock` (eso debe hacerse, hoisteado, en cada archivo de test).
 * Provee: tipos de fila, un "mundo" de dos organizaciones en memoria y
 * `wireDb`, que cablea un mock de PrismaClient contra ese mundo.
 *
 * Nada se persiste; todo vive en objetos JS del test.
 */

export const SUB_OWNER_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const SUB_ACCOUNTANT_A = "aaaaaaaa-0000-4000-8000-000000000002";
export const SUB_VIEWER_A = "aaaaaaaa-0000-4000-8000-000000000003";
export const SUB_ADMIN_A = "aaaaaaaa-0000-4000-8000-000000000004";
export const SUB_OWNER_B = "bbbbbbbb-0000-4000-8000-000000000001";
export const SUB_NO_PROFILE = "cccccccc-0000-4000-8000-000000000009";
export const SUB_NO_ORG = "dddddddd-0000-4000-8000-000000000009";

export const ORG_A = "org_a";
export const ORG_B = "org_b";

export function claimsFor(sub: string | null): unknown {
  if (sub === null) return null;
  return { sub, email: `${sub}@dero.test`, authRole: "authenticated", raw: {} };
}

export interface ClientRow {
  id: string;
  organizationId: string;
  name: string;
  cuit: string;
  condition: string;
  address: string | null;
  defaultIibbRate: Prisma.Decimal;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface PeriodRow {
  id: string;
  clientId: string;
  organizationId: string;
  month: number;
  year: number;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** CUIT ficticio y válido (DV módulo 11) derivado del id del fixture. */
function fixtureCuit(id: string): string {
  const mid = id.replace(/\D/g, "").padStart(8, "0").slice(-8);
  for (const prefix of ["30", "33", "20", "27"]) {
    const dv = cuitCheckDigit(prefix + mid);
    if (dv !== null) return `${prefix}-${mid}-${dv}`;
  }
  throw new Error(`sin CUIT válido para ${id}`);
}

export function clientRow(id: string, organizationId: string, over: Partial<ClientRow> = {}): ClientRow {
  return {
    id,
    organizationId,
    name: `Cliente ${id}`,
    cuit: fixtureCuit(id),
    condition: "Responsable Inscripto",
    address: null,
    defaultIibbRate: new Prisma.Decimal("3"),
    createdById: null,
    updatedById: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}
export function periodRow(
  id: string,
  clientId: string,
  organizationId: string,
  over: Partial<PeriodRow> = {},
): PeriodRow {
  return {
    id,
    clientId,
    organizationId,
    month: 5,
    year: 2026,
    createdById: null,
    updatedById: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

/** Fila completa de TaxRecord (como en la base), con `updatedAt` exacto. */
export interface TaxRecordRow {
  id: string;
  organizationId: string;
  periodId: string;
  date: Date;
  type: string;
  amount: Prisma.Decimal;
  description: string | null;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export const TAX_RECORD_UPDATED_AT = "2026-05-15T10:20:30.123Z";
/** `updatedAt` que asigna el harness a una fila editada (siempre distinto del inicial). */
export const TAX_RECORD_UPDATED_AT_AFTER = "2026-05-16T11:22:33.456Z";
export function taxRecordRow(
  id: string,
  periodId: string,
  organizationId: string,
  over: Partial<TaxRecordRow> = {},
): TaxRecordRow {
  return {
    id,
    organizationId,
    periodId,
    date: new Date("2026-05-10T00:00:00.000Z"),
    type: "RETENCION IVA",
    amount: new Prisma.Decimal("2500.00"),
    description: "Banco Galicia",
    createdById: null,
    updatedById: null,
    createdAt: new Date("2026-05-15T10:00:00.000Z"),
    updatedAt: new Date(TAX_RECORD_UPDATED_AT),
    ...over,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface World {
  memberships: Array<{ profileId: string; organizationId: string; role: Role }>;
  profiles: Set<string>;
  clients: ClientRow[];
  periods: PeriodRow[];
  invoices?: any[];
  /** Filas de InvoiceVatLine (invoiceId, organizationId, vatRateCode, …). */
  invoiceVatLines?: any[];
  taxRecords?: any[];
  /** Filas de PeriodVatSettings (periodId, organizationId, turivaIncluded, …). */
  vatSettings?: any[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Mundo por defecto: ORG_A (owner/admin/accountant/viewer) + ORG_B (owner). */
export function makeWorld(over: Partial<World> = {}): World {
  return {
    memberships: [
      { profileId: SUB_OWNER_A, organizationId: ORG_A, role: "OWNER" },
      { profileId: SUB_ACCOUNTANT_A, organizationId: ORG_A, role: "ACCOUNTANT" },
      { profileId: SUB_VIEWER_A, organizationId: ORG_A, role: "VIEWER" },
      { profileId: SUB_ADMIN_A, organizationId: ORG_A, role: "ADMIN" },
      { profileId: SUB_OWNER_B, organizationId: ORG_B, role: "OWNER" },
    ],
    profiles: new Set([SUB_OWNER_A, SUB_ACCOUNTANT_A, SUB_VIEWER_A, SUB_ADMIN_A, SUB_OWNER_B, SUB_NO_ORG]),
    clients: [clientRow("c_a", ORG_A), clientRow("c_b", ORG_B)],
    periods: [periodRow("p_a", "c_a", ORG_A), periodRow("p_b", "c_b", ORG_B)],
    ...over,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyArgs = { where?: any; data?: any; select?: any; include?: any; orderBy?: any };
type Fn = ReturnType<typeof vi.fn>;

export interface DbMock {
  profile: { findUnique: Fn };
  membership: { findMany: Fn; findUnique: Fn };
  client: { findMany: Fn; findUnique: Fn; findFirst: Fn; create: Fn; update: Fn; delete: Fn };
  period: { findUnique: Fn; findFirst: Fn; create: Fn; count: Fn; delete: Fn };
  invoice: { findMany: Fn; findFirst: Fn; create: Fn; count: Fn; update: Fn; delete: Fn };
  invoiceVatLine: { findMany: Fn; deleteMany: Fn };
  taxRecord: { findMany: Fn; findFirst: Fn; create: Fn; count: Fn; update: Fn; deleteMany: Fn };
  auditLog: { create: Fn };
  periodVatSettings: { findUnique: Fn; create: Fn; update: Fn };
  $transaction: Fn;
  /** Simula lockPeriodForWrite (lock_timeout + FOR UPDATE de Period) y los FOR UPDATE de Invoice y TaxRecord; no hay locks reales. */
  $queryRaw: Fn;
}

export function freshDbMock(): DbMock {
  return {
    profile: { findUnique: vi.fn() },
    membership: { findMany: vi.fn(), findUnique: vi.fn() },
    client: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    period: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), delete: vi.fn() },
    invoice: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), update: vi.fn(), delete: vi.fn() },
    invoiceVatLine: { findMany: vi.fn(), deleteMany: vi.fn() },
    taxRecord: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    auditLog: { create: vi.fn() },
    periodVatSettings: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  };
}

/** Registro de AuditLogs escritos + filas de negocio creadas durante un test. */
export interface Recorder {
  audits: any[];
  created: Record<string, any>;
  failAudit: boolean;
  /** Bloqueos (Period / Invoice / TaxRecord) solicitados vía $queryRaw: { sql, values }. Sólo locks reales. */
  locks: Array<{ sql: string; values: unknown[] }>;
  /** Pasos de `lock_timeout` de lockPeriodForWrite (lectura, set 3000ms, restauración), en orden. */
  lockTimeouts: Array<{ step: "read" | "set" | "restore"; value: string }>;
  /**
   * Secuencia de TODAS las consultas raw aceptadas, en orden, con el
   * `lock_timeout` vigente al ejecutarse: "timeout:read@0", "timeout:set@3000ms",
   * "lock:Period@3000ms", "timeout:restore@0", "lock:Invoice@0" / "lock:TaxRecord@0".
   */
  rawSteps: string[];
  /** `lock_timeout` con el que arranca cada transacción del harness (default "0"). */
  initialLockTimeout: string;
  /** `lock_timeout` de la transacción en curso; null fuera de una transacción. */
  lockTimeout: string | null;
  /** true: el FOR UPDATE real de Period falla con P2010 / meta.code 55P03 (lock ocupado). */
  periodLockBusy: boolean;
  /** La transacción quedó abortada (tras un error de la base): toda raw posterior falla. */
  txAborted: boolean;
  /**
   * Opciones recibidas por CADA invocación de `$transaction`, en orden: copia
   * superficial del segundo argumento (o `undefined` si no se pasó). No se
   * simula ningún timeout; sólo se fija lo que envió la ruta.
   */
  txOptions: Array<Record<string, unknown> | undefined>;
}
export function freshRecorder(): Recorder {
  return {
    audits: [],
    created: {},
    failAudit: false,
    locks: [],
    lockTimeouts: [],
    rawSteps: [],
    initialLockTimeout: "0",
    lockTimeout: null,
    periodLockBusy: false,
    txAborted: false,
    txOptions: [],
  };
}

/** Error que Prisma 6.19.3 produce cuando un `$queryRaw` vence `lock_timeout`. */
export function lockNotAvailableError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`",
    { code: "P2010", clientVersion: "6.19.3", meta: { code: "55P03", message: "canceling statement due to lock timeout" } },
  );
}

export function wireDb(db: DbMock, world: World, rec: Recorder): void {
  db.profile.findUnique.mockImplementation(async ({ where }: AnyArgs) =>
    world.profiles.has(where.id) ? { id: where.id, email: `${where.id}@dero.test` } : null,
  );

  db.membership.findMany.mockImplementation(async ({ where }: AnyArgs) =>
    world.memberships
      .filter((m) => m.profileId === where.profileId)
      .map((m) => ({ organizationId: m.organizationId, role: m.role })),
  );
  db.membership.findUnique.mockImplementation(async ({ where }: AnyArgs) => {
    const { profileId, organizationId } = where.profileId_organizationId;
    const m = world.memberships.find(
      (x) => x.profileId === profileId && x.organizationId === organizationId,
    );
    return m ? { role: m.role } : null;
  });

  db.client.findUnique.mockImplementation(
    async ({ where }: AnyArgs) => world.clients.find((c) => c.id === where.id) ?? null,
  );
  db.client.findFirst.mockImplementation(async ({ where, include }: AnyArgs) => {
    const c = world.clients.find(
      (x) =>
        x.id === where.id &&
        (where.organizationId ? x.organizationId === where.organizationId : true),
    );
    if (!c) return null;
    if (!include) return c;
    return {
      ...c,
      periods: include.periods
        ? world.periods
            .filter((p) => p.clientId === c.id)
            .sort((a, b) => b.year - a.year || b.month - a.month)
        : undefined,
    };
  });
  db.client.findMany.mockImplementation(async ({ where }: AnyArgs) => {
    let rows = world.clients.slice();
    if (where?.organizationId) rows = rows.filter((c) => c.organizationId === where.organizationId);
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  });

  db.period.findUnique.mockImplementation(
    async ({ where }: AnyArgs) => world.periods.find((p) => p.id === where.id) ?? null,
  );
  db.period.findFirst.mockImplementation(async ({ where, include }: AnyArgs) => {
    const p = world.periods.find(
      (x) =>
        x.id === where.id &&
        (where.organizationId ? x.organizationId === where.organizationId : true),
    );
    if (!p) return null;
    if (!include) return p;
    const client = world.clients.find((c) => c.id === p.clientId) ?? clientRow(p.clientId, p.organizationId);
    return {
      ...p,
      invoices: include.invoices ? (world.invoices ?? []).filter((i) => i.periodId === p.id) : undefined,
      taxRecords: include.taxRecords ? (world.taxRecords ?? []).filter((t) => t.periodId === p.id) : undefined,
      client: include.client ? client : undefined,
    };
  });

  db.invoice.findMany.mockImplementation(async () => world.invoices ?? []);
  const linesOf = (invoiceId: string, organizationId: string) =>
    (world.invoiceVatLines ?? []).filter((l) => l.invoiceId === invoiceId && l.organizationId === organizationId);
  // Búsqueda de duplicados: compara cada clave presente en `where` (igualdad
  // simple), respeta `NOT: { id }` y adjunta { period: { month, year } }. Si
  // `select.vatLines` está pedido, adjunta sus líneas ({ vatRateCode }).
  db.invoice.findFirst.mockImplementation(async ({ where, select }: AnyArgs) => {
    const { NOT, ...eq } = where ?? {};
    const hit = (world.invoices ?? []).find(
      (i) =>
        Object.entries(eq).every(([k, v]) => i[k] === v) &&
        (NOT?.id === undefined || i.id !== NOT.id),
    );
    if (!hit) return null;
    const p = world.periods.find((x) => x.id === hit.periodId);
    const withPeriod = { ...hit, period: p ? { month: p.month, year: p.year } : null };
    if (!select?.vatLines) return withPeriod;
    return { ...withPeriod, vatLines: linesOf(hit.id, hit.organizationId).map((l) => ({ vatRateCode: l.vatRateCode })) };
  });
  // Igualdad simple por cada clave de `where` (sin `where`: todas las filas).
  const taxRecordsWhere = (where: any) =>
    (world.taxRecords ?? []).filter((t) => Object.entries(where ?? {}).every(([k, v]) => t[k] === v));
  const pick = (row: any, select: any) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row);
  db.taxRecord.findMany.mockImplementation(async ({ where }: AnyArgs = {}) => taxRecordsWhere(where).map((t) => ({ ...t })));
  db.taxRecord.findFirst.mockImplementation(async ({ where, select }: AnyArgs) => {
    const hit = taxRecordsWhere(where)[0];
    return hit ? pick({ ...hit }, select) : null;
  });

  const mkId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

  db.client.create.mockImplementation(async ({ data }: AnyArgs) => {
    if (world.clients.some((c) => c.organizationId === data.organizationId && c.cuit === data.cuit)) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: ["organizationId", "cuit"] },
      });
    }
    rec.created.client = data;
    return clientRow(mkId("c"), data.organizationId, {
      name: data.name,
      cuit: data.cuit,
      condition: data.condition,
      address: data.address ?? null,
      defaultIibbRate: new Prisma.Decimal(String(data.defaultIibbRate ?? "3")),
      createdById: data.createdById ?? null,
      updatedById: data.updatedById ?? null,
    });
  });

  const knownError = (code: string, message: string) =>
    new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "6.19.3" });
  const findByCompound = (where: any) => {
    const { id, organizationId } = where.id_organizationId;
    return world.clients.findIndex((c) => c.id === id && c.organizationId === organizationId);
  };

  // update/delete sobre @@unique([id, organizationId]); P2025 si no existe.
  db.client.update.mockImplementation(async ({ where, data }: AnyArgs) => {
    const idx = findByCompound(where);
    if (idx === -1) throw knownError("P2025", "Record to update not found");
    const current = world.clients[idx];
    if (
      data.cuit !== undefined &&
      world.clients.some(
        (c) => c.id !== current.id && c.organizationId === current.organizationId && c.cuit === data.cuit,
      )
    ) {
      throw knownError("P2002", "Unique constraint failed");
    }
    const next = { ...current, ...data, updatedAt: new Date("2026-02-01T00:00:00.000Z") };
    world.clients[idx] = next;
    rec.created.clientUpdate = data;
    return next;
  });
  // FK Restrict desde Period: P2003 si quedan períodos del cliente.
  db.client.delete.mockImplementation(async ({ where }: AnyArgs) => {
    const idx = findByCompound(where);
    if (idx === -1) throw knownError("P2025", "Record to delete does not exist");
    const current = world.clients[idx];
    if (world.periods.some((p) => p.clientId === current.id && p.organizationId === current.organizationId)) {
      throw knownError("P2003", "Foreign key constraint failed");
    }
    world.clients.splice(idx, 1);
    rec.created.clientDelete = where.id_organizationId;
    return current;
  });

  db.period.count.mockImplementation(
    async ({ where }: AnyArgs) =>
      world.periods.filter(
        (p) =>
          p.clientId === where.clientId &&
          (where.organizationId ? p.organizationId === where.organizationId : true),
      ).length,
  );

  const countByPeriod = (rows: any[] | undefined, where: any) =>
    (rows ?? []).filter(
      (r) =>
        r.periodId === where.periodId &&
        (where.organizationId ? r.organizationId === where.organizationId : true) &&
        (where.voucherCode?.in ? where.voucherCode.in.includes(r.voucherCode) : true),
    ).length;
  db.invoice.count.mockImplementation(async ({ where }: AnyArgs) => countByPeriod(world.invoices, where));
  db.taxRecord.count.mockImplementation(async ({ where }: AnyArgs) => countByPeriod(world.taxRecords, where));

  // delete sobre @@unique([id, organizationId]); P2025 si no existe; FK Restrict
  // desde Invoice/TaxRecord: P2003 si quedan movimientos.
  db.period.delete.mockImplementation(async ({ where }: AnyArgs) => {
    const { id, organizationId } = where.id_organizationId;
    const idx = world.periods.findIndex((p) => p.id === id && p.organizationId === organizationId);
    if (idx === -1) throw knownError("P2025", "Record to delete does not exist");
    const key = { periodId: id, organizationId };
    if (countByPeriod(world.invoices, key) > 0 || countByPeriod(world.taxRecords, key) > 0) {
      throw knownError("P2003", "Foreign key constraint failed");
    }
    const [removed] = world.periods.splice(idx, 1);
    rec.created.periodDelete = where.id_organizationId;
    return removed;
  });

  db.period.create.mockImplementation(async ({ data }: AnyArgs) => {
    if (
      world.periods.some(
        (p) => p.month === data.month && p.year === data.year && p.clientId === data.clientId,
      )
    ) {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: ["month", "year", "clientId"] },
      });
    }
    rec.created.period = data;
    return periodRow(mkId("p"), data.clientId, data.organizationId, {
      month: data.month,
      year: data.year,
      createdById: data.createdById ?? null,
      updatedById: data.updatedById ?? null,
    });
  });

  db.invoice.create.mockImplementation(async ({ data }: AnyArgs) => {
    rec.created.invoice = data;
    return {
      id: mkId("i"),
      date: data.date,
      type: data.type,
      pointOfSale: data.pointOfSale,
      number: data.number,
      entityName: data.entityName,
      entityCuit: data.entityCuit,
      netAmount: new Prisma.Decimal(String(data.netAmount)),
      vatRate: new Prisma.Decimal(String(data.vatRate)),
      vatAmount: new Prisma.Decimal(String(data.vatAmount)),
      totalAmount: new Prisma.Decimal(String(data.totalAmount)),
      category: data.category,
      periodId: data.periodId,
      organizationId: data.organizationId,
      createdById: data.createdById ?? null,
      updatedById: data.updatedById ?? null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      // Modelo contable y columnas del PR B: la fila devuelve lo que se escribió.
      voucherCode: data.voucherCode ?? null,
      voucherDate: data.voucherDate ?? null,
      lidSection: data.lidSection ?? "GENERAL",
      counterpartyVatConditionCode: data.counterpartyVatConditionCode ?? null,
      turivaRelationCode: data.turivaRelationCode ?? null,
      voucherVariant: data.voucherVariant ?? null,
    };
  });

  // Edición / baja de comprobantes sobre @@unique([id, organizationId]); P2025
  // si no existe. `vatLines: { deleteMany: {}, create }` reemplaza las líneas.
  // Cada update avanza updatedAt 1 s (simula @updatedAt).
  const invoiceIdx = (where: any) => {
    const { id, organizationId } = where.id_organizationId;
    return (world.invoices ?? []).findIndex((i) => i.id === id && i.organizationId === organizationId);
  };
  db.invoice.update.mockImplementation(async ({ where, data }: AnyArgs) => {
    const idx = invoiceIdx(where);
    if (idx === -1) throw knownError("P2025", "Record to update not found");
    const invoices = world.invoices as any[];
    const current = invoices[idx];
    const { vatLines, ...columns } = data;
    if (vatLines?.deleteMany) {
      world.invoiceVatLines = (world.invoiceVatLines ?? []).filter(
        (l) => !(l.invoiceId === current.id && l.organizationId === current.organizationId),
      );
    }
    if (vatLines?.create) {
      world.invoiceVatLines = [
        ...(world.invoiceVatLines ?? []),
        ...vatLines.create.map((l: any) => ({ id: mkId("vl"), ...l, invoiceId: current.id, organizationId: current.organizationId })),
      ];
    }
    const next = { ...current, ...columns, updatedAt: new Date(current.updatedAt.getTime() + 1000) };
    invoices[idx] = next;
    rec.created.invoiceUpdate = data;
    return next;
  });
  db.invoice.delete.mockImplementation(async ({ where }: AnyArgs) => {
    const idx = invoiceIdx(where);
    if (idx === -1) throw knownError("P2025", "Record to delete does not exist");
    const [removed] = (world.invoices as any[]).splice(idx, 1);
    // onDelete: Cascade desde InvoiceVatLine.
    world.invoiceVatLines = (world.invoiceVatLines ?? []).filter(
      (l) => !(l.invoiceId === removed.id && l.organizationId === removed.organizationId),
    );
    rec.created.invoiceDelete = where.id_organizationId;
    return removed;
  });
  db.invoiceVatLine.findMany.mockImplementation(async ({ where, select }: AnyArgs) => {
    const rows = linesOf(where.invoiceId, where.organizationId);
    if (!select) return rows;
    return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])));
  });
  db.invoiceVatLine.deleteMany.mockImplementation(async ({ where }: AnyArgs) => {
    const before = world.invoiceVatLines ?? [];
    const kept = before.filter((l) => !(l.invoiceId === where.invoiceId && l.organizationId === where.organizationId));
    world.invoiceVatLines = kept;
    return { count: before.length - kept.length };
  });

  db.taxRecord.create.mockImplementation(async ({ data }: AnyArgs) => {
    rec.created.taxRecord = data;
    return {
      id: mkId("t"),
      date: data.date,
      type: data.type,
      amount: new Prisma.Decimal(String(data.amount)),
      description: data.description ?? null,
      periodId: data.periodId,
      organizationId: data.organizationId,
      createdById: data.createdById ?? null,
      updatedById: data.updatedById ?? null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  });

  // update con where extendido { id, organizationId }; P2025 si no existe.
  db.taxRecord.update.mockImplementation(async ({ where, data }: AnyArgs) => {
    const rows = world.taxRecords ?? [];
    const idx = rows.findIndex((t) => t.id === where.id && t.organizationId === where.organizationId);
    if (idx === -1) throw knownError("P2025", "Record to update not found");
    const next = { ...rows[idx], ...data, updatedAt: new Date(TAX_RECORD_UPDATED_AT_AFTER) };
    rows[idx] = next;
    rec.created.taxRecordUpdate = data;
    return { ...next };
  });
  db.taxRecord.deleteMany.mockImplementation(async ({ where }: AnyArgs) => {
    const before = world.taxRecords ?? [];
    const removed = taxRecordsWhere(where);
    world.taxRecords = before.filter((t) => !removed.includes(t));
    if (removed.length > 0) rec.created.taxRecordDelete = where;
    return { count: removed.length };
  });

  db.auditLog.create.mockImplementation(async ({ data }: AnyArgs) => {
    if (rec.failAudit) throw new Error("audit down");
    rec.audits.push(data);
    return { id: mkId("audit"), ...data };
  });

  // PeriodVatSettings por @@unique([periodId, organizationId]).
  const vatSettingsOf = (where: any) => {
    const { periodId, organizationId } = where.periodId_organizationId;
    return (world.vatSettings ?? []).find((s) => s.periodId === periodId && s.organizationId === organizationId) ?? null;
  };
  db.periodVatSettings.findUnique.mockImplementation(async ({ where, select }: AnyArgs) => {
    const row = vatSettingsOf(where);
    if (!row || !select) return row;
    return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
  });
  db.periodVatSettings.create.mockImplementation(async ({ data }: AnyArgs) => {
    // Defaults del schema para los campos no informados.
    const row = {
      creditProrationMode: "NONE",
      globalCoefficient: null,
      globalCoefficientStatus: null,
      turivaIncluded: false,
      ...data,
    };
    world.vatSettings = [...(world.vatSettings ?? []), row];
    rec.created.vatSettings = data;
    return row;
  });
  db.periodVatSettings.update.mockImplementation(async ({ where, data }: AnyArgs) => {
    const row = vatSettingsOf(where);
    if (!row) throw knownError("P2025", "Record to update not found");
    Object.assign(row, data);
    rec.created.vatSettingsUpdate = data;
    return row;
  });

  // $queryRaw como tagged template: sólo se admiten EXACTAMENTE las consultas
  // de lockPeriodForWrite (lectura / set / restauración de lock_timeout y el
  // FOR UPDATE de Period) y el FOR UPDATE de Invoice. Cualquier otra falla.
  // Los locks se registran en rec.locks; los pasos de lock_timeout, aparte, en
  // rec.lockTimeouts. No existe un lock real en memoria.
  const READ_TIMEOUT = `SELECT current_setting('lock_timeout') AS "lockTimeout"`;
  const SET_TIMEOUT = "SELECT set_config('lock_timeout', '3000ms', true)";
  const RESTORE_TIMEOUT = "SELECT set_config('lock_timeout', ?, true)";
  const PERIOD_LOCK = /^SELECT "id" FROM "Period" WHERE "id" = \? AND "organizationId" = \? FOR UPDATE$/;
  const INVOICE_LOCK = /^SELECT .+ FROM "Invoice" WHERE "id" = \? AND "organizationId" = \? FOR UPDATE$/;
  const TAX_RECORD_LOCK_COLUMNS = ["id", "organizationId", "periodId", "type", "date", "amount", "description", "updatedAt"];
  const TAX_RECORD_LOCK = `SELECT ${TAX_RECORD_LOCK_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "TaxRecord" WHERE "id" = ? AND "organizationId" = ? FOR UPDATE`;
  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join("?");
    const sql = raw.replace(/\s+/g, " ").trim();
    if (rec.lockTimeout === null) throw new Error(`consulta raw fuera de una transacción: ${sql}`);
    if (rec.txAborted) throw new Error("current transaction is aborted, commands ignored until end of transaction block");
    const current = rec.lockTimeout;

    if (sql === READ_TIMEOUT && values.length === 0) {
      rec.lockTimeouts.push({ step: "read", value: current });
      rec.rawSteps.push(`timeout:read@${current}`);
      return [{ lockTimeout: current }];
    }
    if (sql === SET_TIMEOUT && values.length === 0) {
      rec.lockTimeout = "3000ms";
      rec.lockTimeouts.push({ step: "set", value: "3000ms" });
      rec.rawSteps.push(`timeout:set@3000ms`);
      return [{ set_config: "3000ms" }];
    }
    if (sql === RESTORE_TIMEOUT && values.length === 1 && typeof values[0] === "string") {
      rec.lockTimeout = values[0];
      rec.lockTimeouts.push({ step: "restore", value: values[0] });
      rec.rawSteps.push(`timeout:restore@${values[0]}`);
      return [{ set_config: values[0] }];
    }

    const [id, organizationId] = values;
    if (INVOICE_LOCK.test(sql) && values.length === 2) {
      rec.locks.push({ sql: raw, values });
      rec.rawSteps.push(`lock:Invoice@${current}`);
      const row = (world.invoices ?? []).find((i) => i.id === id && i.organizationId === organizationId);
      return row ? [{ ...row }] : [];
    }
    if (sql === TAX_RECORD_LOCK && values.length === 2) {
      rec.locks.push({ sql: raw, values });
      rec.rawSteps.push(`lock:TaxRecord@${current}`);
      const [id, organizationId] = values;
      const row = (world.taxRecords ?? []).find((t) => t.id === id && t.organizationId === organizationId);
      return row ? [pick(row, Object.fromEntries(TAX_RECORD_LOCK_COLUMNS.map((c) => [c, true])))] : [];
    }
    if (PERIOD_LOCK.test(sql) && values.length === 2) {
      rec.locks.push({ sql: raw, values });
      rec.rawSteps.push(`lock:Period@${current}`);
      if (rec.periodLockBusy) {
        rec.txAborted = true;
        throw lockNotAvailableError();
      }
      return world.periods.some((p) => p.id === id && p.organizationId === organizationId) ? [{ id }] : [];
    }
    throw new Error(`consulta raw inesperada: ${sql}`);
  });

  // $transaction(fn) -> corre fn con el propio db. Atomicidad simulada: si fn
  // lanza, se revierte lo que `rec` registró durante la transacción. El
  // lock_timeout es local a la transacción: arranca en rec.initialLockTimeout y
  // se descarta al terminar (commit o rollback).
  db.$transaction.mockImplementation(async (fn: (tx: DbMock) => Promise<unknown>, options?: Record<string, unknown>) => {
    rec.txOptions.push(options === undefined ? undefined : { ...options });
    rec.lockTimeout = rec.initialLockTimeout;
    rec.txAborted = false;
    try {
      return await runInTransaction(fn);
    } finally {
      rec.lockTimeout = null;
      rec.txAborted = false;
    }
  });
  const runInTransaction = async (fn: (tx: DbMock) => Promise<unknown>) => {
    const auditsBefore = rec.audits.length;
    const createdBefore = { ...rec.created };
    const clientsBefore = world.clients.slice();
    const periodsBefore = world.periods.slice();
    const vatSettingsBefore = world.vatSettings?.map((s) => ({ ...s }));
    const invoicesBefore = world.invoices?.slice();
    const invoiceVatLinesBefore = world.invoiceVatLines?.slice();
    const taxRecordsBefore = world.taxRecords?.map((t) => ({ ...t }));
    try {
      return await fn(db);
    } catch (err) {
      rec.audits.length = auditsBefore;
      rec.created = createdBefore;
      world.clients.splice(0, world.clients.length, ...clientsBefore);
      world.periods.splice(0, world.periods.length, ...periodsBefore);
      world.vatSettings = vatSettingsBefore;
      world.invoices = invoicesBefore;
      world.invoiceVatLines = invoiceVatLinesBefore;
      world.taxRecords = taxRecordsBefore;
      throw err;
    }
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Bloqueo del período: secuencia esperada, orden y caso ocupado ─────────

/** Secuencia raw de lockPeriodForWrite con el lock adquirido (rec.rawSteps). */
export const periodLockSteps = (previous = "0") => [
  `timeout:read@${previous}`,
  "timeout:set@3000ms",
  "lock:Period@3000ms",
  `timeout:restore@${previous}`,
];

/** Secuencia raw con el Period ocupado (55P03): sin restauración (la transacción hace rollback). */
export const periodBusySteps = (previous = "0") => [`timeout:read@${previous}`, "timeout:set@3000ms", "lock:Period@3000ms"];

/** invocationCallOrder de la (única) llamada a $queryRaw cuyo SQL coincide con `re`. */
export function rawCallOrder(db: DbMock, re: RegExp): number {
  const matches = db.$queryRaw.mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?")).filter((sql) => re.test(sql));
  if (matches.length !== 1) throw new Error(`se esperaba UNA consulta raw ${re}, hubo ${matches.length}`);
  const i = db.$queryRaw.mock.calls.findIndex((c) => re.test((c[0] as TemplateStringsArray).join("?")));
  return db.$queryRaw.mock.invocationCallOrder[i];
}
/** Orden del FOR UPDATE real de Period (no de la lectura/set/restauración de lock_timeout). */
export const periodLockOrder = (db: DbMock) => rawCallOrder(db, /FROM "Period"[\s\S]*FOR UPDATE/);
/** Orden de la restauración del lock_timeout previo. */
export const timeoutRestoreOrder = (db: DbMock) => rawCallOrder(db, /set_config\('lock_timeout', \?, true\)/);

/** Opciones que todo writer inventariado pasa a `$transaction` (tests/_period-lock-structure.ts). */
export const PERIOD_WRITE_TX_OPTIONS = { maxWait: 5000, timeout: 10000 } as const;

/** Contrato EXACTO del 409 por período ocupado (independiente de la constante productiva). */
export const PERIOD_BUSY_BODY = {
  error: {
    code: "PERIOD_BUSY",
    message: "El período está siendo modificado por otra operación. Esperá unos segundos y volvé a intentarlo.",
  },
};

/** 409 PERIOD_BUSY con cuerpo exacto y no-store. */
export async function expectPeriodBusyResponse(res: Response): Promise<void> {
  expect(res.status).toBe(409);
  expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
  expect(await res.json()).toEqual(PERIOD_BUSY_BODY);
}

/**
 * Espía console.error durante `fn` y devuelve si withApiAuthz registró un
 * "error no clasificado". Restaura el espía siempre.
 */
export async function loggedUnclassified<T>(fn: () => Promise<T>): Promise<{ result: T; unclassified: boolean }> {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    const unclassified = spy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("no clasificado"));
    return { result, unclassified };
  } finally {
    spy.mockRestore();
  }
}

/** Estado del harness tras la transacción ocupada: rollback y lock_timeout local descartado. */
export function expectBusyRollback(rec: Recorder, previous = "0"): void {
  expect(rec.rawSteps).toEqual(periodBusySteps(previous));
  expect(rec.lockTimeouts.some((t) => t.step === "restore")).toBe(false);
  expect(rec.locks).toHaveLength(1);
  expect(rec.locks[0].sql).toMatch(/FROM "Period"/);
  expect(rec.audits).toHaveLength(0);
  expect(rec.created).toEqual({});
  expect(rec.lockTimeout).toBeNull();
  expect(rec.txAborted).toBe(false);
}
