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
import { ROLES_PERIOD_REOPEN } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/periods/[id]/reopen — reapertura de un período cerrado (OWNER / ADMIN).
//
// Mismo orden que /close: auth -> organización -> rol -> parseo (400) ->
// expectedUpdatedAt (422) -> acceso al período (MISMO 404) -> transacción:
// lockPeriodForStatusChange (mismo FOR UPDATE de Period; 404 / 409
// PERIOD_BUSY) -> relectura -> versión distinta: 409 CONFLICT sin escribir ni
// auditar -> ya abierto: 200 sin escritura ni AuditLog -> status OPEN y
// closedAt / closedById en NULL + nueva versión + AuditLog period.reopen.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_PERIOD_REOPEN);

    const body = await parseJsonBody(request);
    const parsed = buildPeriodTransitionInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const access = await requirePeriodAccess(profileId, id, ROLES_PERIOD_REOPEN);
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
        if (status === "OPEN") return { status, updatedAt: period.updatedAt };

        const updated = await tx.period.update({
            where: { id_organizationId: { id, organizationId } },
            data: {
                status: "OPEN",
                closedAt: null,
                closedById: null,
                updatedById: profileId,
                updatedAt: nextPeriodUpdatedAt(period.updatedAt, new Date()),
            },
            select: { status: true, updatedAt: true },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "period.reopen",
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
