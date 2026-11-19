import "server-only";
import type { Prisma } from "@prisma/client";
import { chartModelAccounts, isImputableCode, type ChartModel } from "./chart-models";

type Tx = Pick<Prisma.TransactionClient, "chartAccount" | "client">;

/**
 * Copia un plan modelo al cliente. Sólo si el cliente todavía no tiene cuentas
 * (no se mezcla con un plan editado). Devuelve la cantidad creada; 0 = ya tenía plan.
 */
export async function applyChartModel(tx: Tx, scope: { organizationId: string; clientId: string; profileId: string }, model: ChartModel): Promise<number> {
    const existing = await tx.chartAccount.count({ where: { clientId: scope.clientId, organizationId: scope.organizationId } });
    if (existing > 0) return 0;
    const rows = chartModelAccounts(model).map((a) => ({
        organizationId: scope.organizationId, clientId: scope.clientId, code: a.code, name: a.name,
        imputable: isImputableCode(a.code), role: a.role ?? null, createdById: scope.profileId, updatedById: scope.profileId,
    }));
    await tx.chartAccount.createMany({ data: rows });
    await tx.client.update({ where: { id_organizationId: { id: scope.clientId, organizationId: scope.organizationId } }, data: { chartModel: model } });
    return rows.length;
}
