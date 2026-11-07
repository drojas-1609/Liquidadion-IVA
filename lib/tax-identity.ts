import "server-only";
import type { Prisma, TaxRecordNature } from "@prisma/client";
import { ConflictError, NotFoundError } from "./auth/errors";
import { lockClientForUpdate, type ClientLockTx } from "./client-lock";

/**
 * Identidad de una retención o percepción de IVA para detectar duplicados en
 * TODOS los períodos del cliente, con la composición de cada formato del
 * F.2051 (diseño de importación):
 *  - RETENTION: CUIT del agente + número de certificado. El certificado lo
 *    numera cada agente: el mismo número de dos agentes distintos son dos
 *    retenciones legítimas.
 *  - PERCEPTION: régimen + CUIT del agente + tipo y número del comprobante. Un
 *    mismo comprobante puede tener percepciones de regímenes distintos.
 *  - CUSTOMS_PERCEPTION: régimen + número de despacho.
 * La clave lleva la naturaleza como prefijo: nunca se confunde una retención
 * con una percepción. Son las mismas columnas que los índices únicos parciales
 * de la base (TaxRecord_*_key), que sólo cubren UN período; la unicidad entre
 * períodos la garantiza `lockClientTaxIdentity` (bloqueo de la fila Client) +
 * la relectura dentro de la misma transacción.
 *
 * Sin los datos de identidad completos (carga manual sin detalle del F.2051)
 * no hay clave: esas filas no se comparan.
 */

export interface TaxIdentityFields {
    nature: TaxRecordNature | null;
    regimeCode: number | null;
    agentCuit: string | null;
    voucherTypeCode: number | null;
    voucherNumber: string | null;
    certificateNumber: string | null;
    customsDocument: string | null;
}

export function taxIdentityKey(r: TaxIdentityFields): string | null {
    switch (r.nature) {
        case "RETENTION":
            return r.agentCuit && r.certificateNumber ? `R|${r.agentCuit}|${r.certificateNumber}` : null;
        case "PERCEPTION":
            return r.regimeCode !== null && r.agentCuit && r.voucherTypeCode !== null && r.voucherNumber
                ? `P|${r.regimeCode}|${r.agentCuit}|${r.voucherTypeCode}|${r.voucherNumber}`
                : null;
        case "CUSTOMS_PERCEPTION":
            return r.regimeCode !== null && r.customsDocument ? `A|${r.regimeCode}|${r.customsDocument}` : null;
        default:
            return null;
    }
}

export const TAX_IDENTITY_SELECT = {
    id: true,
    nature: true,
    regimeCode: true,
    agentCuit: true,
    voucherTypeCode: true,
    voucherNumber: true,
    certificateNumber: true,
    customsDocument: true,
    amount: true,
    date: true,
    period: { select: { month: true, year: true } },
} as const;

export interface RegisteredTaxIdentity {
    id: string;
    /** "MM/AAAA" del período donde está registrada. */
    period: string;
    amount: Prisma.Decimal;
    /** AAAA-MM-DD. */
    date: string;
}

type Db = Pick<Prisma.TransactionClient, "taxRecord">;

const periodLabel = (p: { month: number; year: number }) => `${String(p.month).padStart(2, "0")}/${p.year}`;

/** Identidades ya registradas para el cliente (todas sus filas con naturaleza), por clave. */
export async function registeredTaxIdentities(
    db: Db,
    scope: { organizationId: string; clientId: string },
    natures: readonly TaxRecordNature[],
): Promise<Map<string, RegisteredTaxIdentity>> {
    const rows = await db.taxRecord.findMany({
        where: { organizationId: scope.organizationId, period: { clientId: scope.clientId }, nature: { in: [...natures] } },
        select: TAX_IDENTITY_SELECT,
        orderBy: { createdAt: "asc" },
    });
    const out = new Map<string, RegisteredTaxIdentity>();
    for (const r of rows) {
        const k = taxIdentityKey(r);
        if (k !== null && !out.has(k)) out.set(k, { id: r.id, period: periodLabel(r.period), amount: r.amount, date: r.date.toISOString().slice(0, 10) });
    }
    return out;
}

/** Otra fila del cliente con la misma identidad (excluida `excludeId`), o null. */
export async function findTaxIdentityConflict(
    db: Db,
    scope: { organizationId: string; clientId: string },
    record: TaxIdentityFields,
    excludeId?: string,
): Promise<RegisteredTaxIdentity | null> {
    const key = taxIdentityKey(record);
    if (key === null || record.nature === null) return null;
    const rows = await db.taxRecord.findMany({
        where: {
            organizationId: scope.organizationId,
            period: { clientId: scope.clientId },
            nature: record.nature,
            ...(excludeId ? { NOT: { id: excludeId } } : {}),
        },
        select: TAX_IDENTITY_SELECT,
        orderBy: { createdAt: "asc" },
    });
    const other = rows.find((r) => taxIdentityKey(r) === key);
    return other ? { id: other.id, period: periodLabel(other.period), amount: other.amount, date: other.date.toISOString().slice(0, 10) } : null;
}

export function taxIdentityConflictMessage(nature: TaxRecordNature, at: RegisteredTaxIdentity): string {
    const what = nature === "RETENTION" ? "Esa retención (agente y certificado)" : nature === "PERCEPTION" ? "Esa percepción (régimen, agente y comprobante)" : "Esa percepción aduanera (régimen y despacho)";
    return `${what} ya está registrada para el cliente en el período ${at.period}.`;
}

/**
 * Serializa, para UN cliente, las escrituras que pueden crear o cambiar la
 * identidad de una retención o percepción (importación y carga manual), aunque
 * sean de períodos distintos: bloqueo de la fila Client (`lockClientForUpdate`,
 * el mismo de la edición de la ficha), liberado al confirmar o revertir.
 *
 * Orden de bloqueos: SIEMPRE después de `lockPeriodForWrite` (Period ->
 * Client). La edición de la ficha bloquea sólo Client, así que no hay esperas
 * cruzadas. Cliente inexistente en la organización: el mismo 404.
 */
export async function lockClientTaxIdentity(tx: ClientLockTx, organizationId: string, clientId: string): Promise<void> {
    const locked = await lockClientForUpdate(tx, clientId, organizationId);
    if (!locked) throw new NotFoundError();
}

/**
 * Carga manual (alta o edición): toma el bloqueo por cliente y rechaza con 409
 * si la identidad ya está registrada en cualquier período del cliente. Sin
 * identidad completa no hay control (ni bloqueo).
 */
export async function assertTaxIdentityFree(
    tx: Pick<Prisma.TransactionClient, "$queryRaw" | "taxRecord">,
    scope: { organizationId: string; clientId: string },
    record: Partial<TaxIdentityFields>,
    excludeId?: string,
): Promise<void> {
    const fields: TaxIdentityFields = {
        nature: record.nature ?? null,
        regimeCode: record.regimeCode ?? null,
        agentCuit: record.agentCuit ?? null,
        voucherTypeCode: record.voucherTypeCode ?? null,
        voucherNumber: record.voucherNumber ?? null,
        certificateNumber: record.certificateNumber ?? null,
        customsDocument: record.customsDocument ?? null,
    };
    if (taxIdentityKey(fields) === null || fields.nature === null) return;
    await lockClientTaxIdentity(tx, scope.organizationId, scope.clientId);
    const hit = await findTaxIdentityConflict(tx, scope, fields, excludeId);
    if (hit) throw new ConflictError(taxIdentityConflictMessage(fields.nature, hit));
}
