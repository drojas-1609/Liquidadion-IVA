import { after, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { parseJsonBody, requireAuthenticatedProfile, requirePeriodAccess, withApiAuthz } from "@/lib/auth/authz";
import { ConflictError, ValidationError } from "@/lib/auth/errors";
import { ROLES_CONFIG, ROLES_CREATE } from "@/lib/auth/roles";
import { parseExtraDays } from "@/lib/arca-sync/calendar";
import { getSyncStatus, runNextSyncTask, startManualSync } from "@/lib/arca-sync/service";

type Context = { params: Promise<{ id: string }> };

export const GET = withApiAuthz(async (_request: Request, context: Context) => {
    const { id } = await context.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { period } = await requirePeriodAccess(profileId, id, ROLES_CREATE);
    return NextResponse.json(await getSyncStatus(id, period.clientId));
});

export const PUT = withApiAuthz(async (request: Request, context: Context) => {
    const { id } = await context.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { period, organizationId } = await requirePeriodAccess(profileId, id, ROLES_CONFIG);
    const body = await parseJsonBody(request) as { enabled?: unknown; extraDays?: unknown } | null;
    const extraDays = parseExtraDays(body?.extraDays);
    if (!extraDays || typeof body?.enabled !== "boolean") {
        throw new ValidationError("Elegí hasta dos días distintos del 25, entre el 1 y el 31.", "extraDays");
    }
    const settings = { enabled: body.enabled, extraDays, actorProfileId: profileId };
    await prisma.arcaSyncSchedule.upsert({
        where: { clientId: period.clientId },
        create: { ...settings, clientId: period.clientId, organizationId },
        update: settings,
    });
    return NextResponse.json(await getSyncStatus(id, period.clientId));
});

export const POST = withApiAuthz(async (_request: Request, context: Context) => {
    const { id } = await context.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { period, organizationId } = await requirePeriodAccess(profileId, id, ROLES_CREATE);
    if (period.status !== "OPEN") throw new ConflictError("El período está cerrado.");
    if (!(await getSyncStatus(id, period.clientId)).configured) {
        throw new ConflictError("Falta conectar el servicio de descarga de ARCA.");
    }
    await startManualSync(id, organizationId, profileId);
    after(async () => { await runNextSyncTask(id); });
    return NextResponse.json(await getSyncStatus(id, period.clientId), { status: 202 });
});
