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
        const eligible = inv !== undefined && (r.type === IIBB_PERCEPTION_TYPE ? iibbEligible(inv) : eligibleKind(inv) !== null) && positive(amount);
        if (!eligible && (r.type === IVA_PERCEPTION_TYPE || r.type === IIBB_PERCEPTION_TYPE)) {
            actions.push(r.fromInvoice ? { kind: "delete", recordId: r.id } : { kind: "unlink", recordId: r.id });
            taken.add(r.id);
        }
    }

    for (const inv of invoices) {
        const f2051Type = eligibleKind(inv);
        if (f2051Type === null && !iibbEligible(inv)) continue;
        const date = inv.voucherDate ?? inv.date;
        if (date === null) continue; // sin fecha no se puede registrar (no se supone una)
        const agentCuit = inv.counterpartyDocType === 80 ? inv.counterpartyDocNumber : null;

        // ── IVA ── (sólo facturas y notas de débito: tabla del F.2051)
        if (f2051Type !== null && positive(inv.vatPerceptionAmount)) {
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
            const amount = signedIibb(inv, inv.iibbPerceptionAmount);
            const linked = records.find((r) => r.invoiceId === inv.id && r.type === IIBB_PERCEPTION_TYPE && !taken.has(r.id));
            if (!linked) {
                actions.push({
                    kind: "create", invoiceId: inv.id, type: IIBB_PERCEPTION_TYPE, amount, date,
                    agentCuit, voucherTypeCode: f2051Type, voucherNumber: f2051VoucherNumber(inv.pointOfSale, inv.number), jurisdictionCode: headquarters,
                });
            } else if (linked.fromInvoice && (!linked.amount.equals(amount) || linked.date.getTime() !== date.getTime() || linked.jurisdictionCode === null && headquarters !== null)) {
                actions.push({ kind: "update", recordId: linked.id, amount, date, jurisdictionCode: linked.jurisdictionCode ?? headquarters });
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
 * Facturas y notas de débito; las notas de crédito sólo por la regla (paso 2):
 * su percepción de IIBB resta la de la factura asociada (criterio del estudio,
 * 2026-11-17); la percepción de IVA de ARCA no se busca para ellas.
 */
export function planOtherTaxesSplit(
    invoices: OtherTaxesInvoice[],
    records: PerceptionRecord[],
    rules: ReadonlyMap<string, OtherTaxesKind>,
): OtherTaxesSplit[] {
    const out: OtherTaxesSplit[] = [];
    const taken = new Set<string>();
    for (const inv of invoices) {
        const credit = isCreditNote(inv);
        if (eligibleKind(inv) === null && !credit) continue;
        let other = dz(inv.otherTaxesAmount);
        if (!other.greaterThan(0)) continue;
        let vat = dz(inv.vatPerceptionAmount);
        let iibb = dz(inv.iibbPerceptionAmount);
        let internal = dz(inv.internalTaxesAmount);
        const agentCuit = inv.counterpartyDocType === 80 ? inv.counterpartyDocNumber : null;
        if (agentCuit === null) continue;

        if (vat.isZero() && !credit) {
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

/** ¿Nota de crédito? (criterio del estudio: su percepción de IIBB resta la aplicada en la factura asociada). */
function isCreditNote(inv: Pick<PerceptionInvoice, "voucherCode">): boolean {
    return inv.voucherCode !== null && voucherType(inv.voucherCode).kind === "CREDIT_NOTE";
}

/** Percepción de IIBB: facturas y notas de débito suman; notas de crédito restan. */
function iibbEligible(inv: Pick<PerceptionInvoice, "voucherCode">): boolean {
    return eligibleKind(inv) !== null || isCreditNote(inv);
}

/** Importe con signo del registro de IIBB tomado del comprobante (negativo en notas de crédito). */
function signedIibb(inv: Pick<PerceptionInvoice, "voucherCode">, amount: Prisma.Decimal): Prisma.Decimal {
    return isCreditNote(inv) ? amount.negated() : amount;
}

type Tx = Pick<Prisma.TransactionClient, "invoice" | "taxRecord" | "clientJurisdiction" | "supplierOtherTaxesRule">;

/**
 * Escrituras por tramo. Cada ida y vuelta a la base cuesta ~0,25 s desde
 * Netlify (medido: ~9 s por tramo de 12 en DEV) y la transacción del llamador
 * vence a los 10 s (lib/period-lock):
 * la conciliación aplica a lo sumo este tope y avisa si quedó trabajo
 * (`pending`). Es idempotente: el tramo siguiente recalcula el plan y sigue.
 */
export const RECONCILE_MAX_WRITES = 8;

/** Concilia las percepciones del período (ver arriba), en tramos acotados. */
export async function reconcileInvoicePerceptions(
    tx: Tx,
    scope: { organizationId: string; periodId: string; clientId: string; profileId: string | null },
    opts: { maxWrites?: number } = {},
): Promise<{ changes: number; pending: boolean }> {
    let budget = Math.max(1, opts.maxWrites ?? RECONCILE_MAX_WRITES);
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
    const splitsNow = splits.slice(0, budget);
    for (const split of splitsNow) {
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
    budget -= splitsNow.length;
    // Las percepciones dependen de la separación completa: si faltan tramos, siguen después.
    if (splitsNow.length < splits.length || budget === 0) {
        return { changes: splitsNow.length, pending: splitsNow.length < splits.length || planInvoicePerceptions(purchases, decRecords, headquarters).length > 0 };
    }

    // 2) Percepciones del comprobante -> Retenciones/Percepciones.
    const actions = planInvoicePerceptions(purchases, decRecords, headquarters);
    const by = scope.profileId;
    const org = scope.organizationId;
    let applied = 0;
    const of = <K extends PerceptionAction["kind"]>(kind: K) => actions.filter((a): a is Extract<PerceptionAction, { kind: K }> => a.kind === kind);
    // Primero las bajas y desvinculaciones (una sentencia cada una): liberan el índice único (comprobante, tipo).
    const deletes = of("delete"), unlinks = of("unlink");
    if (deletes.length > 0 && budget > 0) {
        await tx.taxRecord.deleteMany({ where: { id: { in: deletes.map((a) => a.recordId) }, organizationId: org, fromInvoice: true } });
        applied += deletes.length; budget--;
    }
    if (unlinks.length > 0 && budget > 0) {
        await tx.taxRecord.updateMany({ where: { id: { in: unlinks.map((a) => a.recordId) }, organizationId: org }, data: { invoiceId: null, updatedById: by } });
        applied += unlinks.length; budget--;
    }
    // Vínculos y actualizaciones: una por registro, hasta el tope.
    const singles = [...of("link"), ...of("update")];
    for (const a of singles) {
        if (budget === 0) break;
        if (a.kind === "link") {
            await tx.taxRecord.updateMany({ where: { id: a.recordId, organizationId: org }, data: { invoiceId: a.invoiceId, updatedById: by } });
        } else {
            await tx.taxRecord.updateMany({ where: { id: a.recordId, organizationId: org, fromInvoice: true }, data: { amount: a.amount, date: a.date, ...(a.jurisdictionCode !== undefined ? { jurisdictionCode: a.jurisdictionCode } : {}), updatedById: by } });
        }
        applied++; budget--;
    }
    // Altas: todas en una sentencia.
    const creates = of("create");
    if (creates.length > 0 && budget > 0) {
        await tx.taxRecord.createMany({
            data: creates.map((a) => ({
                organizationId: org, periodId: scope.periodId, type: a.type, amount: a.amount, date: a.date,
                nature: a.type === IVA_PERCEPTION_TYPE ? "PERCEPTION" as const : null,
                agentCuit: a.agentCuit, voucherTypeCode: a.type === IVA_PERCEPTION_TYPE ? a.voucherTypeCode : null,
                voucherNumber: a.type === IVA_PERCEPTION_TYPE ? a.voucherNumber : null,
                description: a.type === IVA_PERCEPTION_TYPE ? "Tomada del comprobante (percepción de IVA)"
                    : a.amount.isNegative() ? "Tomada de la nota de crédito (resta la percepción de IIBB, jurisdicción sede)"
                    : "Tomada del comprobante (percepción de IIBB, jurisdicción sede)",
                invoiceId: a.invoiceId, fromInvoice: true, jurisdictionCode: a.jurisdictionCode,
                createdById: by, updatedById: by,
            })),
        });
        applied += creates.length; budget--;
    }
    return { changes: splitsNow.length + applied, pending: applied < actions.length };
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
