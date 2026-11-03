import "server-only";
import prisma from "../prisma";
import type { PrismaClient } from "@prisma/client";

/**
 * Interruptor de la consulta a ARCA en producción, leído en cada consulta (sin
 * caché): apagar la fila global o la de la organización corta las consultas
 * sin redeploy. Sin fila = apagado. Los errores se propagan: el llamador no
 * consulta ARCA si no pudo leer la habilitación.
 */
export async function productionLookupEnabled(organizationId: string, client: PrismaClient = prisma): Promise<boolean> {
    const [global, organization] = await Promise.all([
        client.arcaPadronControl.findUnique({ where: { id: "global" }, select: { enabled: true } }),
        client.arcaPadronOrganization.findUnique({ where: { organizationId }, select: { enabled: true } }),
    ]);
    return global?.enabled === true && organization?.enabled === true;
}
