import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string; entryId: string }> };

// DELETE /api/clients/[id]/journal/[entryId] — anula (borra) un asiento. Los
// asientos automáticos se pueden volver a generar desde el período.
export const DELETE = withApiAuthz(async (_request: Request, ctx: Ctx) => {
    const { id, entryId } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    await prisma.$transaction(async (tx) => {
        const entry = await tx.journalEntry.findFirst({ where: { id: entryId, clientId: id, organizationId }, select: { id: true, number: true, kind: true } });
        if (!entry) throw new NotFoundError();
        await tx.journalEntry.delete({ where: { id: entry.id } });
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "journal.entry_delete", targetType: "Client", targetId: id, metadata: { kind: entry.kind, number: entry.number } });
    });
    return NextResponse.json({ deleted: true });
});
