import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { generateLiquidationExcel } from "@/lib/excel";
import { computeLiquidation } from "@/lib/liquidation-calc";
import { serializeLiquidation } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    withApiAuthz,
} from "@/lib/auth/authz";
import { sanitizeAuditMetadata } from "@/lib/auth/audit";
import { ROLES_EXPORT } from "@/lib/auth/roles";
import { NotFoundError } from "@/lib/auth/errors";

/** Parte ASCII/unicode segura para el nombre del archivo (sin control, comillas, /). */
function safeFilePart(name: string): string {
    const cleaned = name
        .replace(/[^\p{L}\p{N}._-]+/gu, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
    return cleaned || "cliente";
}

// GET /api/client/[id]/period/[periodId]/export
//
// Orden seguro (brief §17):
//   1. autenticar y autorizar (incl. [id] == period.clientId -> 404 si no)
//   2. consultar el period y sus datos
//   3. calcular la liquidación
//   4. generar COMPLETAMENTE el XLSX en memoria
//   5. recién ahora registrar liquidation.export en AuditLog
//   6. sólo si el AuditLog se guardó, devolver el archivo
//
// Si falla el cálculo o la generación -> 500 sin AuditLog y sin binario.
// Si falla el AuditLog -> 500 sin entregar el buffer.
// Intento cross-org / [id] != period.clientId -> 404 sin cálculo/generación/audit.
export const GET = withApiAuthz(
    async (_req: Request, ctx: { params: Promise<{ id: string; periodId: string }> }) => {
        const { id, periodId } = await ctx.params;

        // 1 · autenticar y autorizar
        const { profileId } = await requireAuthenticatedProfile();
        const { organizationId } = await resolveActiveOrganization(profileId);
        await requireOrganizationRole(profileId, organizationId, ROLES_EXPORT);
        await requirePeriodAccess(profileId, periodId, ROLES_EXPORT, { expectClientId: id });

        // 2 · consultar el period y sus datos (ya autorizado)
        const full = await prisma.period.findFirst({
            where: { id: periodId, organizationId },
            include: { invoices: true, taxRecords: true, client: true },
        });
        if (!full) throw new NotFoundError();

        // 3 · calcular  ·  4 · generar completamente el buffer en memoria
        const dto = serializeLiquidation(computeLiquidation(full));
        const mm = String(full.month).padStart(2, "0");
        const excelBuffer = generateLiquidationExcel({
            ...dto,
            period: `${mm}/${full.year}`,
            client: full.client.name,
            cuit: full.client.cuit,
        });

        // 5 · recién ahora: registrar la exportación (sin buffer / importes / contenido)
        await prisma.auditLog.create({
            data: {
                organizationId,
                actorProfileId: profileId,
                action: "liquidation.export",
                targetType: "Liquidation",
                targetId: periodId,
                metadata: sanitizeAuditMetadata("liquidation.export", {
                    periodId,
                    clientId: id,
                    month: full.month,
                    year: full.year,
                    invoiceCount: full.invoices.length,
                    taxRecordCount: full.taxRecords.length,
                }),
            },
        });

        // 6 · sólo si el AuditLog se guardó: devolver el archivo
        const part = safeFilePart(full.client.name);
        return new NextResponse(new Uint8Array(excelBuffer), {
            status: 200,
            headers: {
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition":
                    `attachment; filename="Liquidacion_${part}_${mm}_${full.year}.xlsx"; ` +
                    `filename*=UTF-8''Liquidacion_${encodeURIComponent(part)}_${mm}_${full.year}.xlsx`,
                "Cache-Control": "no-store, max-age=0",
                "X-Content-Type-Options": "nosniff",
            },
        });
    },
);
