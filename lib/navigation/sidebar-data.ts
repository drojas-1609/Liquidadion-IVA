import prisma from "@/lib/prisma";
import { requireAuthenticatedProfile, resolveActiveOrganization, clientScopeWhere } from "@/lib/auth/authz";
import { formatPeriodLabel } from "@/lib/period";

export { ACTIVE_CLIENT_COOKIE } from "./cookie";

/** Períodos que se listan por cliente en el menú (los más recientes). */
const PERIODS_IN_MENU = 36;

export interface SidebarPeriod {
    id: string;
    label: string;
    closed: boolean;
}

export interface SidebarClient {
    id: string;
    name: string;
    cuit: string;
    periods: SidebarPeriod[];
}

export interface SidebarData {
    clients: SidebarClient[];
    /** Módulo IVA: períodos, libros, liquidación y presentación. */
    hasIva: boolean;
}

/**
 * Datos del menú lateral y del selector de cliente. Respeta el alcance de la
 * persona (clientes asignados) y sus módulos; los períodos sólo con el módulo
 * IVA. Nunca lanza: sin sesión o sin acceso devuelve `null` y el menú queda en
 * su versión mínima (las páginas hacen su propio control de acceso).
 */
export async function loadSidebarData(): Promise<SidebarData | null> {
    try {
        const { profileId } = await requireAuthenticatedProfile();
        const access = await resolveActiveOrganization(profileId);
        const hasIva = access.modules.includes("IVA");
        if (!hasIva && !access.modules.includes("CLIENTS")) return { clients: [], hasIva };
        const rows = await prisma.client.findMany({
            where: clientScopeWhere(access),
            orderBy: { name: "asc" },
            select: {
                id: true,
                name: true,
                cuit: true,
                ...(hasIva
                    ? {
                          periods: {
                              orderBy: [{ year: "desc" }, { month: "desc" }],
                              take: PERIODS_IN_MENU,
                              select: { id: true, year: true, month: true, status: true },
                          },
                      }
                    : {}),
            },
        });
        return {
            hasIva,
            clients: rows.map((c: { id: string; name: string; cuit: string }) => ({
                id: c.id,
                name: c.name,
                cuit: c.cuit,
                periods: ((c as { periods?: { id: string; year: number; month: number; status: string }[] }).periods ?? []).map((p) => ({
                    id: p.id,
                    label: formatPeriodLabel(p),
                    closed: p.status === "CLOSED",
                })),
            })),
        };
    } catch {
        return null;
    }
}
