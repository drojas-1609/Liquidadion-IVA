import { vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { Role } from "@prisma/client";

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

export function clientRow(id: string, organizationId: string, over: Partial<ClientRow> = {}): ClientRow {
  return {
    id,
    organizationId,
    name: `Cliente ${id}`,
    cuit: `30-${id.replace(/\D/g, "").padStart(8, "0")}-1`,
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

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface World {
  memberships: Array<{ profileId: string; organizationId: string; role: Role }>;
  profiles: Set<string>;
  clients: ClientRow[];
  periods: PeriodRow[];
  invoices?: any[];
  taxRecords?: any[];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Mundo por defecto: ORG_A (owner/accountant/viewer) + ORG_B (owner). */
export function makeWorld(over: Partial<World> = {}): World {
  return {
    memberships: [
      { profileId: SUB_OWNER_A, organizationId: ORG_A, role: "OWNER" },
      { profileId: SUB_ACCOUNTANT_A, organizationId: ORG_A, role: "ACCOUNTANT" },
      { profileId: SUB_VIEWER_A, organizationId: ORG_A, role: "VIEWER" },
      { profileId: SUB_OWNER_B, organizationId: ORG_B, role: "OWNER" },
    ],
    profiles: new Set([SUB_OWNER_A, SUB_ACCOUNTANT_A, SUB_VIEWER_A, SUB_OWNER_B, SUB_NO_ORG]),
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
  client: { findMany: Fn; findUnique: Fn; findFirst: Fn; create: Fn };
  period: { findUnique: Fn; findFirst: Fn; create: Fn };
  invoice: { findMany: Fn; create: Fn };
  taxRecord: { findMany: Fn; create: Fn };
  auditLog: { create: Fn };
  $transaction: Fn;
}

export function freshDbMock(): DbMock {
  return {
    profile: { findUnique: vi.fn() },
    membership: { findMany: vi.fn(), findUnique: vi.fn() },
    client: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    period: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    invoice: { findMany: vi.fn(), create: vi.fn() },
    taxRecord: { findMany: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
}

/** Registro de AuditLogs escritos + filas de negocio creadas durante un test. */
export interface Recorder {
  audits: any[];
  created: Record<string, any>;
  failAudit: boolean;
}
export function freshRecorder(): Recorder {
  return { audits: [], created: {}, failAudit: false };
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
  db.taxRecord.findMany.mockImplementation(async () => world.taxRecords ?? []);

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
    };
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

  db.auditLog.create.mockImplementation(async ({ data }: AnyArgs) => {
    if (rec.failAudit) throw new Error("audit down");
    rec.audits.push(data);
    return { id: mkId("audit"), ...data };
  });

  // $transaction(fn) -> corre fn con el propio db. Atomicidad simulada: si fn
  // lanza, se revierte lo que `rec` registró durante la transacción.
  db.$transaction.mockImplementation(async (fn: (tx: DbMock) => Promise<unknown>) => {
    const auditsBefore = rec.audits.length;
    const createdBefore = { ...rec.created };
    try {
      return await fn(db);
    } catch (err) {
      rec.audits.length = auditsBefore;
      rec.created = createdBefore;
      throw err;
    }
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */
