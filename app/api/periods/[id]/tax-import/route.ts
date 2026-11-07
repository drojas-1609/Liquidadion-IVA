import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { lockClientTaxIdentity } from "@/lib/tax-identity";
import { buildTaxImportPreview, existingTaxKeys, type TaxImportKind, type TaxImportPreview } from "@/lib/tax-import/service";
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

// POST /api/periods/[id]/tax-import — retenciones o percepciones de IVA desde las
// descargas de ARCA (lib/tax-import).
//  - { kind, file, integerAmountsArePesos?, confirm: false } -> vista previa (sin escribir).
//  - { …, confirm: true, token } -> transacción: lockPeriodForWrite (409
//    PERIOD_CLOSED / PERIOD_BUSY) -> lockClientTaxIdentity (bloqueo por
//    cliente: dos importaciones del mismo certificado en períodos distintos no
//    se cruzan) -> relectura del período y de las claves ya
//    registradas para el cliente BAJO el bloqueo -> la misma vista previa; token
//    distinto: 409 sin escribir -> alta de las filas OK + AuditLog taxrecord.import
//    (tipo, forma, conteos y huella; sin importes, CUIT ni certificados).
// Las filas que no se importan quedan en la respuesta con su estado y motivo y
// fuera de los totales importados (nunca se descartan en silencio).
// Roles de alta de retenciones/percepciones, módulo IVA y cliente en el alcance.
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);
    const body = (await parseJsonBody(request)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("cuerpo inválido", "body");
    if (body.kind !== "PERCEPTIONS" && body.kind !== "RETENTIONS") throw new ValidationError("kind debe ser PERCEPTIONS o RETENTIONS", "kind");
    const kind: TaxImportKind = body.kind;
    const file = decode(body.file);
    for (const k of ["confirm", "integerAmountsArePesos"] as const) {
        if (body[k] !== undefined && typeof body[k] !== "boolean") throw new ValidationError(`${k} debe ser booleano`, k);
    }
    const confirm = body.confirm === true;
    const opts = { integerAmountsArePesos: body.integerAmountsArePesos === true };
    if (confirm && (typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token))) throw new ValidationError("token de vista previa requerido", "token");
    const access = await requirePeriodAccess(profileId, id, ROLES_CREATE);
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const clientScope = { organizationId, clientId: access.period.clientId };

    if (!confirm) {
        const period = await prisma.period.findFirst({ where: { id, organizationId }, select: { month: true, year: true } });
        if (!period) throw new NotFoundError();
        const preview = buildTaxImportPreview(kind, file, period, await existingTaxKeys(prisma, clientScope, kind), id, opts);
        return NextResponse.json(serialize(preview), { status: 200 });
    }

    const result = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const period = await tx.period.findFirst({ where: { id, organizationId }, select: { month: true, year: true, clientId: true } });
        if (!period) throw new NotFoundError();
        // Identidad entre períodos: serializa con las demás escrituras de
        // retenciones/percepciones del MISMO cliente (otro período incluido)
        // antes de releer lo registrado.
        await lockClientTaxIdentity(tx, organizationId, period.clientId);
        const preview = buildTaxImportPreview(kind, file, period, await existingTaxKeys(tx, { organizationId, clientId: period.clientId }, kind), id, opts);
        if (preview.token !== body.token) throw new ConflictError("La vista previa ya no coincide con el período o con el archivo: generala de nuevo.");
        if (preview.fileErrors.length > 0) throw new ValidationError(preview.fileErrors[0], "file");
        const ok = preview.rows.filter((r) => r.status === "OK");
        if (ok.length > 0) {
            await tx.taxRecord.createMany({
                data: ok.map((r) => ({
                    organizationId, periodId: id,
                    type: kind === "RETENTIONS" ? "RETENCION IVA" : "PERCEPCION IVA",
                    nature: kind === "RETENTIONS" ? ("RETENTION" as const) : ("PERCEPTION" as const),
                    date: new Date(`${r.date}T00:00:00.000Z`), amount: r.amount!,
                    description: kind === "RETENTIONS" ? "Importada (retenciones de ARCA)" : "Importada (descarga de percepciones de ARCA)",
                    taxCode: kind === "RETENTIONS" ? (r.taxCode ?? null) : null,
                    regimeCode: r.regimeCode, agentCuit: r.agentCuit, intermediaryCuit: r.intermediaryCuit,
                    voucherTypeCode: r.voucherTypeCode, voucherNumber: r.voucherNumber,
                    certificateNumber: kind === "RETENTIONS" ? (r.certificateNumber ?? null) : null,
                    createdById: profileId, updatedById: profileId,
                })),
            });
        }
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "taxrecord.import",
            targetType: "Period",
            targetId: id,
            metadata: { periodId: id, kind, layout: preview.layout, importedCount: ok.length, duplicateCount: preview.counts.DUPLICATE, reviewCount: preview.counts.REVIEW, errorCount: preview.counts.ERROR, fileSha256: preview.fileSha256 },
        });
        return { preview, imported: ok.length };
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ ...serialize(result.preview), imported: result.imported }, { status: 201 });
});

function serialize(p: TaxImportPreview) {
    return {
        kind: p.kind,
        layout: p.layout,
        fileErrors: p.fileErrors,
        counts: p.counts,
        importableTotal: p.importableTotal,
        excludedTotal: p.excludedTotal,
        token: p.token,
        rows: p.rows.map((r) => ({
            line: r.line, status: r.status, messages: r.messages, regimeCode: r.regimeCode, agentCuit: r.agentCuit, date: r.date,
            voucherTypeCode: r.voucherTypeCode, voucherNumber: r.voucherNumber, certificateNumber: r.certificateNumber ?? null,
            amount: r.amount ? r.amount.toFixed(2) : null, integerAmount: r.integerAmount,
        })),
    };
}
