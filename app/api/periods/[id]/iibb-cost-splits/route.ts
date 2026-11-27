import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireOrganizationRole, requirePeriodAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { invoiceNet, parseSplits } from "@/lib/iibb/provider-costs";

type Ctx = { params: Promise<{ id: string }> };

const ZERO = new Prisma.Decimal(0);
const z = (d: Prisma.Decimal | null) => d ?? ZERO;

// PUT /api/periods/[id]/iibb-cost-splits { invoiceId, splits: [{ activityCode, amount }] }
// Reparto manual de una compra a un prestador marcado entre actividades (base de
// IIBB por diferencia). Reemplaza el reparto de esa factura; lista vacía lo quita.
// La suma debe ser igual al neto de la factura. Período cerrado: 409.
export const PUT = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);
    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const body = (await parseJsonBody(request)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || typeof body.invoiceId !== "string" || !/^[a-z0-9]{10,40}$/i.test(body.invoiceId)) throw new ValidationError("comprobante inválido", "invoiceId");
    const invoiceId = body.invoiceId;

    const count = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const clientId = access.period.clientId;
        const inv = await tx.invoice.findFirst({
            where: { id: invoiceId, periodId: id, organizationId, category: "PURCHASES" },
            select: { id: true, counterpartyDocNumber: true, entityCuit: true, netAmount: true, voucherCode: true, exemptAmount: true, nonTaxedAmount: true, netWithoutVatBreakdownAmount: true, vatLines: { select: { vatRateCode: true, netAmount: true } } },
        });
        if (!inv) throw new NotFoundError();
        const cuit = inv.counterpartyDocNumber ?? (inv.entityCuit ?? "").replace(/-/g, "");
        const provider = await tx.clientIibbProvider.findFirst({ where: { clientId, organizationId, cuit }, select: { id: true } });
        if (!provider) throw new ValidationError("el proveedor de la factura no está marcado como prestador en la ficha IIBB", "invoiceId");
        const codes = new Set((await tx.clientActivity.findMany({ where: { clientId, organizationId }, select: { code: true } })).map((a) => a.code));
        const net = invoiceNet({
            id: inv.id, sign: 1, splits: [],
            vatNets: inv.vatLines.map((l) => ({ code: l.vatRateCode, net: l.netAmount })),
            exemptAndNonTaxed: z(inv.exemptAmount).plus(z(inv.nonTaxedAmount)),
            withoutVat: z(inv.netWithoutVatBreakdownAmount),
            legacyNet: inv.voucherCode === null ? inv.netAmount : null,
        }).abs();
        const parsed = parseSplits(body.splits, codes, net);
        if (!parsed.ok) throw new ValidationError(parsed.error, "splits");
        await tx.invoiceIibbCostSplit.deleteMany({ where: { invoiceId, organizationId } });
        if (parsed.value.length > 0) {
            await tx.invoiceIibbCostSplit.createMany({
                data: parsed.value.map((s) => ({ organizationId, invoiceId, activityCode: s.activityCode, amount: new Prisma.Decimal(s.amount) })),
            });
        }
        await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "invoice.iibb_cost_split", targetType: "Invoice", targetId: invoiceId, metadata: { periodId: id, count: parsed.value.length } });
        return parsed.value.length;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json({ ok: true, count });
});
