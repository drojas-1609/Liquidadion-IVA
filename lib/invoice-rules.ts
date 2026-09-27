import { formatPeriodLabel, periodFirstDayIso, periodLastDayIso } from "./period";

/**
 * Reglas de negocio del alta/edición manual de comprobantes (PR B):
 *  - fecha del comprobante frente al período fiscal;
 *  - clave de duplicidad global por cliente (entre todos sus períodos).
 *
 * Lógica pura, sin Prisma ni `server-only`: apta para la API y el formulario.
 * Las fechas se comparan por día calendario UTC (el mismo que persiste
 * `@db.Date`), nunca en hora local. El formato y la validez de la fecha son
 * responsabilidad del parser de entrada (lib/api-input); acá llega una fecha
 * ya válida.
 *
 * Ninguna regla depende de la situación del cliente frente a IIBB: Convenio
 * Multilateral queda fuera de alcance y se tratará en una etapa específica.
 */

export type InvoiceRuleCategory = "SALES" | "PURCHASES";

interface PeriodYM {
    year: number;
    month: number;
}

// ── Fecha del comprobante ─────────────────────────────────────────────────

export type InvoiceWarningCode = "PURCHASE_PRIOR_PERIOD";

export interface InvoiceWarning {
    code: InvoiceWarningCode;
    message: string;
}

export type VoucherDateCheck =
    | { ok: true; warnings: InvoiceWarning[] }
    | { ok: false; field: "date"; error: string };

/** Clave numérica AAAAMMDD de un día ISO `YYYY-MM-DD` (orden = cronológico). */
const isoDayKey = (iso: string) => Number(iso.replace(/-/g, ""));
const displayDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const dateError = (error: string): VoucherDateCheck => ({ ok: false, field: "date", error });

/**
 * - Ventas: se rechaza sólo si la fecha no pertenece al mes y año del período.
 * - Compras: se rechaza sólo si la fecha es posterior al último día del
 *   período; toda fecha anterior al primer día se acepta con advertencia
 *   `PURCHASE_PRIOR_PERIOD`, sin límite de antigüedad.
 * No hay fecha mínima global.
 */
export function checkVoucherDate(
    category: InvoiceRuleCategory,
    voucherDate: Date,
    period: PeriodYM,
): VoucherDateCheck {
    // Día calendario UTC, por componentes (no por texto): mismo día que `@db.Date`.
    const y = voucherDate.getUTCFullYear();
    const m = voucherDate.getUTCMonth() + 1;
    const key = y * 10000 + m * 100 + voucherDate.getUTCDate();

    const last = periodLastDayIso(period);
    const firstKey = isoDayKey(periodFirstDayIso(period));
    const lastKey = isoDayKey(last);
    const label = formatPeriodLabel(period);

    if (category === "SALES") {
        if (key < firstKey || key > lastKey) {
            return dateError(`la fecha de una venta debe pertenecer al período ${label}`);
        }
        return { ok: true, warnings: [] };
    }

    if (key > lastKey) {
        return dateError(`la fecha de una compra no puede ser posterior al último día del período (${displayDate(last)})`);
    }
    if (key < firstKey) {
        return {
            ok: true,
            warnings: [
                {
                    code: "PURCHASE_PRIOR_PERIOD",
                    message: `El comprobante es de ${formatPeriodLabel({ year: y, month: m })}, anterior al período ${label}; se registra en ${label}.`,
                },
            ],
        };
    }
    return { ok: true, warnings: [] };
}

// ── Duplicidad global por cliente ─────────────────────────────────────────

export interface VoucherIdentity {
    organizationId: string;
    clientId: string;
    category: InvoiceRuleCategory;
    voucherCode: number;
    pointOfSale: number;
    number: number;
    counterpartyDocType: number;
    counterpartyDocNumber: string;
}

export interface DuplicateVoucherWhere {
    organizationId: string;
    clientId: string;
    category: InvoiceRuleCategory;
    voucherCode: number;
    pointOfSale: number;
    number: number;
    counterpartyDocType?: number;
    counterpartyDocNumber?: string;
    NOT?: { id: string };
}

/**
 * Filtro con la MISMA clave que los índices únicos parciales de la migración
 * del modelo contable:
 *  - ventas:  (clientId, voucherCode, pointOfSale, number)
 *  - compras: (clientId, counterpartyDocType, counterpartyDocNumber,
 *              voucherCode, pointOfSale, number)
 * Sin período: la duplicidad es entre TODOS los períodos del cliente.
 * `organizationId` se agrega como defensa en profundidad (aislamiento).
 * `excludeInvoiceId` excluye al propio comprobante en una edición.
 */
export function duplicateVoucherWhere(k: VoucherIdentity, excludeInvoiceId?: string): DuplicateVoucherWhere {
    const where: DuplicateVoucherWhere = {
        organizationId: k.organizationId,
        clientId: k.clientId,
        category: k.category,
        voucherCode: k.voucherCode,
        pointOfSale: k.pointOfSale,
        number: k.number,
    };
    if (k.category === "PURCHASES") {
        where.counterpartyDocType = k.counterpartyDocType;
        where.counterpartyDocNumber = k.counterpartyDocNumber;
    }
    if (excludeInvoiceId !== undefined) where.NOT = { id: excludeInvoiceId };
    return where;
}

/** Mensaje de conflicto: sólo identifica el período donde ya está cargado. */
export function duplicateVoucherMessage(period: PeriodYM): string {
    return `El comprobante ya existe en el período ${formatPeriodLabel(period)}.`;
}
