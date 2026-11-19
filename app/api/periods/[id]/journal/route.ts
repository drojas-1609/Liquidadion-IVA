import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, requirePeriodAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { MissingGlobalProrationCoefficientError } from "@/lib/invoice-model";
import { UnbalancedEntryError } from "@/lib/accounting/journal";
import { JournalAccountError, buildPeriodEntry, periodSourceKey, saveJournalEntry } from "@/lib/accounting/journal-service";

type Ctx = { params: Promise<{ id: string }> };
const KINDS = ["VAT_POSITION", "IIBB_POSITION"] as const;
type Kind = (typeof KINDS)[number];

// POST /api/periods/[id]/journal { kind } — genera (o regenera) el asiento de
// cierre de IVA o de la DDJJ de IIBB del período con la liquidación vigente.
// El libro diario no es contenido del período: se puede registrar cerrado.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);
    const body = await parseJsonBody(request);
    const kind = (body as { kind?: unknown } | null)?.kind;
    if (!KINDS.includes(kind as Kind)) throw new ValidationError("Asiento desconocido.", "kind");
    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const clientId = access.period.clientId;

    const saved = await prisma.$transaction(async (tx) => {
        const period = await tx.period.findFirst({ where: { id, organizationId }, select: { month: true, year: true } });
        if (!period) throw new NotFoundError();
        let draft;
        try {
            draft = await buildPeriodEntry(tx, { organizationId, periodId: id }, kind as Kind, period);
        } catch (e) {
            if (e instanceof MissingGlobalProrationCoefficientError) throw new ValidationError("Falta el coeficiente de prorrateo del crédito fiscal en la liquidación.", "kind");
            if (e instanceof UnbalancedEntryError) throw new ValidationError(e.message, "kind");
            throw e;
        }
        if (!draft) throw new NotFoundError();
        if (draft.lines.length === 0) throw new ValidationError("La liquidación no tiene importes para registrar.", "kind");
        let r;
        try {
            r = await saveJournalEntry(tx, { organizationId, clientId, profileId }, draft, { periodId: id, sourceKey: periodSourceKey(kind as Kind, id) });
        } catch (e) {
            if (e instanceof JournalAccountError) throw new ValidationError(e.message, e.field);
            throw e;
        }
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "journal.entry_generate", targetType: "Period", targetId: id, metadata: { kind: kind as string, number: r.number, replaced: r.replaced } });
        return r;
    });
    return NextResponse.json(saved);
});
