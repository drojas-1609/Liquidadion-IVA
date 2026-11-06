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
 * conexión, JWT, headers, cuerpos completos, importes fiscales, ni el CUIT (ni la
 * dirección) del propio cliente (queda en la fila Client y en `targetId`).
 */

export const AUDIT_ACTIONS = [
  // Emitidas en 3B
  "client.create",
  "period.create",
  "invoice.create",
  "taxrecord.create",
  "liquidation.export",
  // Gestión de clientes
  "client.update",
  "client.delete",
  // Gestión de períodos
  "period.delete",
  // Cierre y reapertura de períodos
  "period.close",
  "period.reopen",
  // Configuración de IVA del período (declarada en Fase A; se emitirá cuando
  // exista el endpoint que modifique PeriodVatSettings).
  "period.vat_settings_change",
  // Posición de IVA cargada por el estudio (PUT /api/periods/[id]/vat-position):
  // saldo técnico anterior y ajustes al crédito fiscal por contribuciones.
  "period.vat_position_change",
  // Corrección de comprobantes manuales (PATCH / DELETE /api/invoices/[id])
  "invoice.update",
  "invoice.delete",
  // Importación masiva del Libro IVA Digital (TXT de comprobantes y alícuotas):
  // una fila por confirmación, con conteos y huella de los archivos. Se escribe
  // en la MISMA transacción que los comprobantes: si existe, la operación
  // (operationId) se aplicó completa.
  "invoice.import",
  // Confirmación que terminó con error DESPUÉS de revertirse: no escribió nada.
  // Permite consultar el resultado si la respuesta no llegó al navegador.
  "invoice.import.failed",
  // Importación de retenciones o percepciones de IVA (descargas de ARCA): una fila por confirmación.
  "taxrecord.import",
  // Clasificaciones para la presentación, por lote (PATCH /api/periods/[id]/invoice-classification).
  "invoice.classification_change",
  // Descarga del paquete de presentación de IVA (borrador o versión cerrada).
  "vat.package.export",
  // Consulta a ARCA en producción: quién, organización, cuándo (createdAt) y resultado.
  // Dos filas por consulta con el mismo targetId interno: intento (STARTED) y resultado.
  "arca.cuit_lookup",
  // Usuarios del estudio (Configuración → Usuarios). Sin correos, nombres ni
  // listas de clientes: sólo rol, alcance, cantidad de clientes y módulos.
  "member.invite",
  "member.invite_resend",
  "member.invite_revoke",
  "member.invite_accept",
  "member.permissions_change",
  "member.disable",
  "member.enable",
  // Reservadas para 3B+ (NO se emiten todavía; declaradas para no migrar luego)
  "period.update",
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
  // NO cuit ni contactos. iibbRegistration: categoría (enum), no dato personal.
  "client.create": ["condition", "iibbRegistration"],
  "period.create": ["clientId", "month", "year"],
  // Fase A: voucherCode (código oficial) reemplaza a `type`. Sin CUIT, nombres ni importes.
  "invoice.create": ["periodId", "category", "voucherCode"],
  // Sin CUIT, nombres ni importes: conteos por estado, pestaña y huella (sha256) de cada archivo.
  "invoice.import": [
    "periodId",
    "category",
    "format",
    "importedCount",
    "turivaCount",
    "duplicateCount",
    "reviewCount",
    "errorCount",
    "vouchersFileSha256",
    "aliquotsFileSha256",
    "operationId",
  ],
  // Sólo el identificador de la operación, el libro, el formato y el código del error.
  "invoice.import.failed": ["operationId", "attemptId", "periodId", "category", "format", "code", "httpStatus"],
  "taxrecord.create": ["periodId", "type"],
  "liquidation.export": [
    "periodId",
    "clientId",
    "month",
    "year",
    "invoiceCount",
    "taxRecordCount",
  ],
  // changedFields: NOMBRES de campo separados por coma, nunca valores (ni
  // teléfono, email, actividades o alícuotas). NO cuit.
  "client.update": ["changedFields", "condition", "iibbRegistration"],
  "client.delete": ["condition"], // NO cuit, nombre ni dirección
  "period.delete": ["clientId", "month", "year"],
  // Sin texto libre, CUIT, nombres ni importes. version: número de la versión
  // cerrada (cierre) o reemplazada (reapertura). El motivo de la reapertura se
  // guarda en la versión reemplazada; acá sólo su longitud.
  "period.close": ["clientId", "month", "year", "version", "packageReady"],
  "period.reopen": ["clientId", "month", "year", "version", "reasonLength"],
  // Conteos por estado y huella del archivo. NUNCA importes, CUIT ni números de comprobante.
  "taxrecord.import": ["periodId", "kind", "layout", "importedCount", "duplicateCount", "reviewCount", "errorCount", "fileSha256"],
  // Por lote: cantidad de comprobantes y NOMBRES de los campos cambiados.
  "invoice.classification_change": ["periodId", "category", "count", "changedFields"],
  // Modo (DRAFT/FINAL), versión y huella del ZIP entregado. Sin importes.
  "vat.package.export": ["periodId", "clientId", "month", "year", "mode", "version", "packageSha256"],
  // Reconstruye cómo se obtuvo una liquidación. Coeficientes como strings
  // decimales EXACTOS (nunca float). Sin CUIT, nombres ni importes.
  "period.vat_settings_change": [
    "changedFields",
    "prorationModeBefore",
    "prorationModeAfter",
    "coefficientBefore",
    "coefficientAfter",
    "coefficientStatusBefore",
    "coefficientStatusAfter",
    "turivaIncludedBefore",
    "turivaIncludedAfter",
  ],
  // Sólo NOMBRES de campo y regímenes (catálogo cerrado). NUNCA importes ni
  // referencias (texto libre).
  "period.vat_position_change": ["changedFields", "regimesBefore", "regimesAfter"],
  "period.update": [],
  // Corrección de comprobantes manuales. Identifican el comprobante (código,
  // punto de venta y número) sin datos personales ni importes. Los "Before" y
  // la baja salen de la fila BLOQUEADA; los "After", de lo normalizado por el
  // servidor. changedFields: NOMBRES de campo separados por coma, nunca valores.
  // NUNCA importes, alícuotas, CUIT, documento, nombre ni valores sin normalizar.
  "invoice.update": [
    "periodId",
    "category",
    "voucherCodeBefore",
    "voucherCodeAfter",
    "pointOfSaleBefore",
    "pointOfSaleAfter",
    "numberBefore",
    "numberAfter",
    "changedFields",
  ],
  "invoice.delete": ["periodId", "category", "voucherCode", "pointOfSale", "number"],
  // SÓLO el código de resultado. NUNCA el CUIT consultado, la respuesta de ARCA, tokens ni credenciales.
  "arca.cuit_lookup": ["result"],
  // Corrección de retenciones/percepciones. `typeBefore` sale de la fila
  // BLOQUEADA (puede ser un tipo histórico fuera del catálogo: se conserva
  // saneado); `typeAfter`, de lo validado por el servidor. changedFields: ver
  // TAXRECORD_CHANGED_FIELDS. NUNCA importe, descripción ni fecha.
  "taxrecord.update": ["periodId", "typeBefore", "typeAfter", "changedFields"],
  "taxrecord.delete": ["periodId", "type"],
  // Usuarios del estudio. targetType "OrganizationInvitation" o "Membership";
  // el actor es quien hace la acción (en la aceptación, la persona invitada).
  // NUNCA correo, nombre, ids de clientes ni datos de la sesión.
  "member.invite": ["role", "clientScope", "clientCount", "modules"],
  "member.invite_resend": [],
  "member.invite_revoke": [],
  "member.invite_accept": ["membershipId", "role"],
  "member.permissions_change": [
    "changedFields",
    "roleBefore",
    "roleAfter",
    "clientScopeBefore",
    "clientScopeAfter",
    "clientCount",
    "modules",
  ],
  "member.disable": ["role"],
  "member.enable": ["role"],
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

/** Campos de un TaxRecord que puede nombrar `changedFields`, en su orden canónico. */
const TAXRECORD_CHANGED_FIELDS = ["date", "type", "amount", "description", "f2051Detail"] as const;

/**
 * `changedFields` de `taxrecord.update`: SÓLO un array de nombres de
 * TAXRECORD_CHANGED_FIELDS. Se descartan los elementos ajenos (otros nombres,
 * vacíos, no-string) y los duplicados; el resultado sale en el orden canónico
 * y separado por comas, como el `changedFields` de las demás acciones. Si no
 * es un array o no queda ningún nombre válido, la clave se omite. Ningún texto
 * del llamador llega a la salida: sólo los nombres fijos de la lista.
 */
function taxRecordChangedFields(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = TAXRECORD_CHANGED_FIELDS.filter((f) => value.includes(f));
  return names.length > 0 ? names.join(",") : undefined;
}

/**
 * Normalizadores por acción y clave que reemplazan a `sanitizeScalar`. Sólo
 * para las claves listadas; el resto de las acciones no cambia.
 */
/** Resultados de `arca.cuit_lookup`: códigos fijos, nunca texto de ARCA. */
export const ARCA_LOOKUP_AUDIT_RESULTS = [
  "STARTED",
  "FOUND",
  "NOT_FOUND",
  "RETRY_LATER",
  "ERROR_TIMEOUT",
  "ERROR_UNAVAILABLE",
  "ERROR_AUTH",
  "ERROR_INVALID_RESPONSE",
  "ERROR_STORE_UNAVAILABLE",
  "NOT_CONFIGURED",
  "INVALID_CUIT",
] as const;

const METADATA_NORMALIZERS: Partial<Record<AuditAction, Readonly<Record<string, (value: unknown) => Scalar | undefined>>>> = {
  "taxrecord.update": { changedFields: taxRecordChangedFields },
  "arca.cuit_lookup": {
    result: (value) => (typeof value === "string" && (ARCA_LOOKUP_AUDIT_RESULTS as readonly string[]).includes(value) ? value : undefined),
  },
};

/**
 * Devuelve un objeto plano y seguro con SÓLO las claves de la allow-list de
 * `action` cuyos valores sean escalares no sensibles. Salida mínima: `{}`.
 */
export function sanitizeAuditMetadata(action: string, input: unknown): Prisma.InputJsonObject {
  const allow = (METADATA_ALLOW as Record<string, readonly string[] | undefined>)[action] ?? [];
  const normalizers = (METADATA_NORMALIZERS as Record<string, Readonly<Record<string, (value: unknown) => Scalar | undefined>> | undefined>)[action];
  const out: Record<string, Scalar> = {};
  if (allow.length > 0 && input !== null && typeof input === "object" && !Array.isArray(input)) {
    const src = input as Record<string, unknown>;
    for (const key of allow) {
      const normalize = normalizers && Object.hasOwn(normalizers, key) ? normalizers[key] : sanitizeScalar;
      const v = normalize(src[key]);
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
