import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { buildPerceptionsPreview, existingPerceptionKeys } from "@/lib/tax-import/service";
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

// POST /api/periods/[id]/perceptions-import — percepciones de IVA desde la
// descarga de ARCA (lib/tax-import/perceptions-csv.ts).
//  - { file, confirm: false } -> vista previa (sin escribir): filas con estado y token.
//  - { file, confirm: true, token } -> transacción: lockPeriodForWrite (409
//    PERIOD_CLOSED / PERIOD_BUSY) -> relectura del período y de las percepciones
//    ya registradas BAJO el bloqueo -> la misma vista previa; token distinto:
//    409 sin escribir -> alta de las filas OK (tipo Percepción IVA, naturaleza
//    PERCEPTION) + AuditLog taxrecord.import (conteos y huella; sin importes ni CUIT).
// Roles: los de alta de retenciones/percepciones (OWNER/ADMIN/ACCOUNTANT/OPERATOR),
// módulo IVA y cliente en el alcance (si no, 404).
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
    const scope = { organizationId, periodId: id };

    if (!confirm) {
        const period = await prisma.period.findFirst({ where: { id, organizationId }, select: { month: true, year: true } });
        if (!period) throw new NotFoundError();
        const preview = buildPerceptionsPreview(file, period, await existingPerceptionKeys(prisma, scope), id);
        return NextResponse.json(serialize(preview), { status: 200 });
    }

    const result = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const period = await tx.period.findFirst({ where: { id, organizationId }, select: { month: true, year: true } });
        if (!period) throw new NotFoundError();
        const preview = buildPerceptionsPreview(file, period, await existingPerceptionKeys(tx, scope), id);
        if (preview.token !== body.token) throw new ConflictError("La vista previa ya no coincide con el período o con el archivo: generala de nuevo.");
        if (preview.fileErrors.length > 0) throw new ValidationError(preview.fileErrors[0], "file");
        const ok = preview.rows.filter((r) => r.status === "OK");
        if (ok.length > 0) {
            await tx.taxRecord.createMany({
                data: ok.map((r) => ({
                    organizationId, periodId: id, type: "PERCEPCION IVA", nature: "PERCEPTION" as const,
                    date: new Date(`${r.date}T00:00:00.000Z`), amount: r.amount!, description: "Importada (descarga de percepciones de ARCA)",
                    regimeCode: r.regimeCode, agentCuit: r.agentCuit, intermediaryCuit: r.intermediaryCuit,
                    voucherTypeCode: r.voucherTypeCode, voucherNumber: r.voucherNumber, createdById: profileId, updatedById: profileId,
                })),
            });
        }
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "taxrecord.import",
            targetType: "Period",
            targetId: id,
            metadata: { periodId: id, importedCount: ok.length, duplicateCount: preview.counts.DUPLICATE, reviewCount: preview.counts.REVIEW, errorCount: preview.counts.ERROR, fileSha256: preview.fileSha256 },
        });
        return { preview, imported: ok.length };
    }, { maxWait: 5000, timeout: 10000 });

    return NextResponse.json({ ...serialize(result.preview), imported: result.imported }, { status: 201 });
});

function serialize(p: ReturnType<typeof buildPerceptionsPreview>) {
    return {
        fileErrors: p.fileErrors,
        counts: p.counts,
        importableTotal: p.importableTotal,
        token: p.token,
        rows: p.rows.map((r) => ({
            line: r.line, status: r.status, messages: r.messages, regimeCode: r.regimeCode, agentCuit: r.agentCuit, date: r.date,
            voucherTypeCode: r.voucherTypeCode, voucherNumber: r.voucherNumber, amount: r.amount ? r.amount.toFixed(2) : null,
        })),
    };
}
