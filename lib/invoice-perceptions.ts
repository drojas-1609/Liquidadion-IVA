import "server-only";
import { Prisma } from "@prisma/client";
import { voucherType } from "./invoice-model";

/**
 * Percepciones cargadas en los comprobantes de compra frente a la sección de
 * Retenciones/Percepciones (fuente única de la liquidación). Decisiones del
 * estudio (17/11/2026):
 *  - Percepción de IVA: si ARCA ya la informó (mismo agente y mismo
 *    comprobante), se VINCULA al comprobante y se computa lo informado por ARCA;
 *    si los importes difieren, el control de la presentación lo avisa. Si ARCA
 *    no la informó, se crea el registro desde el comprobante (`fromInvoice`). Si
 *    después llega de ARCA, la de ARCA reemplaza a la tomada del comprobante.
 *  - Percepción de IIBB: se crea el registro desde el comprobante, imputado a la
 *    jurisdicción sede del cliente.
 *  - Notas de crédito: no se crea nada automáticamente (el signo de la
 *    percepción en una nota de crédito lo define el estudio); queda el aviso.
 * Se ejecuta en la MISMA transacción que la escritura que la origina, con el
 * Period ya bloqueado. Es idempotente: sin cambios, no escribe.
 */

export const IVA_PERCEPTION_TYPE = "PERCEPCION IVA";
export const IIBB_PERCEPTION_TYPE = "PERCEPCION IIBB";

const F2051_TYPE_BY_KIND: Record<string, number> = { INVOICE: 1, DEBIT_NOTE: 4 };

/** Número del comprobante con el formato 99999-99999999 de la tabla del F.2051. */
export function f2051VoucherNumber(pointOfSale: number, number: number): string {
    return `${String(pointOfSale).padStart(5, "0")}-${String(number).padStart(8, "0")}`;
}

/**
 * ¿El número informado por ARCA corresponde a ese punto de venta y número? ARCA
 * lo informa sólo con dígitos y ceros de relleno de distinto largo
 * («0007000000013442», «00007-00013442»): se compara la secuencia
 * ceros + punto de venta + ceros + número, completa.
 */
export function sameVoucherNumber(reported: string | null, pointOfSale: number, number: number): boolean {
    if (!reported) return false;
    const digits = reported.replace(/[-\s]/g, "");
    if (!/^\d+$/.test(digits)) return false;
    return new RegExp(`^0*${pointOfSale}0*${number}$`).test(digits);
}

export interface PerceptionInvoice {
    id: string;
    voucherCode: number | null;
    pointOfSale: number;
    number: number;
    voucherDate: Date | null;
    date: Date | null;
    counterpartyDocType: number | null;
    counterpartyDocNumber: string | null;
    vatPerceptionAmount: Prisma.Decimal | null;
    iibbPerceptionAmount: Prisma.Decimal | null;
}

export interface PerceptionRecord {
    id: string;
    type: string;
    nature: string | null;
    amount: Prisma.Decimal;
    agentCuit: string | null;
    voucherNumber: string | null;
    invoiceId: string | null;
    fromInvoice: boolean;
    jurisdictionCode: string | null;
    date: Date;
}

export type PerceptionAction =
    | { kind: "link"; recordId: string; invoiceId: string }
    | { kind: "unlink"; recordId: string }
    | { kind: "delete"; recordId: string }
    | { kind: "update"; recordId: string; amount: Prisma.Decimal; date: Date; jurisdictionCode?: string | null }
    | { kind: "create"; invoiceId: string; type: string; amount: Prisma.Decimal; date: Date; agentCuit: string | null; voucherTypeCode: number | null; voucherNumber: string | null; jurisdictionCode: string | null };

const positive = (d: Prisma.Decimal | null): d is Prisma.Decimal => d !== null && d.greaterThan(0);

/**
 * Acciones para dejar el período conciliado. Función pura: `invoices` son las
 * compras del período; `records`, sus registros de tipo percepción de IVA o
 * IIBB; `headquarters`, la jurisdicción sede del cliente (o null).
 */
export function planInvoicePerceptions(invoices: PerceptionInvoice[], records: PerceptionRecord[], headquarters: string | null): PerceptionAction[] {
    const actions: PerceptionAction[] = [];
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const taken = new Set<string>();

    // Registros vinculados a comprobantes que ya no existen o ya no tienen la percepción.
    for (const r of records) {
        if (r.invoiceId === null) continue;
        const inv = byId.get(r.invoiceId);
        const amount = inv ? (r.type === IIBB_PERCEPTION_TYPE ? inv.iibbPerceptionAmount : inv.vatPerceptionAmount) : null;
        const eligible = inv !== undefined && eligibleKind(inv) !== null && positive(amount);
        if (!eligible && (r.type === IVA_PERCEPTION_TYPE || r.type === IIBB_PERCEPTION_TYPE)) {
            actions.push(r.fromInvoice ? { kind: "delete", recordId: r.id } : { kind: "unlink", recordId: r.id });
            taken.add(r.id);
        }
    }

    for (const inv of invoices) {
        const f2051Type = eligibleKind(inv);
        if (f2051Type === null) continue;
        const date = inv.voucherDate ?? inv.date;
        if (date === null) continue; // sin fecha no se puede registrar (no se supone una)
        const agentCuit = inv.counterpartyDocType === 80 ? inv.counterpartyDocNumber : null;

        // ── IVA ──
        if (positive(inv.vatPerceptionAmount)) {
            const linked = records.find((r) => r.invoiceId === inv.id && r.type === IVA_PERCEPTION_TYPE && !taken.has(r.id));
            if (!linked || linked.fromInvoice) {
                // Sólo con una coincidencia única: ante dos candidatas no se elige.
                const candidates = agentCuit === null ? [] : records.filter((r) =>
                    r.invoiceId === null && !r.fromInvoice && !taken.has(r.id) && r.type === IVA_PERCEPTION_TYPE && r.nature === "PERCEPTION"
                    && r.agentCuit === agentCuit && sameVoucherNumber(r.voucherNumber, inv.pointOfSale, inv.number));
                const reported = candidates.length === 1 ? candidates[0] : undefined;
                if (candidates.length > 1) {
                    // Ambigua: queda como está (el control de la presentación la muestra).
                } else if (reported) {
                    if (linked) actions.push({ kind: "delete", recordId: linked.id });
                    actions.push({ kind: "link", recordId: reported.id, invoiceId: inv.id });
                    taken.add(reported.id);
                } else if (linked) {
                    if (!linked.amount.equals(inv.vatPerceptionAmount) || linked.date.getTime() !== date.getTime()) {
                        actions.push({ kind: "update", recordId: linked.id, amount: inv.vatPerceptionAmount, date });
                    }
                } else {
                    actions.push({
                        kind: "create", invoiceId: inv.id, type: IVA_PERCEPTION_TYPE, amount: inv.vatPerceptionAmount, date,
                        agentCuit, voucherTypeCode: f2051Type, voucherNumber: f2051VoucherNumber(inv.pointOfSale, inv.number), jurisdictionCode: null,
                    });
                }
            }
        }

        // ── IIBB ──
        if (positive(inv.iibbPerceptionAmount)) {
            const linked = records.find((r) => r.invoiceId === inv.id && r.type === IIBB_PERCEPTION_TYPE && !taken.has(r.id));
            if (!linked) {
                actions.push({
                    kind: "create", invoiceId: inv.id, type: IIBB_PERCEPTION_TYPE, amount: inv.iibbPerceptionAmount, date,
                    agentCuit, voucherTypeCode: f2051Type, voucherNumber: f2051VoucherNumber(inv.pointOfSale, inv.number), jurisdictionCode: headquarters,
                });
            } else if (linked.fromInvoice && (!linked.amount.equals(inv.iibbPerceptionAmount) || linked.date.getTime() !== date.getTime() || linked.jurisdictionCode === null && headquarters !== null)) {
                actions.push({ kind: "update", recordId: linked.id, amount: inv.iibbPerceptionAmount, date, jurisdictionCode: linked.jurisdictionCode ?? headquarters });
            }
        }
    }
    return actions;
}

export type OtherTaxesKind = "IIBB_PERCEPTION" | "INTERNAL_TAXES" | "OTHER";
export const OTHER_TAXES_KINDS: readonly OtherTaxesKind[] = ["IIBB_PERCEPTION", "INTERNAL_TAXES", "OTHER"];

export interface OtherTaxesInvoice extends PerceptionInvoice {
    otherTaxesAmount: Prisma.Decimal | null;
    internalTaxesAmount: Prisma.Decimal | null;
}

export interface OtherTaxesSplit {
    invoiceId: string;
    otherTaxesAmount: Prisma.Decimal;
    vatPerceptionAmount: Prisma.Decimal;
    iibbPerceptionAmount: Prisma.Decimal;
    internalTaxesAmount: Prisma.Decimal;
}

const ZERO = new Prisma.Decimal(0);
const dz = (v: Prisma.Decimal | null) => v ?? ZERO;

/**
 * Separación de «Otros tributos» (Portal IVA los informa en un solo importe).
 * Función pura, idempotente; el total del comprobante no cambia:
 *  1. Percepción de IVA: si el comprobante no la tiene cargada y ARCA informó
 *     UNA percepción del mismo agente y comprobante, menor o igual a «Otros
 *     tributos», ese importe pasa a «Percepción de IVA».
 *  2. Resto: según la regla del proveedor, pasa a «Percepción de IIBB» o a
 *     «Impuestos internos»; sin regla (u «OTHER») queda en «Otros tributos».
 * Sólo facturas y notas de débito (las notas de crédito las define el estudio).
 */
export function planOtherTaxesSplit(
    invoices: OtherTaxesInvoice[],
    records: PerceptionRecord[],
    rules: ReadonlyMap<string, OtherTaxesKind>,
): OtherTaxesSplit[] {
    const out: OtherTaxesSplit[] = [];
    const taken = new Set<string>();
    for (const inv of invoices) {
        if (eligibleKind(inv) === null) continue;
        let other = dz(inv.otherTaxesAmount);
        if (!other.greaterThan(0)) continue;
        let vat = dz(inv.vatPerceptionAmount);
        let iibb = dz(inv.iibbPerceptionAmount);
        let internal = dz(inv.internalTaxesAmount);
        const agentCuit = inv.counterpartyDocType === 80 ? inv.counterpartyDocNumber : null;
        if (agentCuit === null) continue;

        if (vat.isZero()) {
            const candidates = records.filter((r) =>
                !taken.has(r.id) && !r.fromInvoice && r.type === IVA_PERCEPTION_TYPE && r.nature === "PERCEPTION"
                && (r.invoiceId === null || r.invoiceId === inv.id)
                && r.agentCuit === agentCuit && sameVoucherNumber(r.voucherNumber, inv.pointOfSale, inv.number));
            if (candidates.length === 1 && candidates[0].amount.greaterThan(0) && candidates[0].amount.lessThanOrEqualTo(other)) {
                vat = candidates[0].amount;
                other = other.minus(vat);
                taken.add(candidates[0].id);
            }
        }
        const kind = rules.get(agentCuit);
        if (other.greaterThan(0) && kind === "IIBB_PERCEPTION") { iibb = iibb.plus(other); other = ZERO; }
        if (other.greaterThan(0) && kind === "INTERNAL_TAXES") { internal = internal.plus(other); other = ZERO; }

        if (!other.equals(dz(inv.otherTaxesAmount))) {
            out.push({ invoiceId: inv.id, otherTaxesAmount: other, vatPerceptionAmount: vat, iibbPerceptionAmount: iibb, internalTaxesAmount: internal });
        }
    }
    return out;
}

/** Tipo de comprobante del F.2051 si corresponde crear o vincular automáticamente (facturas y notas de débito). */
function eligibleKind(inv: Pick<PerceptionInvoice, "voucherCode">): number | null {
    if (inv.voucherCode === null) return null;
    return F2051_TYPE_BY_KIND[voucherType(inv.voucherCode).kind] ?? null;
}

type Tx = Pick<Prisma.TransactionClient, "invoice" | "taxRecord" | "clientJurisdiction" | "supplierOtherTaxesRule">;

/** Concilia las percepciones del período (ver arriba). Devuelve la cantidad de cambios. */
export async function reconcileInvoicePerceptions(
    tx: Tx,
    scope: { organizationId: string; periodId: string; clientId: string; profileId: string | null },
): Promise<number> {
    const [invoices, records, jurisdictions, rules] = await Promise.all([
        tx.invoice.findMany({
            where: { organizationId: scope.organizationId, periodId: scope.periodId, category: "PURCHASES" },
            select: {
                id: true, voucherCode: true, pointOfSale: true, number: true, voucherDate: true, date: true,
                counterpartyDocType: true, counterpartyDocNumber: true, vatPerceptionAmount: true, iibbPerceptionAmount: true,
                otherTaxesAmount: true, internalTaxesAmount: true,
            },
        }),
        tx.taxRecord.findMany({
            where: { organizationId: scope.organizationId, periodId: scope.periodId, type: { in: [IVA_PERCEPTION_TYPE, IIBB_PERCEPTION_TYPE] } },
            select: { id: true, type: true, nature: true, amount: true, agentCuit: true, voucherNumber: true, invoiceId: true, fromInvoice: true, jurisdictionCode: true, date: true },
        }),
        tx.clientJurisdiction.findMany({
            where: { organizationId: scope.organizationId, clientId: scope.clientId },
            select: { jurisdictionCode: true, isHeadquarters: true },
        }),
        tx.supplierOtherTaxesRule.findMany({
            where: { organizationId: scope.organizationId, clientId: scope.clientId },
            select: { supplierCuit: true, kind: true },
        }),
    ]);
    // Sede: la marcada (Convenio Multilateral) o, si el cliente tiene una sola jurisdicción, esa.
    const headquarters = jurisdictions.find((j) => j.isHeadquarters)?.jurisdictionCode ?? (jurisdictions.length === 1 ? jurisdictions[0].jurisdictionCode : null);
    // Importes como Decimal (también si llegan como número o texto) y sólo compras.
    const dec = (v: Prisma.Decimal | number | string | null | undefined) => (v === null || v === undefined ? null : new Prisma.Decimal(v));
    const purchases = invoices
        .filter((i) => (i as { category?: string }).category === undefined || (i as { category?: string }).category === "PURCHASES")
        .map((i) => ({
            ...i, vatPerceptionAmount: dec(i.vatPerceptionAmount), iibbPerceptionAmount: dec(i.iibbPerceptionAmount),
            otherTaxesAmount: dec(i.otherTaxesAmount), internalTaxesAmount: dec(i.internalTaxesAmount),
        }));
    const decRecords = records.map((r) => ({ ...r, amount: new Prisma.Decimal(r.amount) }));
    const ruleMap = new Map((rules ?? []).filter((r) => (OTHER_TAXES_KINDS as readonly string[]).includes(r.kind)).map((r) => [r.supplierCuit, r.kind as OtherTaxesKind]));

    // 1) «Otros tributos» -> percepción de IVA (ARCA), percepción de IIBB o impuestos internos.
    const splits = planOtherTaxesSplit(purchases, decRecords, ruleMap);
    for (const split of splits) {
        await tx.invoice.updateMany({
            where: { id: split.invoiceId, organizationId: scope.organizationId, periodId: scope.periodId },
            data: {
                otherTaxesAmount: split.otherTaxesAmount, vatPerceptionAmount: split.vatPerceptionAmount,
                iibbPerceptionAmount: split.iibbPerceptionAmount, internalTaxesAmount: split.internalTaxesAmount,
                updatedById: scope.profileId,
            },
        });
        const inv = purchases.find((p) => p.id === split.invoiceId)!;
        Object.assign(inv, split);
    }

    // 2) Percepciones del comprobante -> Retenciones/Percepciones.
    const actions = planInvoicePerceptions(purchases, decRecords, headquarters);
    const by = scope.profileId;
    // Primero las bajas y desvinculaciones: liberan el índice único (comprobante, tipo).
    const order = { delete: 0, unlink: 1, link: 2, update: 3, create: 4 } as const;
    for (const a of [...actions].sort((x, y) => order[x.kind] - order[y.kind])) {
        const where = { id: "recordId" in a ? a.recordId : "", organizationId: scope.organizationId };
        switch (a.kind) {
            case "delete":
                await tx.taxRecord.deleteMany({ where: { ...where, fromInvoice: true } });
                break;
            case "unlink":
                await tx.taxRecord.updateMany({ where, data: { invoiceId: null, updatedById: by } });
                break;
            case "link":
                await tx.taxRecord.updateMany({ where, data: { invoiceId: a.invoiceId, updatedById: by } });
                break;
            case "update":
                await tx.taxRecord.updateMany({ where: { ...where, fromInvoice: true }, data: { amount: a.amount, date: a.date, ...(a.jurisdictionCode !== undefined ? { jurisdictionCode: a.jurisdictionCode } : {}), updatedById: by } });
                break;
            case "create":
                await tx.taxRecord.create({
                    data: {
                        organizationId: scope.organizationId, periodId: scope.periodId, type: a.type, amount: a.amount, date: a.date,
                        nature: a.type === IVA_PERCEPTION_TYPE ? "PERCEPTION" : null,
                        agentCuit: a.agentCuit, voucherTypeCode: a.type === IVA_PERCEPTION_TYPE ? a.voucherTypeCode : null,
                        voucherNumber: a.type === IVA_PERCEPTION_TYPE ? a.voucherNumber : null,
                        description: a.type === IVA_PERCEPTION_TYPE ? "Tomada del comprobante (percepción de IVA)" : "Tomada del comprobante (percepción de IIBB, jurisdicción sede)",
                        invoiceId: a.invoiceId, fromInvoice: true, jurisdictionCode: a.jurisdictionCode,
                        createdById: by, updatedById: by,
                    },
                });
                break;
        }
    }
    return splits.length + actions.length;
}

/**
 * Antes de borrar un comprobante (FK RESTRICT) o de vincular a mano otra
 * percepción del mismo tipo: borra las tomadas del comprobante (de ese tipo, si
 * se indica) y, al borrar el comprobante, desvincula las informadas por ARCA,
 * que quedan registradas. Con el Period ya bloqueado por el llamador.
 */
export async function releaseInvoicePerceptions(
    tx: Pick<Prisma.TransactionClient, "taxRecord">,
    scope: { organizationId: string; invoiceId: string; profileId: string | null },
    opts: { type?: string; unlinkReported: boolean },
): Promise<void> {
    await tx.taxRecord.deleteMany({ where: { organizationId: scope.organizationId, invoiceId: scope.invoiceId, fromInvoice: true, ...(opts.type ? { type: opts.type } : {}) } });
    if (opts.unlinkReported) {
        await tx.taxRecord.updateMany({ where: { organizationId: scope.organizationId, invoiceId: scope.invoiceId }, data: { invoiceId: null, updatedById: scope.profileId } });
    }
}
