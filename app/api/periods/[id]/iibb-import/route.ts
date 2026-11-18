import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { lockClientTaxIdentity } from "@/lib/tax-identity";
import { buildIibbImportPreview, iibbImportDescription, registeredIibbDeductions, type IibbImportPreview } from "@/lib/iibb-import/service";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";

type Ctx = { params: Promise<{ id: string }> };

const MAX_BYTES = 512 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decode(v: unknown): Uint8Array {
    if (typeof v !== "string" || v.length === 0 || v.length % 4 !== 0 || !BASE64_RE.test(v)) throw new ValidationError("archivo requerido (base64)", "file");
    const bytes = Uint8Array.from(Buffer.from(v, "base64"));
    if (bytes.length > MAX_BYTES) throw new ValidationError("archivo demasiado grande (máximo 512 KB)", "file");
    return bytes;
}

// POST /api/periods/[id]/iibb-import — retenciones, percepciones y recaudaciones
// bancarias de IIBB informadas por el fisco (e-SICOL / Rentas Ciudad de AGIP,
// Santa Cruz; lib/iibb-import). El formato se reconoce por su estructura.
//  - { file, confirm: false } -> vista previa (sin escribir).
//  - { file, confirm: true, token } -> transacción: lockPeriodForWrite ->
//    lockClientTaxIdentity -> relectura de lo registrado para el cliente BAJO el
//    bloqueo -> la misma vista previa; token distinto: 409 sin escribir -> alta
//    de las filas OK + AuditLog taxrecord.iibb_import (formato, conteos y
//    huella; sin importes, CUIT ni CBU).
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);
    const body = (await parseJsonBody(request)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("cuerpo inválido", "body");
    const file = decode(body.file);
    if (body.confirm !== undefined && typeof body.confirm !== "boolean") throw new ValidationError("confirm debe ser booleano", "confirm");
    const confirm = body.confirm === true;
    if (confirm && (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token))) throw new ValidationError("token de vista previa requerido", "token");
    const access = await requirePeriodAccess(profileId, id, ROLES_CREATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();

    if (!confirm) {
        const period = await prisma.period.findFirst({ where: { id, organizationId }, select: { month: true, year: true } });
        if (!period) throw new NotFoundError();
        const preview = buildIibbImportPreview(file, period, await registeredIibbDeductions(prisma, { organizationId, clientId: access.period.clientId }), id);
        return NextResponse.json(serialize(preview), { status: 200 });
    }

    const result = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const period = await tx.period.findFirst({ where: { id, organizationId }, select: { month: true, year: true, clientId: true } });
        if (!period) throw new NotFoundError();
        await lockClientTaxIdentity(tx, organizationId, period.clientId);
        const preview = buildIibbImportPreview(file, period, await registeredIibbDeductions(tx, { organizationId, clientId: period.clientId }), id);
        if (preview.token !== body.token) throw new ConflictError("La vista previa ya no coincide con el período o con el archivo: generala de nuevo.");
        if (preview.fileErrors.length > 0 || !preview.format) throw new ValidationError(preview.fileErrors[0] ?? "formato no reconocido", "file");
        const format = preview.format;
        const ok = preview.rows.filter((r) => r.status === "OK");
        if (ok.length > 0) {
            await tx.taxRecord.createMany({
                data: ok.map((r) => ({
                    organizationId, periodId: id, type: r.type,
                    date: new Date(`${r.date}T00:00:00.000Z`), amount: r.amount!,
                    description: iibbImportDescription(format),
                    agentCuit: r.agentCuit, agentName: r.agentName,
                    voucherNumber: r.voucherNumber, certificateNumber: r.certificateNumber,
                    voucherKind: r.voucherKind, voucherLetter: r.voucherLetter, pointOfSale: r.pointOfSale,
                    baseAmount: r.baseAmount, cbu: r.cbu, bankExtra: r.rawBankExtra,
                    jurisdictionCode: r.jurisdictionCode, importSource: format, importIdentity: r.identity,
                    createdById: profileId, updatedById: profileId,
                })),
            });
        }
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "taxrecord.iibb_import",
            targetType: "Period",
            targetId: id,
            metadata: { periodId: id, format, importedCount: ok.length, duplicateCount: preview.counts.DUPLICATE, reviewCount: preview.counts.REVIEW, errorCount: preview.counts.ERROR, fileSha256: preview.fileSha256 },
        });
        return { preview, imported: ok.length };
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ ...serialize(result.preview), imported: result.imported }, { status: 201 });
});

function serialize(p: IibbImportPreview) {
    return {
        format: p.format,
        formatLabel: p.formatLabel,
        jurisdictionCode: p.jurisdictionCode,
        fileErrors: p.fileErrors,
        counts: p.counts,
        importableTotal: p.importableTotal,
        excludedTotal: p.excludedTotal,
        token: p.token,
        rows: p.rows.map((r) => ({
            line: r.line, status: r.status, messages: r.messages, type: r.type, date: r.date,
            agentCuit: r.agentCuit, agentName: r.agentName,
            voucher: [r.voucherKind, r.voucherLetter, r.pointOfSale, r.voucherNumber].filter(Boolean).join(" ") || null,
            certificateNumber: r.certificateNumber,
            // El CBU no viaja completo a la pantalla: alcanza con los últimos 4 para reconocerlo.
            cbuLast4: r.cbu ? r.cbu.slice(-4) : null,
            baseAmount: r.baseAmount ? r.baseAmount.toFixed(2) : null,
            amount: r.amount ? r.amount.toFixed(2) : null,
        })),
    };
}
