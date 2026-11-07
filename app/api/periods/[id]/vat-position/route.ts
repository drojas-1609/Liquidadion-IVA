import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildVatPositionInput } from "@/lib/vat-position-input";
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
import { NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/periods/[id]/vat-position — datos de la posición de IVA que carga el
// estudio: saldo técnico a favor del período anterior (F.2051) y ajustes al
// crédito fiscal por contribuciones a la Seguridad Social (Portal IVA). Rol de
// edición (OWNER / ADMIN / ACCOUNTANT / OPERATOR), módulo IVA y cliente en el
// alcance (requirePeriodAccess).
//
// Orden: auth -> organización -> rol -> parseo -> acceso al período (otra org,
// fuera del alcance o inexistente: MISMO 404) -> en una única transacción:
// lockPeriodForWrite (cerrado: 409) -> lectura -> sin cambios: 200 sin escritura
// ni AuditLog -> reemplazo total + AuditLog period.vat_position_change (sólo
// nombres de campo y regímenes; nunca importes ni referencias).
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const body = await parseJsonBody(request);
    const parsed = buildVatPositionInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);

    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const next = parsed.data;
    const where = { periodId_organizationId: { periodId: id, organizationId } };

    const changed = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);

        const settings = await tx.periodVatSettings.findUnique({
            where,
            select: { previousTechnicalBalance: true, previousTechnicalBalanceReference: true, previousFreeBalance: true, previousFreeBalanceReference: true },
        });
        const current = await tx.periodVatCreditAdjustment.findMany({
            where: { periodId: id, organizationId },
            select: { regime: true, contributionsAmount: true, computableAmount: true, reference: true },
            orderBy: { regime: "asc" },
        });

        const changedFields: string[] = [];
        const prevBefore = settings?.previousTechnicalBalance ?? null;
        if (prevBefore === null ? !next.previousTechnicalBalance.isZero() : !prevBefore.equals(next.previousTechnicalBalance)) {
            changedFields.push("previousTechnicalBalance");
        }
        if ((settings?.previousTechnicalBalanceReference ?? null) !== next.previousTechnicalBalanceReference) {
            changedFields.push("previousTechnicalBalanceReference");
        }
        const free = next.previousFreeBalance;
        if (free) {
            const freeBefore = settings?.previousFreeBalance ?? null;
            if (freeBefore === null ? !free.amount.isZero() : !freeBefore.equals(free.amount)) changedFields.push("previousFreeBalance");
            if ((settings?.previousFreeBalanceReference ?? null) !== free.reference) changedFields.push("previousFreeBalanceReference");
        }
        const same = (a: (typeof current)[number] | undefined, b: (typeof next.adjustments)[number] | undefined) =>
            a !== undefined && b !== undefined &&
            a.contributionsAmount.equals(b.contributionsAmount) && a.computableAmount.equals(b.computableAmount) &&
            (a.reference ?? null) === b.reference;
        for (const regime of ["LEY_27467_ART_91", "LEY_27541_ANEXO_I"] as const) {
            const a = current.find((x) => x.regime === regime);
            const b = next.adjustments.find((x) => x.regime === regime);
            if ((a || b) && !same(a, b)) changedFields.push(`adjustment.${regime}`);
        }
        if (changedFields.length === 0) return false;

        if (settings) {
            await tx.periodVatSettings.update({
                where,
                data: {
                    previousTechnicalBalance: next.previousTechnicalBalance,
                    previousTechnicalBalanceReference: next.previousTechnicalBalanceReference,
                    ...(free ? { previousFreeBalance: free.amount, previousFreeBalanceReference: free.reference } : {}),
                    updatedById: profileId,
                },
            });
        } else {
            // El resto de los campos toma los defaults del schema.
            await tx.periodVatSettings.create({
                data: {
                    periodId: id,
                    organizationId,
                    previousTechnicalBalance: next.previousTechnicalBalance,
                    previousTechnicalBalanceReference: next.previousTechnicalBalanceReference,
                    ...(free ? { previousFreeBalance: free.amount, previousFreeBalanceReference: free.reference } : {}),
                    createdById: profileId,
                    updatedById: profileId,
                },
            });
        }
        const keep = next.adjustments.map((a) => a.regime);
        await tx.periodVatCreditAdjustment.deleteMany({ where: { periodId: id, organizationId, regime: { notIn: keep } } });
        for (const a of next.adjustments) {
            await tx.periodVatCreditAdjustment.upsert({
                where: { periodId_regime: { periodId: id, regime: a.regime } },
                create: {
                    periodId: id,
                    organizationId,
                    regime: a.regime,
                    contributionsAmount: a.contributionsAmount,
                    computableAmount: a.computableAmount,
                    reference: a.reference,
                    createdById: profileId,
                    updatedById: profileId,
                },
                update: {
                    contributionsAmount: a.contributionsAmount,
                    computableAmount: a.computableAmount,
                    reference: a.reference,
                    updatedById: profileId,
                },
            });
        }
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "period.vat_position_change",
            targetType: "Period",
            targetId: id,
            metadata: {
                changedFields: changedFields.join(","),
                regimesBefore: current.map((a) => a.regime).join(","),
                regimesAfter: keep.join(","),
            },
        });
        return true;
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ periodId: id, changed }, { status: 200 });
});
