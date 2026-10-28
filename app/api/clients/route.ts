import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildClientInput } from "@/lib/api-input";
import { serializeClient } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    parseJsonBody,
    withApiAuthz,
} from "@/lib/auth/authz";
import { recordAudit } from "@/lib/auth/audit";
import { replaceIibbProfile } from "@/lib/client-iibb-store";
import { verifyProfileSources } from "@/lib/iibb-profile-sources";
import { activityCatalogs } from "@/lib/activity-catalog/registry";
import { usableRateRuleSets } from "@/lib/iibb-rates/registry";
import { ROLES_READ, ROLES_CREATE } from "@/lib/auth/roles";
import { ValidationError } from "@/lib/auth/errors";

// GET /api/clients — clientes de la organización activa del usuario.
// Cualquier fallo se propaga a withApiAuthz (500 controlado); ya NO se
// devuelve `[]` con 200 enmascarando errores.
export const GET = withApiAuthz(async () => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_READ);

    const clients = await prisma.client.findMany({
        where: { organizationId },
        orderBy: { name: "asc" },
    });
    return NextResponse.json(clients.map(serializeClient));
});

// POST /api/clients — alta de cliente en la organización activa.
//
// Orden (brief §7.1): auth -> organización -> rol (crear NO depende de un
// recurso) -> parseo del body -> validación -> escritura + AuditLog en una
// única transacción.
//
// `organizationId`, `createdById` y campos calculados enviados en el body se
// IGNORAN por completo: se usa siempre la organización resuelta server-side y
// el Profile autenticado. Teléfono y email de contacto son obligatorios en el
// alta; el perfil IIBB es opcional e informativo.
export const POST = withApiAuthz(async (request: Request) => {
    const { profileId } = await requireAuthenticatedProfile();
    const { organizationId } = await resolveActiveOrganization(profileId);
    await requireOrganizationRole(profileId, organizationId, ROLES_CREATE);

    const body = await parseJsonBody(request);
    const parsed = buildClientInput(body);
    if (!parsed.ok) throw new ValidationError(parsed.error, parsed.field);
    // Procedencia: actividades "de catálogo" y tasas "sugeridas" deben coincidir
    // con un catálogo / una regla revisados (en el alta todo es nuevo).
    if (parsed.data.iibb) {
        const source = verifyProfileSources(parsed.data.iibb, null, activityCatalogs(), usableRateRuleSets());
        if (source) throw new ValidationError(source.error, source.field);
    }

    const created = await prisma.$transaction(async (tx) => {
        const client = await tx.client.create({
            data: {
                name: parsed.data.name,
                cuit: parsed.data.cuit,
                condition: parsed.data.condition,
                address: parsed.data.address,
                defaultIibbRate: parsed.data.defaultIibbRate,
                phone: parsed.data.phone,
                contactEmail: parsed.data.contactEmail,
                iibbRegistration: parsed.data.iibb?.registration ?? null,
                organizationId,
                createdById: profileId,
                updatedById: profileId,
            },
        });
        // Perfil IIBB informativo (jurisdicciones, actividades, alícuotas): no
        // modifica defaultIibbRate ni el cálculo.
        if (parsed.data.iibb && (parsed.data.iibb.jurisdictions.length > 0 || parsed.data.iibb.activities.length > 0)) {
            await replaceIibbProfile(tx, { clientId: client.id, organizationId, profile: parsed.data.iibb });
        }
        await recordAudit(tx, {
            organizationId,
            actorProfileId: profileId,
            action: "client.create",
            targetType: "Client",
            targetId: client.id,
            // SIN cuit ni contactos.
            metadata: { condition: parsed.data.condition, iibbRegistration: parsed.data.iibb?.registration ?? null },
        });
        return client;
    });

    // P2002 sobre @@unique([organizationId, cuit]) -> withApiAuthz -> 409 CONFLICT.
    return NextResponse.json(serializeClient(created), { status: 201 });
});
