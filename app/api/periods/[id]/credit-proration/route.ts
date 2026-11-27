import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { buildCreditProrationInput, PRORATION_HAS_GLOBAL_LINES_MESSAGE, usesGlobalCoefficient } from "@/lib/credit-proration-input";
import { lockPeriodForWrite } from "@/lib/period-lock";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/periods/[id]/credit-proration { creditProrationMode, globalCoefficient?, globalCoefficientStatus? }
// Modalidad de prorrateo del crédito fiscal del período y coeficiente global
// cargado por el estudio (OWNER / ADMIN / ACCOUNTANT / OPERATOR). Escribe bajo
// el bloqueo del período; sin cambios: 200 sin escritura ni AuditLog. No toca
// turivaIncluded. Pasar a NONE / DIRECT con compras GLOBAL_PRORATION: 409.
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const body = await parseJsonBody(request);
    const parsed = buildCreditProrationInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const next = parsed.data;
    const where = { periodId_organizationId: { periodId: id, organizationId } };

    await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const current = await tx.periodVatSettings.findUnique({
            where, select: { creditProrationMode: true, globalCoefficient: true, globalCoefficientStatus: true },
        });
        const before = {
            mode: current?.creditProrationMode ?? "NONE",
            coefficient: current?.globalCoefficient ? current.globalCoefficient.toString() : null,
            status: current?.globalCoefficientStatus ?? null,
        };
        const sameCoefficient = before.coefficient === null || next.globalCoefficient === null
            ? before.coefficient === next.globalCoefficient
            : new Prisma.Decimal(before.coefficient).equals(next.globalCoefficient);
        const changed = [
            ...(before.mode !== next.creditProrationMode ? ["creditProrationMode"] : []),
            ...(!sameCoefficient ? ["globalCoefficient"] : []),
            ...(before.status !== next.globalCoefficientStatus ? ["globalCoefficientStatus"] : []),
        ];
        if (changed.length === 0) return;

        if (usesGlobalCoefficient(before.mode) && !usesGlobalCoefficient(next.creditProrationMode)) {
            const globalLines = await tx.invoiceVatLine.count({
                where: { creditAllocation: "GLOBAL_PRORATION", invoice: { periodId: id, organizationId, category: "PURCHASES" } },
            });
            if (globalLines > 0) throw new ConflictError(PRORATION_HAS_GLOBAL_LINES_MESSAGE);
        }

        const data = {
            creditProrationMode: next.creditProrationMode,
            globalCoefficient: next.globalCoefficient === null ? null : new Prisma.Decimal(next.globalCoefficient),
            globalCoefficientStatus: next.globalCoefficientStatus,
            updatedById: profileId,
        };
        if (current) await tx.periodVatSettings.update({ where, data });
        else await tx.periodVatSettings.create({ data: { ...data, periodId: id, organizationId, createdById: profileId } });

        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "period.vat_settings_change",
            targetType: "Period",
            targetId: id,
            metadata: {
                changedFields: changed.join(","),
                prorationModeBefore: before.mode, prorationModeAfter: next.creditProrationMode,
                coefficientBefore: before.coefficient, coefficientAfter: next.globalCoefficient,
                coefficientStatusBefore: before.status, coefficientStatusAfter: next.globalCoefficientStatus,
            },
        });
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ periodId: id, ...next }, { status: 200 });
});
