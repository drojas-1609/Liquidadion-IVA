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
import {
    appliedResult,
    findImportOperation,
    importAuditMetadata,
    importedVoucherKeys,
    importWriteData,
    OPERATION_REUSED_MESSAGE,
    planConfirm,
    settleDeletedImports,
    assertNoSalesRangeConflictsUnderLock,
    recordImportFailure,
    sameOperation,
    STALE_PREVIEW_MESSAGE,
} from "@/lib/libro-iva-import/service";
import { startConfirmTiming } from "@/lib/libro-iva-import/timing";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/periods/[id]/libro-iva-import/confirm — escribe los comprobantes OK
// de la vista previa. Recibe los MISMOS archivos, el token de la vista previa y
// el operationId que generó el navegador para esta confirmación.
// Orden: auth -> organización -> rol -> parseo -> acceso al período con el
// cliente esperado (404) -> ¿operationId ya aplicado? (devuelve ese resultado,
// sin escribir) -> recálculo completo (sin escribir; si cambió: 409)
// -> transacción: bloqueo de la fila Period (lockPeriodForWrite, primera
// operación; cerrado: 409 PERIOD_CLOSED) -> operationId, TurIVA y duplicidad
// releídos bajo ese bloqueo -> comprobantes y líneas (source IMPORT) + un
// AuditLog invoice.import con conteos, huellas y operationId. Si algo falla
// después del acceso, se registra invoice.import.failed (ya revertido).
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const parsed = parseImportRequest(await parseJsonBody(request), { requireToken: true });
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const input = parsed.data;
    const operationId = input.operationId as string;

    const access = await requirePeriodAccess(profileId, id, ROLES_CREATE, { expectClientId: input.clientId });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const scope = { organizationId, periodId: access.period.id, clientId: access.period.clientId };
    const files = { category: input.category, format: input.format, vouchers: input.vouchers, aliquots: input.aliquots, reimportDeleted: input.reimportDeleted };

    // Reintento de una operación que ya se aplicó (p. ej. la respuesta se cortó).
    const prior = await findImportOperation(prisma, scope, operationId);
    if (prior.meta) {
        if (!sameOperation(prior.meta, files)) throw new ConflictError(OPERATION_REUSED_MESSAGE);
        return NextResponse.json({ ...appliedResult(prior.meta), operationId, replayed: true }, { status: 200 });
    }

    const timing = startConfirmTiming(request, operationId);
    try {
        const plan = await planConfirm(scope, files, { token: input.token as string, acceptPartial: input.acceptPartial });
        const data = importWriteData(plan, scope, profileId);
        timing.mark("plan", { rows: data.invoices.length, vatLines: data.vatLines.length });

        // timeout 40000: excepción inventariada (tests/_period-lock-structure.ts,
        // HANDLER_TX_TIMEOUT_OVERRIDES). El volumen de escritura no entra en 10 s
        // con la latencia de la Preview; el total queda bajo los 60 s de Netlify.
        const replay = await prisma.$transaction(async (tx) => {
            await lockPeriodForWrite(tx, scope.periodId, organizationId);
            // La misma operación confirmada en paralelo (doble envío tras un corte).
            const same = await findImportOperation(tx, scope, operationId);
            if (same.meta) return same.meta;
            if (plan.result.turiva > 0) await assertTurivaIncludedUnderLock(tx, scope.periodId, organizationId);
            // Otra carga del mismo comprobante entre la vista previa y este bloqueo.
            const loaded = await importedVoucherKeys(tx, scope, files.category);
            if (plan.rows.some((r) => loaded.has(r.key))) throw new ConflictError(STALE_PREVIEW_MESSAGE);
            // Importados eliminados de la app: releídos bajo el bloqueo.
            await settleDeletedImports(tx, scope, plan);
            // Ventas: rangos de venta global diaria cargados después de la vista previa.
            await assertNoSalesRangeConflictsUnderLock(tx, scope, plan);
            timing.mark("lock");
            await tx.invoice.createMany({ data: data.invoices });
            if (data.vatLines.length > 0) await tx.invoiceVatLine.createMany({ data: data.vatLines });
            timing.mark("write");
            await recordAudit(tx, {
                organizationId,
                actorProfileId: profileId,
                action: "invoice.import",
                targetType: "Period",
                targetId: scope.periodId,
                metadata: importAuditMetadata(plan, scope, operationId),
            });
            return null;
        }, { maxWait: 5000, timeout: 40000 }).catch((err: unknown) => {
            timing.fail(err);
            // Carrera con un alta sobre los índices únicos parciales.
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ConflictError(STALE_PREVIEW_MESSAGE);
            throw err;
        });

        if (replay) {
            if (!sameOperation(replay, files)) throw new ConflictError(OPERATION_REUSED_MESSAGE);
            return NextResponse.json({ ...appliedResult(replay), operationId, replayed: true }, { status: 200 });
        }
        return NextResponse.json({ ...plan.result, operationId }, { status: 201, headers: { "Server-Timing": timing.done() } });
    } catch (err) {
        // La transacción no empezó o ya se revirtió: nada escrito para esta operación.
        await recordImportFailure(prisma, scope, profileId, files, operationId, err, input.attemptId);
        throw err;
    }
});
