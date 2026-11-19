import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { ROLES_UPDATE } from "@/lib/auth/roles";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/auth/errors";
import { recordAudit } from "@/lib/auth/audit";
import { lockPeriodForWrite } from "@/lib/period-lock";
import { validCuit } from "@/lib/tax-import/common";
import { parseImportRequest } from "@/lib/libro-iva-import/request";
import { TRIBUTE_LABELS, type SyncItem } from "@/lib/libro-iva-import/tribute-sync";
import { applyTributeSync, periodPurchasesForSync, planTributeSync, tributeSyncFileRows, tributeSyncToken } from "@/lib/libro-iva-import/tribute-sync-service";

type Ctx = { params: Promise<{ id: string }> };

const STALE = "La vista previa ya no coincide con las compras del período o con los archivos: generala de nuevo.";

function serialize(items: SyncItem[]) {
    return items.map((i) => ({
        invoiceId: i.invoiceId, supplierCuit: i.supplierCuit, supplierName: i.supplierName, voucher: i.voucher,
        applicable: i.applicable, excluded: i.excluded, reason: i.reason,
        changes: i.changes.map((c) => ({ field: c.field, label: TRIBUTE_LABELS[c.field], before: c.before.toFixed(2), after: c.after.toFixed(2) })),
    }));
}

// POST /api/periods/[id]/tribute-sync — lleva los tributos de las compras YA
// cargadas (percepciones de IVA / nacionales / IIBB / municipales, impuestos
// internos, otros tributos, no gravado y exento) a lo declarado en el Libro IVA
// Digital (lib/libro-iva-import/tribute-sync). El total de cada comprobante no
// cambia. Body: archivos del LID de compras (mismo formato que la importación)
// + `excluded` (CUIT de proveedores a no modificar).
//  - sin `confirm`: vista previa (no escribe).
//  - `confirm: true` + `token`: transacción bajo lockPeriodForWrite, relectura
//    de las compras, mismo plan (si cambió: 409), tramo de hasta 8 escrituras;
//    `pending` si quedó trabajo (el navegador repite con `continue: true`).
//    AuditLog invoice.tributes_sync (conteos y huella; sin importes ni CUIT).
// Después, la pantalla concilia las percepciones (invoice-perceptions).
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_UPDATE);

    const body = (await parseJsonBody(request)) as Record<string, unknown> | null;
    const parsed = parseImportRequest(body, { requireToken: false });
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    if (parsed.data.category !== "PURCHASES") throw new ValidationError("sólo se sincronizan compras", "category");
    const rawExcluded = body?.excluded ?? [];
    if (!Array.isArray(rawExcluded) || rawExcluded.length > 500 || rawExcluded.some((c) => typeof c !== "string" || !validCuit(c))) {
        throw new ValidationError("excluded debe ser una lista de CUIT válidos", "excluded");
    }
    const excluded = [...new Set(rawExcluded as string[])].sort();
    const confirm = body?.confirm === true;
    const cont = body?.continue === true;
    if (confirm && !cont && (typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token))) throw new ValidationError("token de vista previa requerido", "token");

    const access = await requirePeriodAccess(profileId, id, ROLES_UPDATE, { expectClientId: parsed.data.clientId });
    if (access.organizationId !== organizationId) throw new NotFoundError();
    const scope = { organizationId, periodId: access.period.id, clientId: access.period.clientId };
    const files = { category: "PURCHASES" as const, format: parsed.data.format, vouchers: parsed.data.vouchers, aliquots: parsed.data.aliquots };
    const file = await tributeSyncFileRows(scope, files);
    if (file.fileErrors.length > 0) throw new ValidationError("los archivos tienen problemas: " + file.fileErrors[0], "files");
    const excludedSet = new Set(excluded);

    if (!confirm) {
        const items = planTributeSync(file.rows, await periodPurchasesForSync(prisma, scope), excludedSet);
        return NextResponse.json({ token: tributeSyncToken(file.filesSha256, excluded, items), items: serialize(items) });
    }

    const result = await prisma.$transaction(async (tx) => {
        await lockPeriodForWrite(tx, id, organizationId);
        const items = planTributeSync(file.rows, await periodPurchasesForSync(tx, scope), excludedSet);
        if (!cont && tributeSyncToken(file.filesSha256, excluded, items) !== body?.token) throw new ConflictError(STALE);
        const r = await applyTributeSync(tx, scope, items, profileId);
        if (r.applied > 0) {
            await recordAudit(tx, {
                organizationId,
                actorProfileId: profileId,
                action: "invoice.tributes_sync",
                targetType: "Period",
                targetId: id,
                metadata: { periodId: id, applied: r.applied, pending: r.pending, excludedSuppliers: excluded.length, filesSha256: file.filesSha256 },
            });
        }
        return r;
    }, { maxWait: 5000, timeout: 10000 });
    return NextResponse.json(result);
});
