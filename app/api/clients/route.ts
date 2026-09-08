import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { serializeClient } from "@/lib/serializers";
import {
    requireAuthenticatedProfile,
    resolveActiveOrganization,
    requireOrganizationRole,
    withApiAuthz,
} from "@/lib/auth/authz";
import { ROLES_READ } from "@/lib/auth/roles";

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

// Tarea 3A (temporal, hasta 3B): `Client.organizationId` pasó a ser
// obligatorio. El alta de cliente necesita la organización del usuario
// autenticado, que recién se resuelve en la Tarea 3B (capa de autorización).
// Hasta entonces esta operación queda deshabilitada de forma explícita
// (fail closed):
//   - responde 501 SIEMPRE;
//   - NO lee el body de la request => cualquier `organizationId` u otro campo
//     enviado por el cliente se ignora por completo;
//   - NO ejecuta ninguna escritura (no toca Prisma).
export async function POST() {
    return NextResponse.json(
        {
            error:
                "El alta de clientes estará disponible al completar la autenticación y autorización (Tarea 3B).",
        },
        { status: 501, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
}
