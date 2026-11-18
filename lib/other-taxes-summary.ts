import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { OtherTaxesKind } from "./invoice-perceptions";

/**
 * Proveedores del período con «Otros tributos» todavía sin imputar (después de
 * separar la percepción de IVA de ARCA), con su regla vigente, para decidir la
 * regla por proveedor. Sólo lectura.
 */
export interface OtherTaxesSupplierRow {
    supplierCuit: string;
    name: string;
    invoices: number;
    otherTaxes: string;
    taxedNet: string;
    /** «Otros tributos» sobre el neto gravado, en %, con 2 decimales ("" si no hay neto). */
    percent: string;
    rule: OtherTaxesKind | null;
}

export async function otherTaxesBySupplier(
    db: Pick<PrismaClient, "invoice" | "supplierOtherTaxesRule">,
    scope: { organizationId: string; periodId: string; clientId: string },
): Promise<OtherTaxesSupplierRow[]> {
    const [rows, rules] = await Promise.all([
        db.invoice.findMany({
            where: { organizationId: scope.organizationId, periodId: scope.periodId, category: "PURCHASES", otherTaxesAmount: { gt: 0 }, counterpartyDocType: 80 },
            select: { counterpartyDocNumber: true, counterpartyName: true, otherTaxesAmount: true, taxedNetAmount: true },
        }),
        db.supplierOtherTaxesRule.findMany({ where: { organizationId: scope.organizationId, clientId: scope.clientId }, select: { supplierCuit: true, kind: true } }),
    ]);
    const ruleOf = new Map(rules.map((r) => [r.supplierCuit, r.kind as OtherTaxesKind]));
    const groups = new Map<string, { name: string; n: number; other: Prisma.Decimal; net: Prisma.Decimal }>();
    for (const r of rows) {
        const cuit = r.counterpartyDocNumber ?? "";
        if (!/^\d{11}$/.test(cuit)) continue;
        const g = groups.get(cuit) ?? { name: r.counterpartyName ?? "", n: 0, other: new Prisma.Decimal(0), net: new Prisma.Decimal(0) };
        g.n += 1;
        g.other = g.other.plus(r.otherTaxesAmount ?? 0);
        g.net = g.net.plus(r.taxedNetAmount ?? 0);
        groups.set(cuit, g);
    }
    return [...groups.entries()]
        .map(([cuit, g]) => ({
            supplierCuit: cuit, name: g.name, invoices: g.n, otherTaxes: g.other.toFixed(2), taxedNet: g.net.toFixed(2),
            percent: g.net.isZero() ? "" : g.other.dividedBy(g.net).times(100).toFixed(2),
            rule: ruleOf.get(cuit) ?? null,
        }))
        .sort((a, b) => Number(b.otherTaxes) - Number(a.otherTaxes));
}
