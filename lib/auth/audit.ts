import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * Traza de auditoría (Tarea 3B).
 *
 * `recordAudit` se ejecuta SIEMPRE dentro del mismo `prisma.$transaction` que la
 * escritura de negocio: si la auditoría falla, la operación entera hace
 * rollback ("una operación de negocio no queda confirmada sin su auditoría").
 *
 * `sanitizeAuditMetadata` es una allow-list POR ACCIÓN. Nada fuera de la lista
 * se persiste. Nunca: contraseñas, tokens, cookies, claves, cadenas de
 * conexión, JWT, headers, cuerpos completos, importes fiscales, ni el CUIT del
 * propio cliente (queda en la fila Client y en `targetId`).
 */

export const AUDIT_ACTIONS = [
  // Emitidas en 3B
  "client.create",
  "period.create",
  "invoice.create",
  "taxrecord.create",
  "liquidation.export",
  // Reservadas para 3B+ (NO se emiten todavía; declaradas para no migrar luego)
  "client.update",
  "client.delete",
  "period.update",
  "period.delete",
  "invoice.update",
  "invoice.delete",
  "taxrecord.update",
  "taxrecord.delete",
  "member.add",
  "member.remove",
  "member.role_change",
  "org.config_change",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Claves permitidas en `metadata`, por acción. Vacío => siempre `{}`. */
const METADATA_ALLOW: Record<AuditAction, readonly string[]> = {
  "client.create": ["condition"], // NO cuit
  "period.create": ["clientId", "month", "year"],
  "invoice.create": ["periodId", "category", "type"],
  "taxrecord.create": ["periodId", "type"],
  "liquidation.export": [
    "periodId",
    "clientId",
    "month",
    "year",
    "invoiceCount",
    "taxRecordCount",
  ],
  "client.update": [],
  "client.delete": [],
  "period.update": [],
  "period.delete": [],
  "invoice.update": [],
  "invoice.delete": [],
  "taxrecord.update": [],
  "taxrecord.delete": [],
  "member.add": [],
  "member.remove": [],
  "member.role_change": [],
  "org.config_change": [],
};

const SECRET_RE =
  /(password|secret|token|api[_-]?key|authorization|cookie|bearer\s|eyJ[A-Za-z0-9_-]{10,}\.|postgres(?:ql)?:\/\/)/i;

const MAX_STRING = 256;
const MAX_JSON_BYTES = 2048;

type Scalar = string | number | boolean | null;

function sanitizeScalar(value: unknown): Scalar | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (SECRET_RE.test(value)) return undefined;
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  }
  // undefined, objetos, arrays, funciones, symbol, bigint -> se descartan
  return undefined;
}

/**
 * Devuelve un objeto plano y seguro con SÓLO las claves de la allow-list de
 * `action` cuyos valores sean escalares no sensibles. Salida mínima: `{}`.
 */
export function sanitizeAuditMetadata(action: string, input: unknown): Prisma.InputJsonObject {
  const allow = (METADATA_ALLOW as Record<string, readonly string[] | undefined>)[action] ?? [];
  const out: Record<string, Scalar> = {};
  if (allow.length > 0 && input !== null && typeof input === "object" && !Array.isArray(input)) {
    const src = input as Record<string, unknown>;
    for (const key of allow) {
      const v = sanitizeScalar(src[key]);
      if (v !== undefined) out[key] = v;
    }
  }
  // Tope de tamaño total (defensa; con claves escalares no debería alcanzarse).
  if (JSON.stringify(out).length > MAX_JSON_BYTES) return {};
  return out;
}

// ── recordAudit ───────────────────────────────────────────────────────────

interface AuditLogCreateData {
  organizationId: string;
  actorProfileId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Prisma.InputJsonValue;
}

/** Cliente de transacción mínimo que necesita `recordAudit` (inyectable). */
export interface AuditTxClient {
  auditLog: {
    create(args: { data: AuditLogCreateData }): Promise<unknown>;
  };
}

export interface RecordAuditInput {
  organizationId: string;
  actorProfileId: string;
  action: AuditAction;
  targetType: string;
  targetId: string;
  metadata: unknown;
}

/**
 * Inserta una fila de auditoría dentro de la transacción `tx`. Rechaza acciones
 * fuera de `AUDIT_ACTIONS` (defensa en profundidad, además del tipo).
 */
export async function recordAudit(tx: AuditTxClient, input: RecordAuditInput): Promise<void> {
  if (!(AUDIT_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`acción de auditoría no permitida: ${String(input.action)}`);
  }
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorProfileId: input.actorProfileId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: sanitizeAuditMetadata(input.action, input.metadata),
    },
  });
}
