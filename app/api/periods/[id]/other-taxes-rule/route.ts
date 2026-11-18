import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { recordAudit } from "@/lib/auth/audit";
import { parseJsonBody, requireAuthenticatedProfile, requirePeriodAccess, resolveActiveOrganization, withApiAuthz } from "@/lib/auth/authz";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { OTHER_TAXES_KINDS, reconcileInvoicePerceptions, type OtherTaxesKind } from "@/lib/invoice-perceptions";

/**
 * Regla por proveedor para «Otros tributos» de las compras del cliente: guarda
 * la regla (vale para este y los próximos períodos) y vuelve a conciliar el
 * período: separa la percepción de IVA informada por ARCA y pasa el resto a
 * percepción de IIBB o impuestos internos según la regla (lib/invoice-perceptions).
 */
export const PUT = withApiAuthz(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const { period } = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (period.organizationId !== organizationId) throw new NotFoundError();

    const body = await parseJsonBody(request) as Record<string, unknown> | null;
    const supplierCuit = typeof body?.supplierCuit === "string" ? body.supplierCuit.replace(/\D/g, "") : "";
    if (!/^\d{11}$/.test(supplierCuit)) throw new ValidationError("CUIT del proveedor inválido", "supplierCuit");
    const kind = body?.kind;
    if (typeof kind !== "string" || !(OTHER_TAXES_KINDS as readonly string[]).includes(kind)) throw new ValidationError("Elegí cómo se imputa el resto", "kind");

    const result = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const scope = { organizationId, clientId: period.clientId, supplierCuit };
        await tx.supplierOtherTaxesRule.upsert({
            where: { organizationId_clientId_supplierCuit: scope },
            create: { ...scope, kind: kind as OtherTaxesKind },
            update: { kind: kind as OtherTaxesKind },
        });
        const { changes: count, pending } = await reconcileInvoicePerceptions(tx, { organizationId, periodId: id, clientId: period.clientId, profileId });
        await recordAudit(tx, {
            organizationId, actorProfileId: profileId, action: "supplier.other_taxes_rule",
            targetType: "Period", targetId: id, metadata: { periodId: id, kind, changes: count },
        });
        return { changes: count, pending };
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json(result);
});
