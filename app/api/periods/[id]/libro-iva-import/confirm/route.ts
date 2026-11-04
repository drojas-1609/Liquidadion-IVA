import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";
import { recordAudit } from "@/lib/auth/audit";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { assertTurivaIncludedUnderLock } from "@/lib/invoice-write";
import { parseImportRequest } from "@/lib/libro-iva-import/request";
import { importAuditMetadata, importedVoucherKeys, importWriteData, planConfirm, STALE_PREVIEW_MESSAGE } from "@/lib/libro-iva-import/service";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/periods/[id]/libro-iva-import/confirm — escribe los comprobantes OK
// de la vista previa. Recibe los MISMOS archivos y el token de la vista previa.
// Orden: auth -> organización -> rol -> parseo -> acceso al período con el
// cliente esperado (404) -> recálculo completo (sin escribir; si cambió: 409)
// -> transacción: bloqueo de la fila Period (lockPeriodForWrite, primera
// operación; cerrado: 409 PERIOD_CLOSED) -> TurIVA y duplicidad releídas bajo
// ese bloqueo -> comprobantes y líneas (source IMPORT) + un AuditLog
// invoice.import con conteos y huellas de los archivos.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const parsed = parseImportRequest(await parseJsonBody(request), { requireToken: true });
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const input = parsed.data;

    const access = await requirePeriodAccess(profileId, id, ROLES_CREATE, { expectClientId: input.clientId });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const scope = { organizationId, periodId: access.period.id, clientId: access.period.clientId };
    const files = { category: input.category, format: input.format, vouchers: input.vouchers, aliquots: input.aliquots };

    const plan = await planConfirm(scope, files, { token: input.token as string, acceptPartial: input.acceptPartial });
    const data = importWriteData(plan, scope, profileId);

    await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, scope.periodId, organizationId);
        if (plan.result.turiva > 0) await assertTurivaIncludedUnderLock(tx, scope.periodId, organizationId);
        // Otra carga del mismo comprobante entre la vista previa y este bloqueo.
        const loaded = await importedVoucherKeys(tx, scope, files.category);
        if (plan.rows.some((r) => loaded.has(r.key))) throw new ConflictError(STALE_PREVIEW_MESSAGE);
        await tx.invoice.createMany({ data: data.invoices });
        if (data.vatLines.length > 0) await tx.invoiceVatLine.createMany({ data: data.vatLines });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "invoice.import",
            targetType: "Period",
            targetId: scope.periodId,
            metadata: importAuditMetadata(plan, scope),
        });
    }, { maxWait: 5000, timeout: 10000 }).catch((err: unknown) => {
        // Carrera con un alta sobre los índices únicos parciales.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ConflictError(STALE_PREVIEW_MESSAGE);
        throw err;
    });

    return NextResponse.json(plan.result, { status: 201 });
});
