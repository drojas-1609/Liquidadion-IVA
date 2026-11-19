import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, requireClientAccess, parseJsonBody, withApiAuthz } from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { MODULES_CLIENT_DIRECTORY } from "@/lib/auth/permissions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";
import { buildSubaccountCreate, nextSubaccountCode } from "@/lib/accounting/chart-input";
import { isImputableCode } from "@/lib/accounting/chart-models";

type Ctx = { params: Promise<{ id: string; accountId: string }> };

// POST /api/clients/[id]/accounts/[accountId]/subaccounts { name, moveLines? }
// Agrega una subcuenta («madre.01», «madre.02»…) a una cuenta «C.RR.CC.SS».
// La primera subcuenta convierte a la madre en cuenta de agrupación (no
// imputable) y hereda su uso automático. Si la madre ya tiene movimientos, se
// pide confirmación (moveLines: true) para pasarlos a la nueva subcuenta; los
// movimientos de períodos cerrados no se tocan (409).
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id, accountId } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const access = await requireClientAccess(profileId, id, ROLES_UPDATE, { module: MODULES_CLIENT_DIRECTORY });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const parsed = buildSubaccountCreate(await parseJsonBody(request));
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const { name, moveLines } = parsed.value;

    const created = await prisma.$transaction(
        async (tx) => {
            const parent = await tx.chartAccount.findFirst({ where: { id: accountId, clientId: id, organizationId } });
            if (!parent) throw new NotFoundError();
            if (!isImputableCode(parent.code)) throw new ValidationError("sólo se agregan subcuentas a una cuenta de cuatro niveles (p. ej. 1.01.02.01)", "accountId");
            if (!parent.active) throw new ValidationError("la cuenta madre está inactiva: activala antes de agregar subcuentas", "accountId");
            const siblings = await tx.chartAccount.findMany({ where: { clientId: id, organizationId, code: { startsWith: `${parent.code}.` } }, select: { code: true } });
            const code = nextSubaccountCode(parent.code, siblings.map((s) => s.code));
            if (!code) throw new ConflictError("la cuenta ya tiene el máximo de 99 subcuentas");
            const first = siblings.length === 0;

            // Movimientos de la madre: sólo existen si todavía era imputable (primera subcuenta).
            let movedLines = 0;
            if (first) {
                const lines = await tx.journalLine.findMany({ where: { accountId: parent.id, organizationId }, select: { id: true, entry: { select: { periodId: true } } } });
                if (lines.length > 0) {
                    if (!moveLines) {
                        throw new ConflictError(`«${parent.name}» tiene ${lines.length} movimiento(s) en el libro diario: confirmá pasarlos a la nueva subcuenta`);
                    }
                    const periodIds = [...new Set(lines.map((l) => l.entry.periodId).filter((p): p is string => !!p))];
                    const closed = periodIds.length ? await tx.period.count({ where: { id: { in: periodIds }, organizationId, status: "CLOSED" } }) : 0;
                    if (closed > 0) throw new ConflictError("hay movimientos de períodos cerrados en esta cuenta: reabrí esos períodos para poder pasarlos a la subcuenta");
                }
                const row = await tx.chartAccount.create({
                    data: { organizationId, clientId: id, code, name, imputable: true, role: null, createdById: profileId, updatedById: profileId },
                });
                if (lines.length > 0) {
                    movedLines = (await tx.journalLine.updateMany({ where: { accountId: parent.id, organizationId }, data: { accountId: row.id } })).count;
                    await tx.payrollUnionSlip.updateMany({ where: { paymentAccountId: parent.id, organizationId }, data: { paymentAccountId: row.id } });
                }
                // La madre pasa a agrupar; su uso automático (si tenía) sigue en la primera subcuenta.
                await tx.chartAccount.update({ where: { id: parent.id }, data: { imputable: false, role: null, updatedById: profileId } });
                if (parent.role) await tx.chartAccount.update({ where: { id: row.id }, data: { role: parent.role } });
                await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "chart.subaccount_create", targetType: "Client", targetId: id, metadata: { code, parentCode: parent.code, role: parent.role, movedLines } });
                return row;
            }
            const row = await tx.chartAccount.create({
                data: { organizationId, clientId: id, code, name, imputable: true, role: null, createdById: profileId, updatedById: profileId },
            });
            await recordAudit(tx, { organizationId, actorProfileId: profileId, action: "chart.subaccount_create", targetType: "Client", targetId: id, metadata: { code, parentCode: parent.code, role: null, movedLines } });
            return row;
        },
    );
    return NextResponse.json({ id: created.id, code: created.code }, { status: 201 });
});
