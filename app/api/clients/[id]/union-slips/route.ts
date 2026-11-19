import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { buildUnionPaymentEntry, buildUnionSlipEntry, buildUnionSlipInput } from "@/lib/accounting/journal";
import { JournalAccountError, saveJournalEntry } from "@/lib/accounting/journal-service";

// POST /api/clients/[id]/union-slips { periodId, union, amount, paidDate?, paymentAccountId?, reference? }
// Registra la boleta sindical con su asiento de devengamiento y, si se indica
// el pago, el asiento del pago. Requiere plan de cuentas.
export const POST = withApiAuthz(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const body = (await parseJsonBody(request)) as Record<string, unknown> | null;
    const parsed = buildUnionSlipInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const v = parsed.value;
    if (typeof body?.periodId !== "string") throw new ValidationError("Elegí el período.", "periodId");
    const periodId = body.periodId;

    const saved = await prisma.$transaction(async (tx) => {
        const period = await tx.period.findFirst({ where: { id: periodId, organizationId, clientId: id }, select: { month: true, year: true } });
        if (!period) throw new ValidationError("Período inexistente.", "periodId");
        const scope = { organizationId, clientId: id, profileId };
        try {
            const accrual = await saveJournalEntry(tx, scope, buildUnionSlipEntry({ union: v.union, amount: v.amount, month: period.month, year: period.year }), { periodId, sourceKey: null });
            const payment = v.paidDate && v.paymentAccountId
                ? await saveJournalEntry(tx, scope, buildUnionPaymentEntry({ union: v.union, amount: v.amount, date: v.paidDate, paymentAccountId: v.paymentAccountId, month: period.month, year: period.year }), { periodId, sourceKey: null })
                : null;
            const slip = await tx.payrollUnionSlip.create({
                data: {
                    organizationId, clientId: id, periodId, union: v.union, amount: v.amount,
                    paidDate: v.paidDate ? new Date(`${v.paidDate}T00:00:00.000Z`) : null, paymentAccountId: v.paymentAccountId,
                    accrualEntryId: accrual.id, paymentEntryId: payment?.id ?? null, reference: v.reference, createdById: profileId,
                },
                select: { id: true },
            });
            await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "payroll.union_slip", targetType: "Client", targetId: id, metadata: { union: v.union, paid: Boolean(payment), accrualNumber: accrual.number } });
            return { id: slip.id, accrualNumber: accrual.number, paymentNumber: payment?.number ?? null };
        } catch (e) {
            if (e instanceof JournalAccountError) throw new ValidationError(e.message, e.field);
            throw e;
        }
    });
    return NextResponse.json(saved, { status: 201 });
});
