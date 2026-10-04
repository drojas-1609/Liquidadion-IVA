import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildTaxUpdateInput, isDateInPeriod, parseExpectedUpdatedAt, type TaxUpdateData } from "@/lib/api-input";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { lockTaxRecordForUpdate, type LockedTaxRecordRow } from "@/lib/tax-record-lock";
import { formatPeriodLabel } from "@/lib/period";
import { serializeTaxRecord } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_DELETE, ROLES_UPDATE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const STALE_MESSAGE =
    "La retención/percepción fue modificada por otra persona. Volvé a abrirla para ver los datos actuales.";

/** Período, cliente y organización autorizados ANTES de la transacción. */
interface AuthorizedScope {
    periodId: string;
    clientId: string;
    organizationId: string;
}

/** Lectura previa por { id, organizationId }: 404 si no existe en la organización activa. */
async function preloadTaxRecord(id: string, organizationId: string): Promise<{ periodId: string }> {
    const current = await prisma.taxRecord.findFirst({ where: { id, organizationId }, select: { periodId: true } });
    if (!current) throw new NotFoundError();
    return current;
}

/**
 * Acceso al período del TaxRecord: el MISMO 404 si no existe o es de otra
 * organización que la activa. Devuelve la referencia autorizada.
 */
async function authorizePeriod(
    profileId: string,
    organizationId: string,
    periodId: string,
    roles: Parameters<typeof requirePeriodAccess>[2],
): Promise<AuthorizedScope> {
    const access = await requirePeriodAccess(profileId, periodId, roles);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    return { periodId: access.period.id, clientId: access.period.clientId, organizationId };
}

/** Descripción comparable: sin espacios en los extremos; vacía -> null (mismo criterio que el builder). */
const normalizedDescription = (d: string | null) => (d === null || d.trim() === "" ? null : d.trim());

/** Nombres de campo cambiados, en orden canónico (date, type, amount, description). */
function changedFieldsOf(locked: LockedTaxRecordRow, input: TaxUpdateData): string[] {
    const changed: string[] = [];
    if (locked.date.getTime() !== input.date.getTime()) changed.push("date");
    if (locked.type !== input.type) changed.push("type");
    if (!locked.amount.equals(input.amount)) changed.push("amount");
    if (normalizedDescription(locked.description) !== input.description) changed.push("description");
    return changed;
}

// PATCH /api/taxes/[id] — corrección de una retención/percepción (OWNER /
// ADMIN / ACCOUNTANT).
//
// Orden: auth -> organización -> rol -> parseo (400) -> TaxRecord por id +
// organización (404) -> payload + expectedUpdatedAt; el período no cambia
// (422) -> acceso al período de la organización activa (404) -> transacción:
//   lock Period (lockPeriodForWrite) -> relectura del Period (404; cliente u
//   organización distintos: 409 stale) -> lock TaxRecord (404) -> updatedAt,
//   período y organización de la fila bloqueada (409 stale) -> fecha dentro
//   del período releído (422 date) -> changedFields desde la fila bloqueada
//   (vacío: 200 sin escritura ni AuditLog) -> update + AuditLog.
export const PATCH = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const body = await parseJsonBody(request);
    const preloaded = await preloadTaxRecord(id, organizationId);
    const parsed = buildTaxUpdateInput(body, preloaded.periodId);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const input = parsed.data;

    const authorized = await authorizePeriod(profileId, organizationId, preloaded.periodId, ROLES_UPDATE);

    const saved = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, authorized.periodId, organizationId);
        const period = await tx.period.findFirst({
            where: { id: authorized.periodId, organizationId },
            select: { id: true, organizationId: true, clientId: true, month: true, year: true },
        });
        if (!period) throw new NotFoundError();
        if (period.clientId !== authorized.clientId || period.organizationId !== organizationId) {
            throw new ConflictError(STALE_MESSAGE);
        }

        const locked = await lockTaxRecordForUpdate(tx, id, organizationId);
        if (!locked) throw new NotFoundError();
        if (
            locked.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() ||
            locked.periodId !== authorized.periodId ||
            locked.organizationId !== organizationId
        ) {
            throw new ConflictError(STALE_MESSAGE);
        }

        if (!isDateInPeriod(input.date, period)) {
            throw new ValidationError(`la fecha debe pertenecer al período ${formatPeriodLabel(period)}`, "date");
        }

        const changed = changedFieldsOf(locked, input);
        // Sin cambios: 200 con la fila bloqueada, sin escritura ni AuditLog.
        if (changed.length === 0) return locked;

        const updated = await tx.taxRecord.update({
            where: { id, organizationId },
            data: {
                date: input.date,
                type: input.type,
                amount: input.amount,
                description: input.description,
                updatedById: profileId,
            },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "taxrecord.update",
            targetType: "TaxRecord",
            targetId: id,
            // Tipo antes (fila bloqueada) y después (validado). Nunca importe,
            // descripción ni fecha.
            metadata: { periodId: locked.periodId, typeBefore: locked.type, typeAfter: input.type, changedFields: changed },
        });
        return updated;
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json(serializeTaxRecord(saved), { status: 200 });
});

// DELETE /api/taxes/[id]?expectedUpdatedAt=<ISO> — baja de una
// retención/percepción (OWNER / ADMIN). Un tipo histórico fuera del catálogo
// se puede eliminar.
//
// Orden: auth -> organización -> rol -> expectedUpdatedAt (422) -> TaxRecord
// por id + organización (404) -> acceso al período (404) -> transacción: lock
// Period -> relectura del Period (404; cliente u organización distintos: 409
// stale) -> lock TaxRecord (404) -> updatedAt, período y organización (409
// stale) -> deleteMany por id + organización (exactamente 1; si no, rollback)
// -> AuditLog taxrecord.delete. Si falla el AuditLog, rollback total.
export const DELETE = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_DELETE);

    const expected = parseExpectedUpdatedAt(new URL(request.url).searchParams.get("expectedUpdatedAt"));
    if (!expected.ok) throw new ValidationError(expected.error, expected.field);

    const preloaded = await preloadTaxRecord(id, organizationId);
    const authorized = await authorizePeriod(profileId, organizationId, preloaded.periodId, ROLES_DELETE);

    await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, authorized.periodId, organizationId);
        const period = await tx.period.findFirst({
            where: { id: authorized.periodId, organizationId },
            select: { id: true, organizationId: true, clientId: true },
        });
        if (!period) throw new NotFoundError();
        if (period.clientId !== authorized.clientId || period.organizationId !== organizationId) {
            throw new ConflictError(STALE_MESSAGE);
        }

        const locked = await lockTaxRecordForUpdate(tx, id, organizationId);
        if (!locked) throw new NotFoundError();
        if (
            locked.updatedAt.getTime() !== expected.data.getTime() ||
            locked.periodId !== authorized.periodId ||
            locked.organizationId !== organizationId
        ) {
            throw new ConflictError(STALE_MESSAGE);
        }

        const removed = await tx.taxRecord.deleteMany({ where: { id, organizationId } });
        if (removed.count !== 1) {
            throw new Error(`baja de retención/percepción: se esperaba borrar 1 fila y se borraron ${removed.count}`);
        }
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "taxrecord.delete",
            targetType: "TaxRecord",
            targetId: id,
            // De la fila bloqueada. Nunca importe, descripción ni fecha.
            metadata: { periodId: locked.periodId, type: locked.type },
        });
    }, { maxWait: 5000, timeout: 10000 });

    return new NextResponse(null, { status: 204 });
});
