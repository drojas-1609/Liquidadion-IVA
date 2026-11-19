import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, requirePeriodAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { annexIZone } from "@/lib/payroll/annex-i";
import { annexICredit, buildF931Entry, buildF931Input } from "@/lib/accounting/journal";
import { JournalAccountError, saveJournalEntry } from "@/lib/accounting/journal-service";

type Ctx = { params: Promise<{ id: string }> };

// PUT /api/periods/[id]/payroll-f931 — graba el F.931 del período:
//  · crédito Anexo I Ley 27.541 = base imponible de contribuciones × puntos de
//    la zona del cliente, cargado en el ajuste de crédito fiscal del período
//    (criterio del estudio: mismo período del F.931, pagado o no);
//  · asiento «F.931 MM/AAAA» si el cliente tiene plan de cuentas.
// lockPeriodForWrite: con el período cerrado responde 409.
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);
    const parsed = buildF931Input(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const clientId = access.period.clientId;

    const result = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const period = await tx.period.findFirst({ where: { id, organizationId }, select: { month: true, year: true, client: { select: { payrollZoneCode: true } } } });
        if (!period) throw new NotFoundError();
        const zone = annexIZone(period.client.payrollZoneCode);
        if (!zone) throw new ValidationError("Definí la zona del Anexo I del cliente en Sueldos antes de cargar el F.931.", "zoneCode");
        const { contributionsBase, employerContributions, reference } = parsed.value;
        const credit = annexICredit(contributionsBase, zone.percent);
        const p = `${String(period.month).padStart(2, "0")}/${period.year}`;
        const ref = (reference ?? `F.931 ${p}`) + ` · zona ${zone.code} (${zone.percent.replace(".", ",")} %)`;
        const data = { zoneCode: zone.code, annexIPercent: zone.percent, contributionsBase, employerContributions, creditAmount: credit, reference: reference, updatedById: profileId };
        await tx.payrollF931.upsert({ where: { periodId: id }, create: { ...data, organizationId, clientId, periodId: id, createdById: profileId }, update: data });
        if (credit.isZero()) {
            await tx.periodVatCreditAdjustment.deleteMany({ where: { periodId: id, organizationId, regime: "LEY_27541_ANEXO_I" } });
        } else {
            const adj = { contributionsAmount: contributionsBase, computableAmount: credit, reference: ref.slice(0, 120), updatedById: profileId };
            await tx.periodVatCreditAdjustment.upsert({
                where: { periodId_regime: { periodId: id, regime: "LEY_27541_ANEXO_I" } },
                create: { ...adj, organizationId, periodId: id, regime: "LEY_27541_ANEXO_I", createdById: profileId },
                update: adj,
            });
        }
        let entry: { number: number; replaced: boolean } | null = null;
        const hasChart = (await tx.chartAccount.count({ where: { organizationId, clientId } })) > 0;
        if (hasChart && !(employerContributions.isZero() && credit.isZero())) {
            try {
                entry = await saveJournalEntry(tx, { organizationId, clientId, profileId }, buildF931Entry({ employerContributions, credit, month: period.month, year: period.year }), { periodId: id, sourceKey: `F931:${id}` });
            } catch (e) {
                if (e instanceof JournalAccountError) throw new ValidationError(e.message, e.field);
                throw e;
            }
        }
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "payroll.f931_save", targetType: "Period", targetId: id, metadata: { zoneCode: zone.code, entryNumber: entry?.number ?? null } });
        return { credit: credit.toFixed(2), percent: zone.percent, zoneCode: zone.code, entryNumber: entry?.number ?? null };
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json(result);
});
