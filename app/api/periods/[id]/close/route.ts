import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildPeriodTransitionInput } from "@/lib/api-input";
import { lockPeriodForStatusChange } from "@/lib/period-lock";
import { nextPeriodUpdatedAt, PERIOD_STALE_MESSAGE } from "@/lib/period-status";
import { closeSnapshot } from "@/lib/vat-export/service";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_PERIOD_CLOSE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/periods/[id]/close — cierre del período (OWNER / ADMIN / ACCOUNTANT / OPERATOR).
//
// Orden: auth -> organización -> rol -> parseo (400) -> expectedUpdatedAt
// (422) -> acceso al período (otra org o inexistente: MISMO 404) -> en una
// única transacción: bloqueo de la fila Period con lockPeriodForStatusChange
// (el MISMO FOR UPDATE que toman todas las escrituras del contenido; 404 /
// 409 PERIOD_BUSY) -> relectura bajo el bloqueo -> updatedAt distinto del que
// vio la pantalla: 409 CONFLICT sin escribir ni auditar -> ya cerrado: 200
// sin escritura ni AuditLog -> versión cerrada de la liquidación (el período se
// carga BAJO el bloqueo: ninguna edición ni importación se intercala) con su
// paquete de presentación si no hay bloqueos de exportación -> status CLOSED +
// closedAt + closedById + nueva versión (updatedAt) + AuditLog period.close.
// Si falla cualquier paso, rollback completo.
//
// No exige que la liquidación sea calculable ni exportable: con bloqueos, la
// versión se guarda sin paquete y la respuesta lo informa (packageReady=false).
// Transacción de 40000 ms (excepción inventariada en
// tests/_period-lock-structure.ts): carga el período en lotes y arma el paquete.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_PERIOD_CLOSE);

    const body = await parseJsonBody(request);
    const parsed = buildPeriodTransitionInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const access = await requirePeriodAccess(profileId, id, ROLES_PERIOD_CLOSE);
    // Defensa en profundidad: el período debe ser de la organización ACTIVA.
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const result = await prisma.$transaction(async (tx) => {
        const status = await lockPeriodForStatusChange(tx, id, organizationId);
        const period = await tx.period.findFirst({
            where: { id, organizationId },
            select: { clientId: true, month: true, year: true, updatedAt: true },
        });
        if (!period) throw new NotFoundError();
        if (period.updatedAt.getTime() !== parsed.data.expectedUpdatedAt.getTime()) {
            throw new ConflictError(PERIOD_STALE_MESSAGE);
        }
        if (status === "CLOSED") {
            const current = await tx.periodLiquidationVersion.findFirst({
                where: { periodId: id, organizationId, supersededAt: null },
                select: { version: true, packageSha256: true },
            });
            return { status, updatedAt: period.updatedAt, version: current?.version ?? null, packageReady: Boolean(current?.packageSha256) };
        }

        const now = new Date();
        const last = await tx.periodLiquidationVersion.findFirst({
            where: { periodId: id, organizationId },
            orderBy: { version: "desc" },
            select: { version: true },
        });
        const version = (last?.version ?? 0) + 1;
        const snap = await closeSnapshot(tx, { organizationId, periodId: id }, version, now);
        if (!snap) throw new NotFoundError();
        await tx.periodLiquidationVersion.create({
            data: {
                organizationId,
                periodId: id,
                version,
                closedAt: now,
                closedById: profileId,
                engineVersion: snap.summary.engineVersion,
                contentHash: snap.contentHash,
                summary: JSON.parse(JSON.stringify(snap.summary)),
                packageZip: snap.packageZip ? Buffer.from(snap.packageZip) : null,
                packageSha256: snap.packageSha256,
            },
            select: { id: true },
        });
        const updated = await tx.period.update({
            where: { id_organizationId: { id, organizationId } },
            data: {
                status: "CLOSED",
                closedAt: now,
                closedById: profileId,
                updatedById: profileId,
                updatedAt: nextPeriodUpdatedAt(period.updatedAt, now),
            },
            select: { status: true, updatedAt: true },
        });
        const packageReady = snap.packageZip !== null;
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "period.close",
            targetType: "Period",
            targetId: id,
            metadata: { clientId: period.clientId, month: period.month, year: period.year, version, packageReady },
        });
        return { ...updated, version, packageReady };
    }, { maxWait: 5000, timeout: 40000 });

    return NextResponse.json(
        { periodId: id, status: result.status, updatedAt: result.updatedAt.toISOString(), version: result.version, packageReady: result.packageReady },
        { status: 200 },
    );
});
