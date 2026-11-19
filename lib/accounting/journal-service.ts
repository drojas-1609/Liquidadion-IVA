import "server-only";
import type { Prisma } from "@prisma/client";
import { sum } from "../decimal";
import { computeLiquidation } from "../liquidation-calc";
import { loadPeriodLiquidationInput } from "../liquidation-totals";
import { ACCOUNT_ROLE_LABEL, type AccountRole } from "./chart-models";
import { buildIibbEntry, buildVatEntry, type DraftEntry, type JournalKind } from "./journal";

type Tx = Prisma.TransactionClient;
export interface JournalScope { organizationId: string; clientId: string; profileId: string }

/** Falta una cuenta del plan para un rol, o la cuenta elegida no sirve. */
export class JournalAccountError extends Error {
    constructor(message: string, readonly field: string) { super(message); }
}

/** Asigna a cada línea la cuenta del plan del cliente (por rol o por id). */
async function resolveLines(tx: Tx, scope: JournalScope, draft: DraftEntry) {
    const roles = [...new Set(draft.lines.flatMap((l) => (l.role ? [l.role] : [])))];
    const ids = [...new Set(draft.lines.flatMap((l) => (l.accountId ? [l.accountId] : [])))];
    const accounts = await tx.chartAccount.findMany({
        where: { organizationId: scope.organizationId, clientId: scope.clientId, OR: [{ role: { in: roles } }, { id: { in: ids } }] },
        select: { id: true, role: true, active: true, imputable: true, name: true },
    });
    const byRole = new Map(accounts.filter((a) => a.role).map((a) => [a.role as string, a]));
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return draft.lines.map((l, i) => {
        const acc = l.role ? byRole.get(l.role) : byId.get(l.accountId as string);
        if (!acc) {
            if (l.role) throw new JournalAccountError(`El plan de cuentas no tiene asignado el uso «${ACCOUNT_ROLE_LABEL[l.role as AccountRole]}». Asignalo en Plan de cuentas.`, "role");
            throw new JournalAccountError("La cuenta elegida no pertenece al plan del cliente.", "paymentAccountId");
        }
        if (!acc.active || !acc.imputable) throw new JournalAccountError(`La cuenta «${acc.name}» está inactiva o no es imputable.`, l.role ? "role" : "paymentAccountId");
        return { organizationId: scope.organizationId, accountId: acc.id, position: i + 1, debit: l.debit, credit: l.credit, memo: l.memo };
    });
}

/**
 * Graba el asiento. Con `sourceKey` (asiento automático) reemplaza el anterior
 * de la misma fuente conservando su número; si no, toma el número siguiente.
 */
export async function saveJournalEntry(tx: Tx, scope: JournalScope, draft: DraftEntry, opts: { periodId: string | null; sourceKey: string | null }) {
    const lines = await resolveLines(tx, scope, draft);
    const header = { date: new Date(`${draft.date}T00:00:00.000Z`), kind: draft.kind, description: draft.description, periodId: opts.periodId, updatedById: scope.profileId };
    const existing = opts.sourceKey
        ? await tx.journalEntry.findUnique({ where: { clientId_sourceKey: { clientId: scope.clientId, sourceKey: opts.sourceKey } }, select: { id: true, number: true, organizationId: true } })
        : null;
    if (existing && existing.organizationId === scope.organizationId) {
        await tx.journalLine.deleteMany({ where: { entryId: existing.id } });
        await tx.journalEntry.update({ where: { id: existing.id }, data: header });
        await tx.journalLine.createMany({ data: lines.map((l) => ({ ...l, entryId: existing.id })) });
        return { id: existing.id, number: existing.number, replaced: true };
    }
    const last = await tx.journalEntry.aggregate({ where: { clientId: scope.clientId, organizationId: scope.organizationId }, _max: { number: true } });
    const number = (last._max.number ?? 0) + 1;
    const created = await tx.journalEntry.create({
        data: { ...header, organizationId: scope.organizationId, clientId: scope.clientId, number, sourceKey: opts.sourceKey, createdById: scope.profileId },
        select: { id: true },
    });
    await tx.journalLine.createMany({ data: lines.map((l) => ({ ...l, entryId: created.id })) });
    return { id: created.id, number, replaced: false };
}

/** Asiento automático del período (IVA o IIBB) a partir de la liquidación vigente. */
export async function buildPeriodEntry(tx: Tx, scope: { organizationId: string; periodId: string }, kind: Extract<JournalKind, "VAT_POSITION" | "IIBB_POSITION">, period: { month: number; year: number }): Promise<DraftEntry | null> {
    const input = await loadPeriodLiquidationInput(tx, scope);
    if (!input) return null;
    const liq = computeLiquidation(input);
    if (kind === "VAT_POSITION") return buildVatEntry(liq.iva, period.month, period.year);
    // SIRTAC por separado, con el mismo filtro de jurisdicción que la liquidación.
    const jur = input.client.iibbJurisdiction ?? null;
    const sirtac = sum(input.taxRecords.filter((t) => t.type === "SIRTAC" && (jur === null || t.jurisdictionCode == null || t.jurisdictionCode === jur)).map((t) => t.amount));
    return buildIibbEntry({ ...liq.iibb, sirtac }, period.month, period.year);
}

export const periodSourceKey = (kind: "VAT_POSITION" | "IIBB_POSITION", periodId: string) => `${kind === "VAT_POSITION" ? "VAT" : "IIBB"}:${periodId}`;
