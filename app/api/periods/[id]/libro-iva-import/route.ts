import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requirePeriodAccess, withApiAuthz } from "@/lib/auth/authz";
import { ROLES_READ } from "@/lib/auth/roles";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { findImportOperation, listImportOperations, publicOperationView } from "@/lib/libro-iva-import/service";
import { isOperationId } from "@/lib/libro-iva-import/operation";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/periods/[id]/libro-iva-import[?operationId=<uuid>] — SÓLO LECTURA.
// Resultado de las confirmaciones del período según el AuditLog: la operación
// pedida (APPLIED / FAILED / NOT_FOUND) y las últimas registradas. Permite
// saber si una confirmación cuya respuesta se cortó quedó aplicada. Filtra por
// la organización activa y el período autorizado; sin CUIT, nombres ni importes.
export const GET = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requirePeriodAccess(profileId, id, ROLES_READ);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const scope = { organizationId, periodId: access.period.id, clientId: access.period.clientId };

    const raw = new URL(request.url).searchParams.get("operationId");
    if (raw !== null && !isOperationId(raw)) throw new ValidationError("operationId inválido", "operationId");
    const operation = raw === null ? null : publicOperationView(await findImportOperation(prisma, scope, raw));
    const recent = await listImportOperations(prisma, scope);
    return NextResponse.json({ operation, recent });
});
