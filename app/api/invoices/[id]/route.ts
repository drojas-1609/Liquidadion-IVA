import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { buildInvoiceUpdateInput, parseExpectedUpdatedAt } from "@/lib/api-input";
import {
    assertNoDuplicateVoucher,
    assertTurivaIncludedUnderLock,
    findDuplicateVoucherPeriod,
    manualInvoiceColumns,
    manualInvoiceVatLines,
    prepareManualInvoice,
} from "@/lib/invoice-write";
import {
    INVOICE_NOT_EDITABLE_MESSAGES,
    changedFieldsOf,
    invoiceDeletability,
    invoiceEditability,
    type EditableInvoiceRow,
} from "@/lib/invoice-edit";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { lockInvoiceForUpdate, type LockedInvoiceRow } from "@/lib/invoice-lock";
import { duplicateVoucherMessage } from "@/lib/invoice-rules";
import { serializeInvoice } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_DELETE, ROLES_UPDATE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const STALE_MESSAGE = "El comprobante fue modificado por otra persona. Volvé a abrirlo para ver los datos actuales.";
const IMMUTABLE_MESSAGE = {
    category: "No se puede cambiar la categoría (venta/compra) de un comprobante: eliminalo y cargalo de nuevo.",
    periodId: "No se puede cambiar el período de un comprobante: eliminalo y cargalo en el período correcto.",
} as const;

/** Columnas que se leen antes de la transacción (corte temprano). */
const PRELOAD_SELECT = {
    id: true,
    periodId: true,
    clientId: true,
    category: true,
    source: true,
    voucherCode: true,
    voucherDate: true,
    pointOfSale: true,
    number: true,
    counterpartyDocType: true,
    counterpartyDocNumber: true,
    counterpartyName: true,
    counterpartyVatConditionCode: true,
    voucherVariant: true,
    turivaRelationCode: true,
    taxedNetAmount: true,
    netWithoutVatBreakdownAmount: true,
    vatLines: { select: { vatRateCode: true } },
} as const;

function editableRowOf(
    r: Omit<EditableInvoiceRow, "vatRateCodes"> & { source: string | null },
    vatRateCodes: readonly number[],
): EditableInvoiceRow {
    return { ...r, vatRateCodes };
}

async function lockedRowWithLines(
    tx: Prisma.TransactionClient,
    id: string,
    organizationId: string,
): Promise<{ locked: LockedInvoiceRow; row: EditableInvoiceRow } | null> {
    const locked = await lockInvoiceForUpdate(tx, id, organizationId);
    if (!locked) return null;
    const lines = await tx.invoiceVatLine.findMany({
        where: { invoiceId: id, organizationId },
        select: { vatRateCode: true },
    });
    return { locked, row: editableRowOf(locked, lines.map((l) => l.vatRateCode)) };
}

const notEditable = (reason: keyof typeof INVOICE_NOT_EDITABLE_MESSAGES) =>
    new ValidationError(INVOICE_NOT_EDITABLE_MESSAGES[reason], "invoice");

// PATCH /api/invoices/[id] — corrección de un comprobante MANUAL (OWNER /
// ADMIN / ACCOUNTANT).
//
// Orden: auth -> organización -> rol -> parseo (400) -> contrato v2 completo +
// expectedUpdatedAt (422) -> comprobante por id + organización (404) -> acceso
// al período de la organización activa (404) -> editabilidad (422) ->
// inmutables (422) -> MISMA preparación que el alta (lib/invoice-write) ->
// duplicidad excluyendo el propio comprobante (409) -> transacción:
//   lock Period (lockPeriodForWrite) -> lock Invoice (fila bloqueada) ->
//   updatedAt exacto (409) -> editabilidad e inmutables sobre la fila
//   bloqueada (422) -> TurIVA releído bajo el lock del Period, sin volver a
//   bloquearlo (422) -> changedFields desde la fila bloqueada (vacío: 200 sin
//   escritura ni AuditLog) -> update + líneas + AuditLog.
// P2002 (carrera con otra alta/edición) -> 409 con el período.
export const PATCH = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const body = await parseJsonBody(request);
    const parsed = buildInvoiceUpdateInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const input = parsed.data;

    const current = await prisma.invoice.findFirst({ where: { id, organizationId }, select: PRELOAD_SELECT });
    if (!current) throw new NotFoundError();

    const access = await requirePeriodAccess(profileId, current.periodId, ROLES_UPDATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const periodId = access.period.id;
    const clientId = access.period.clientId;

    const pre = invoiceEditability(editableRowOf(current, current.vatLines.map((l) => l.vatRateCode)));
    if (!pre.ok) throw notEditable(pre.reason);
    if (input.category !== current.category) throw new ValidationError(IMMUTABLE_MESSAGE.category, "category");
    if (input.periodId !== current.periodId) throw new ValidationError(IMMUTABLE_MESSAGE.periodId, "periodId");

    const plan = await prepareManualInvoice({ organizationId, periodId, clientId, input, excludeInvoiceId: id });
    const { resolved } = plan;
    await assertNoDuplicateVoucher(plan.duplicateWhere);

    const saved = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, periodId, organizationId);
        const lockedRow = await lockedRowWithLines(tx, id, organizationId);
        if (!lockedRow) throw new NotFoundError();
        const { locked, row } = lockedRow;

        if (locked.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) throw new ConflictError(STALE_MESSAGE);

        const editability = invoiceEditability(row);
        if (!editability.ok) throw notEditable(editability.reason);
        if (locked.category !== input.category) throw new ValidationError(IMMUTABLE_MESSAGE.category, "category");
        if (locked.periodId !== periodId || locked.clientId !== clientId) {
            throw new ValidationError(IMMUTABLE_MESSAGE.periodId, "periodId");
        }

        if (resolved.requiresTurivaSection) {
            // Relectura bajo el bloqueo del Period ya tomado al inicio de la
            // transacción (el helper no vuelve a bloquear).
            await assertTurivaIncludedUnderLock(tx, periodId, organizationId);
        }

        const changed = changedFieldsOf(row, { input, resolved });
        if (changed.length === 0) {
            // Sin cambios: 200 sin escritura ni AuditLog.
            const unchanged = await tx.invoice.findFirst({ where: { id, organizationId } });
            if (!unchanged) throw new NotFoundError();
            return unchanged;
        }

        const updated = await tx.invoice.update({
            where: { id_organizationId: { id, organizationId } },
            data: {
                ...manualInvoiceColumns({ input, resolved, periodId, organizationId, clientId }),
                updatedById: profileId,
                vatLines: { deleteMany: {}, create: manualInvoiceVatLines(resolved.model) },
            },
        });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "invoice.update",
            targetType: "Invoice",
            targetId: id,
            // Identificación del comprobante (antes: fila bloqueada; después:
            // normalizado por el servidor). Nunca importes, alícuotas, CUIT,
            // documento ni nombre.
            metadata: {
                periodId: locked.periodId,
                category: locked.category,
                voucherCodeBefore: locked.voucherCode,
                voucherCodeAfter: resolved.model.voucherCode,
                pointOfSaleBefore: locked.pointOfSale,
                pointOfSaleAfter: input.pointOfSale,
                numberBefore: locked.number,
                numberAfter: input.number,
                changedFields: changed.join(","),
            },
        });
        return updated;
    }).catch(async (err: unknown) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            const racing = await findDuplicateVoucherPeriod(plan.duplicateWhere);
            if (racing) throw new ConflictError(duplicateVoucherMessage(racing));
        }
        throw err;
    });

    return NextResponse.json(
        {
            ...serializeInvoice(saved),
            // Token de concurrencia para la siguiente edición (escritura o no-op):
            // el updatedAt exacto de la fila que quedó confirmada.
            updatedAt: saved.updatedAt.toISOString(),
            warnings: plan.warnings,
            legalClass: resolved.legalClass,
            mandatoryLegend: resolved.mandatoryLegend,
            partialValidation: resolved.partialValidation,
            requiresTurivaSection: resolved.requiresTurivaSection,
        },
        { status: 200 },
    );
});

// DELETE /api/invoices/[id]?expectedUpdatedAt=<ISO> — baja de un comprobante
// MANUAL (OWNER / ADMIN).
//
// Orden: auth -> organización -> rol -> expectedUpdatedAt (422) -> comprobante
// por id + organización (404) -> acceso al período (404) -> eliminabilidad
// (422) -> transacción: lock Period (lockPeriodForWrite) -> lock Invoice ->
// updatedAt exacto (409) -> eliminabilidad sobre la fila bloqueada (422) ->
// borrado de líneas y comprobante + AuditLog invoice.delete. Si falla el
// AuditLog, rollback total.
export const DELETE = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_DELETE);

    const expected = parseExpectedUpdatedAt(new URL(request.url).searchParams.get("expectedUpdatedAt"));
    if (!expected.ok) throw new ValidationError(expected.error, expected.field);

    const current = await prisma.invoice.findFirst({
        where: { id, organizationId },
        select: { id: true, periodId: true, source: true, voucherCode: true, vatLines: { select: { vatRateCode: true } } },
    });
    if (!current) throw new NotFoundError();

    const access = await requirePeriodAccess(profileId, current.periodId, ROLES_DELETE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const periodId = access.period.id;

    const pre = invoiceDeletability({
        source: current.source,
        voucherCode: current.voucherCode,
        vatRateCodes: current.vatLines.map((l) => l.vatRateCode),
    });
    if (!pre.ok) throw notEditable(pre.reason);

    await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, periodId, organizationId);
        const lockedRow = await lockedRowWithLines(tx, id, organizationId);
        if (!lockedRow) throw new NotFoundError();
        const { locked, row } = lockedRow;

        if (locked.updatedAt.getTime() !== expected.data.getTime()) throw new ConflictError(STALE_MESSAGE);
        const deletability = invoiceDeletability(row);
        if (!deletability.ok) throw notEditable(deletability.reason);

        const lines = await tx.invoiceVatLine.deleteMany({ where: { invoiceId: id, organizationId } });
        if (lines.count !== row.vatRateCodes.length) {
            throw new Error(`baja de comprobante: se esperaban ${row.vatRateCodes.length} líneas de IVA y se borraron ${lines.count}`);
        }
        await tx.invoice.delete({ where: { id_organizationId: { id, organizationId } } });
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "invoice.delete",
            targetType: "Invoice",
            targetId: id,
            // Todo de la fila bloqueada. Nunca importes, alícuotas, CUIT, documento ni nombre.
            metadata: {
                periodId: locked.periodId,
                category: locked.category,
                voucherCode: locked.voucherCode,
                pointOfSale: locked.pointOfSale,
                number: locked.number,
            },
        });
    });

    return new NextResponse(null, { status: 204 });
});
