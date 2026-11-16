import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { parseJsonBody, requireAuthenticatedProfile, requirePeriodAccess, withApiAuthz } from "@/lib/auth/authz";
import { ConflictError, ValidationError } from "@/lib/auth/errors";
import { ROLES_CONFIG, ROLES_CREATE } from "@/lib/auth/roles";
import { parseInitialData } from "@/lib/arca-sync/initial-data";
import { getSyncStatus } from "@/lib/arca-sync/service";

type Context = { params: Promise<{ id: string }> };

// PUT /api/periods/[id]/arca-sync/initial-data
// { initialData, saveAsClientDefault? } guarda los datos iniciales de IVA Simple
// elegidos para el período. Con saveAsClientDefault también quedan como
// predeterminados del cliente (requiere permiso de configuración).
export const PUT = withApiAuthz(async (request: Request, context: Context) => {
    const { id } = await context.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { period, organizationId } = await requirePeriodAccess(profileId, id, ROLES_CREATE);
    const body = await parseJsonBody(request) as { initialData?: unknown; saveAsClientDefault?: unknown } | null;
    const parsed = parseInitialData(body?.initialData);
    if (!parsed.ok) throw new ValidationError(parsed.error, "initialData");
    if (body?.saveAsClientDefault !== undefined && typeof body.saveAsClientDefault !== "boolean") {
        throw new ValidationError("saveAsClientDefault debe ser booleano.", "saveAsClientDefault");
    }
    if (period.status !== "OPEN") throw new ConflictError("El período está cerrado.");
    if (body?.saveAsClientDefault) await requirePeriodAccess(profileId, id, ROLES_CONFIG);
    const data = { ...parsed.value };
    await prisma.$transaction(async (tx) => {
        await tx.arcaPeriodSetting.upsert({
            where: { periodId: id },
            create: { periodId: id, organizationId, initialData: data, updatedById: profileId },
            update: { initialData: data, updatedById: profileId },
        });
        if (body?.saveAsClientDefault) {
            await tx.client.update({ where: { id: period.clientId }, data: { arcaInitialData: data, updatedById: profileId } });
        }
    });
    return NextResponse.json(await getSyncStatus(id, period.clientId));
});
