import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { buildTaxPaymentEntry, buildTaxPaymentInput } from "@/lib/accounting/journal";
import { idcbComputablePercent, type MipymeCategory } from "@/lib/accounting/profile";
import { JournalAccountError, saveJournalEntry } from "@/lib/accounting/journal-service";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/clients/[id]/journal/tax-payment — asiento del pago de IVA o IIBB
// con VEP. El porcentaje computable del impuesto a los débitos y créditos sale
// del certificado MiPyME del cliente a la fecha del pago.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const parsed = buildTaxPaymentInput(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const input = parsed.value;

    const saved = await prisma.$transaction(async (tx) => {
        const client = await tx.client.findFirst({ where: { id, organizationId }, select: { mipymeCategory: true, mipymeManufacturing: true, mipymeValidUntil: true } });
        if (!client) throw new NotFoundError();
        const idcb = idcbComputablePercent({
            mipymeCategory: client.mipymeCategory as MipymeCategory | null,
            mipymeManufacturing: client.mipymeManufacturing,
            mipymeValidUntil: client.mipymeValidUntil ? client.mipymeValidUntil.toISOString().slice(0, 10) : null,
        }, input.date);
        const draft = buildTaxPaymentEntry({ ...input, idcbPercent: idcb.percent });
        let r;
        try {
            r = await saveJournalEntry(tx, { organizationId, clientId: id, profileId }, draft, { periodId: null, sourceKey: null });
        } catch (e) {
            if (e instanceof JournalAccountError) throw new ValidationError(e.message, e.field);
            throw e;
        }
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "journal.tax_payment", targetType: "Client", targetId: id, metadata: { tax: input.tax, number: r.number, idcbPercent: idcb.percent } });
        return { ...r, idcbPercent: idcb.percent };
    });
    return NextResponse.json(saved);
});
