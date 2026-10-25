import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildPeriodTransitionInput } from "@/lib/api-input";
import { lockPeriodForStatusChange } from "@/lib/period-lock";
import { nextPeriodUpdatedAt, PERIOD_STALE_MESSAGE } from "@/lib/period-status";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_PERIOD_CLOSE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/periods/[id]/close — cierre del período (OWNER / ADMIN / ACCOUNTANT).
//
// Orden: auth -> organización -> rol -> parseo (400) -> expectedUpdatedAt
// (422) -> acceso al período (otra org o inexistente: MISMO 404) -> en una
// única transacción: bloqueo de la fila Period con lockPeriodForStatusChange
// (el MISMO FOR UPDATE que toman todas las escrituras del contenido; 404 /
// 409 PERIOD_BUSY) -> relectura bajo el bloqueo -> updatedAt distinto del que
// vio la pantalla: 409 CONFLICT sin escribir ni auditar -> ya cerrado: 200
// sin escritura ni AuditLog -> status CLOSED + closedAt + closedById + nueva
// versión (updatedAt) + AuditLog period.close. Si falla el AuditLog, rollback.
//
// No exige que la liquidación sea calculable ni modifica el contenido.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_PERIOD_CLOSE);

    const body = await parseJsonBody(request);
    const parsed = buildPeriodTransitionInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const access = await requirePeriodAccess(profileId, id, ROLES_PERIOD_CLOSE);
    // Defensa en profundidad: el período debe ser de la organización ACTIVA.
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const result = await prisma.$transaction(async (tx) => {
        const status = await lockPeriodForStatusChange(tx, id, organizationId);
        const period = await tx.period.findFirst({
            where: { id, organizationId },
            select: { clientId: true, month: true, year: true, updatedAt: true },
        });
        if (!period) throw new NotFoundError();
        if (period.updatedAt.getTime() !== parsed.data.expectedUpdatedAt.getTime()) {
            throw new ConflictError(PERIOD_STALE_MESSAGE);
        }
        if (status === "CLOSED") return { status, updatedAt: period.updatedAt };

        const now = new Date();
        const updated = await tx.period.update({
            where: { id_organizationId: { id, organizationId } },
            data: {
                status: "CLOSED",
                closedAt: now,
                closedById: profileId,
                updatedById: profileId,
                updatedAt: nextPeriodUpdatedAt(period.updatedAt, now),
            },
            select: { status: true, updatedAt: true },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "period.close",
            targetType: "Period",
            targetId: id,
            metadata: { clientId: period.clientId, month: period.month, year: period.year },
        });
        return updated;
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json(
        { periodId: id, status: result.status, updatedAt: result.updatedAt.toISOString() },
        { status: 200 },
    );
});
