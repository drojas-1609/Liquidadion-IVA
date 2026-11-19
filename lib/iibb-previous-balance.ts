import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { IibbPositionForCalc } from "./liquidation-calc";

/**
 * Saldo a favor de IIBB del período anterior, tomado automáticamente cuando el
 * estudio todavía no cargó los datos de la DDJJ del período (sin
 * PeriodIibbPosition). Orden de búsqueda en el período inmediato anterior del
 * mismo cliente:
 *  1. la liquidación CERRADA vigente (PeriodLiquidationVersion sin reemplazar):
 *     «Saldo a favor del contribuyente» de IIBB guardado en el cierre;
 *  2. si el cierre es anterior a la estructura de la DDJJ (sin ese dato), el
 *     saldo a favor del contribuyente de la DDJJ presentada que se registró.
 * Si no hay nada registrado: sin saldo automático (0). Lo cargado a mano
 * siempre prevalece.
 */

export interface PreviousIibbBalance {
    amount: Prisma.Decimal;
    source: "closed" | "filed";
    month: number;
    year: number;
}

type Db = Pick<PrismaClient, "period"> | Pick<Prisma.TransactionClient, "period">;

export async function previousIibbBalance(db: Db, scope: { organizationId: string; clientId: string; month: number; year: number }): Promise<PreviousIibbBalance | null> {
    const month = scope.month === 1 ? 12 : scope.month - 1;
    const year = scope.month === 1 ? scope.year - 1 : scope.year;
    const prev = await (db as Pick<PrismaClient, "period">).period.findFirst({
        where: { organizationId: scope.organizationId, clientId: scope.clientId, month, year },
        select: {
            status: true,
            iibbPosition: { select: { filedBalanceTaxpayer: true } },
            liquidationVersions: { where: { supersededAt: null }, select: { summary: true }, orderBy: { version: "desc" }, take: 1 },
        },
    });
    if (!prev) return null;
    if (prev.status === "CLOSED") {
        const summary = prev.liquidationVersions[0]?.summary as { liquidation?: { iibb?: { balanceTaxpayer?: unknown } } | null } | undefined;
        const v = summary?.liquidation?.iibb?.balanceTaxpayer;
        if (typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v)) return { amount: new Prisma.Decimal(v), source: "closed", month, year };
    }
    const filed = prev.iibbPosition?.filedBalanceTaxpayer;
    if (filed != null) return { amount: filed, source: "filed", month, year };
    return null;
}

/** Posición para el cálculo: la cargada, o la automática con el saldo anterior. */
export function iibbPositionWithPrevious(saved: IibbPositionForCalc | null, previous: PreviousIibbBalance | null): IibbPositionForCalc | null {
    if (saved) return saved;
    if (!previous) return null;
    const z = new Prisma.Decimal(0);
    return { previousBalance: previous.amount, paymentsOnAccount: z, otherCredits: z, otherDebits: z };
}
