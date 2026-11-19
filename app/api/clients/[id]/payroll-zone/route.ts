import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { annexIZone } from "@/lib/payroll/annex-i";

// PUT /api/clients/[id]/payroll-zone { zoneCode } — zona del Anexo I de la Ley
// 27.541 del empleador (ficha del cliente). null la quita.
export const PUT = withApiAuthz(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const raw = (await parseJsonBody(request)) as { zoneCode?: unknown } | null;
    const code = raw?.zoneCode === null || raw?.zoneCode === "" ? null : Number(raw?.zoneCode);
    if (code !== null && !annexIZone(code)) throw new ValidationError("Zona del Anexo I inválida.", "zoneCode");
    await prisma.$transaction(async (tx) => {
        const c = await tx.client.updateMany({ where: { id, organizationId }, data: { payrollZoneCode: code } });
        if (c.count === 0) throw new NotFoundError();
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "payroll.zone_update", targetType: "Client", targetId: id, metadata: { zoneCode: code } });
    });
    return NextResponse.json({ zoneCode: code });
});
