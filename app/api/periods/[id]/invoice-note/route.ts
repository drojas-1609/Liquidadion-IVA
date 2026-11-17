import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { recordAudit } from "@/lib/auth/audit";
import { parseJsonBody, requireAuthenticatedProfile, requirePeriodAccess, resolveActiveOrganization, withApiAuthz } from "@/lib/auth/authz";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { lockPeriodForWrite } from "@/lib/period-lock";

/** Largo máximo de la nota del papel de trabajo (columna VARCHAR(500)). */
const NOTE_MAX = 500;

/**
 * Nota del papel de trabajo de un comprobante (venta o compra) del período:
 * aclaraciones del control del comprobante físico. No se informa a ARCA ni
 * cambia importes; se exporta en las hojas de detalle del Excel. Texto vacío:
 * borra la nota. Sin datos de la nota en la auditoría (sólo si hay o no).
 */
export const PATCH = withApiAuthz(async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    const { period } = await requirePeriodAccess(profileId, id, ROLES_UPDATE);
    if (period.organizationId !== organizationId) throw new NotFoundError();

    const body = await parseJsonBody(request) as Record<string, unknown> | null;
    const invoiceId = typeof body?.invoiceId === "string" ? body.invoiceId : "";
    const raw = typeof body?.note === "string" ? body.note.replace(/\r\n/g, "\n").trim() : null;
    if (raw === null) throw new ValidationError("Ingresá la nota (texto)", "note");
    if (raw.length > NOTE_MAX) throw new ValidationError(`La nota admite hasta ${NOTE_MAX} caracteres`, "note");
    const note = raw === "" ? null : raw;

    const saved = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, periodId: id, organizationId }, select: { updatedAt: true } });
        if (!invoice) throw new NotFoundError();
        if (invoice.updatedAt.toISOString() !== body?.updatedAt) throw new ConflictError("El comprobante cambió. Recargá la página antes de guardar.");
        const updated = await tx.invoice.update({ where: { id: invoiceId }, data: { workNote: note, updatedById: profileId }, select: { workNote: true, updatedAt: true } });
        await recordAudit(tx, {
            organizationId, actorProfileId: profileId, action: "invoice.note_change",
            targetType: "Invoice", targetId: invoiceId, metadata: { periodId: id, hasNote: note !== null },
        });
        return updated;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json({ note: saved.workNote, updatedAt: saved.updatedAt.toISOString() });
});
