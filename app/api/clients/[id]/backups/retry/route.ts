import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, withApiAuthz } from "@/lib/auth/authz";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/auth/errors";
import { processPendingBackups } from "@/lib/drive/backup-service";

// POST /api/clients/[id]/backups/retry — vuelve a intentar subir a Drive los
// respaldos pendientes o con error del cliente.
export const POST = withApiAuthz(async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    await prisma.documentBackup.updateMany({ where: { organizationId, clientId: id, status: "ERROR" }, data: { attempts: 0, status: "PENDING" } });
    let result;
    try {
        result = await processPendingBackups(prisma, organizationId, { clientId: id, limit: 20, deadlineMs: 20000 });
    } catch (e) {
        return NextResponse.json({ status: "error", message: e instanceof Error ? e.message.slice(0, 200) : "No se pudo conectar con Drive." });
    }
    return NextResponse.json(result);
});
