import { NextResponse } from "next/server";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    requirePeriodAccess,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { ROLES_CREATE } from "@/lib/auth/roles";
import { NotFoundError, ValidationError } from "@/lib/auth/errors";
import { parseImportRequest } from "@/lib/libro-iva-import/request";
import { previewImport, serializePreview } from "@/lib/libro-iva-import/service";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/periods/[id]/libro-iva-import/preview — vista previa de la
// importación del Libro IVA Digital (TXT de comprobantes y de alícuotas).
// Mismos permisos que el alta de comprobantes (ROLES_CREATE). No escribe.
// Orden: auth -> organización -> rol -> parseo -> acceso al período con el
// cliente esperado (otra organización, otro cliente o inexistente: 404).
export const POST = withApiAuthz(async (request: Request, ctx: Ctx) => {
    const { id } = await ctx.params;
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const parsed = parseImportRequest(await parseJsonBody(request), { requireToken: false });
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    const input = parsed.data;

    const access = await requirePeriodAccess(profileId, id, ROLES_CREATE, { expectClientId: input.clientId });
    if (access.organizationId !== organizationId) throw new NotFoundError();

    const result = await previewImport(
        { organizationId, periodId: access.period.id, clientId: access.period.clientId },
        { category: input.category, format: input.format, vouchers: input.vouchers, aliquots: input.aliquots, reimportDeleted: input.reimportDeleted },
    );
    return NextResponse.json(serializePreview(result));
});
