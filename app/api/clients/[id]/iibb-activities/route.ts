import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { buildActivityConfigInput } from "@/lib/iibb/activity-input";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/clients/[id]/iibb-activities { principalCode, pos: [{ pointOfSale, activityCode }] }
// Actividad principal de IIBB y puntos de venta asignados a una actividad
// (reemplaza la lista completa). Los códigos deben ser actividades de la ficha.
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const body = await parseJsonBody(request);

    await prisma.$transaction(async (tx) => {
        const client = await tx.client.findFirst({ where: { id, organizationId }, select: { id: true, activities: { select: { code: true } } } });
        if (!client) throw new NotFoundError();
        const parsed = buildActivityConfigInput(body, client.activities.map((a) => a.code));
        if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
        const { principalCode, pos } = parsed.value;
        await tx.client.update({ where: { id }, data: { iibbPrincipalActivityCode: principalCode, updatedById: profileId } });
        await tx.clientPosActivity.deleteMany({ where: { clientId: id, organizationId } });
        if (pos.length > 0) await tx.clientPosActivity.createMany({ data: pos.map((p) => ({ organizationId, clientId: id, pointOfSale: p.pointOfSale, activityCode: p.activityCode })) });
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "client.iibb_activity_config", targetType: "Client", targetId: id, metadata: { principalCode, posCount: pos.length } });
    });
    return NextResponse.json({ ok: true });
});
