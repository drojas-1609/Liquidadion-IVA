import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_DELETE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const PERIOD_HAS_MOVEMENTS_MESSAGE =
    "El período tiene comprobantes o retenciones/percepciones y no se puede eliminar.";

function isPrismaError(err: unknown, code: string): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code;
}

// DELETE /api/periods/[id] — eliminación de un período VACÍO (OWNER / ADMIN).
//
// Orden (brief §7.1): auth -> organización -> rol -> período acotado a la
// organización activa (otra org o inexistente: MISMO 404) -> en una única
// transacción: conteo de Invoice/TaxRecord (409 si hay alguno, sin borrar ni
// auditar) -> borrado + AuditLog period.delete. Si falla el AuditLog, rollback.
//
// Un movimiento creado en paralelo hace fallar la FK Restrict (P2003) -> 409.
export const DELETE = withApiAuthz(async (_request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_DELETE);

    try {
        await prisma.$transaction(async (tx) => {
            const period = await tx.period.findFirst({ where: { id, organizationId } });
            if (!period) throw new NotFoundError();

            const [invoices, taxRecords] = await Promise.all([
                tx.invoice.count({ where: { periodId: id, organizationId } }),
                tx.taxRecord.count({ where: { periodId: id, organizationId } }),
            ]);
            if (invoices > 0 || taxRecords > 0) throw new ConflictError(PERIOD_HAS_MOVEMENTS_MESSAGE);

            await tx.period.delete({ where: { id_organizationId: { id, organizationId } } });
            await recordAudit(tx, {
                organizationId,
                actorProfileId: profileId,
                action: "period.delete",
                targetType: "Period",
                targetId: id,
                metadata: { clientId: period.clientId, month: period.month, year: period.year },
            });
        });
    } catch (err) {
        if (isPrismaError(err, "P2003")) throw new ConflictError(PERIOD_HAS_MOVEMENTS_MESSAGE);
        if (isPrismaError(err, "P2025")) throw new NotFoundError();
        throw err;
    }
    return new NextResponse(null, { status: 204 });
});
