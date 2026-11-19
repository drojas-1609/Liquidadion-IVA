import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_CONFIG } from "@/lib/auth/roles";

// DELETE /api/drive — desconecta Google Drive (no borra nada en Drive). Los
// respaldos pendientes quedan en la cola hasta que se vuelva a conectar.
export const DELETE = withApiAuthz(async () => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CONFIG, { module: "CLIENTS" });
    await prisma.$transaction(async (tx) => {
        await tx.driveConnection.deleteMany({ where: { organizationId } });
        await tx.driveFolder.deleteMany({ where: { organizationId } });
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "drive.disconnect", targetType: "Organization", targetId: organizationId, metadata: {} });
    });
    return NextResponse.json({ disconnected: true });
});
