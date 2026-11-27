/**
 * Base de IIBB por diferencia (criterio del estudio): reparto del costo de cada
 * compra a un prestador entre actividades (lógica pura).
 *
 * Neto de una compra = gravado (por alícuota) + exento + no gravado + sin IVA
 * discriminado (facturas C, por el total), con el signo del comprobante.
 *
 * Modos del prestador:
 * - SINGLE: todo a la actividad del prestador.
 * - BY_VAT_RATE: cada parte según su alícuota (rateMap); lo no mapeado, a la
 *   actividad del prestador. «EXENTO» = exento + no gravado; «SIN_IVA» = sin IVA
 *   discriminado (facturas C).
 * - MANUAL: cada factura se reparte a mano; mientras no se reparta, NO resta
 *   (criterio conservador: la base no baja sin una decisión del estudio).
 * Un reparto manual cargado para una factura manda sobre cualquier modo.
 * Actividad "" = esa parte no resta de ninguna base.
 */
import { Prisma } from "@prisma/client";

import { PROVIDER_MODES, RATE_MAP_KEYS, RATE_MAP_LABELS, type ProviderMode, type RateMap } from "./provider-modes";
export { PROVIDER_MODES, RATE_MAP_KEYS, RATE_MAP_LABELS, type ProviderMode, type RateMap };

export interface CostProvider {
    cuit: string;
    name: string;
    activityCode: string;
    mode: ProviderMode;
    rateMap: RateMap | null;
}

export interface CostInvoice {
    id: string;
    sign: 1 | -1;
    /** Partes por alícuota (código ARCA → neto, sin signo). */
    vatNets: Array<{ code: number; net: Prisma.Decimal }>;
    exemptAndNonTaxed: Prisma.Decimal;
    withoutVat: Prisma.Decimal;
    /** Filas heredadas: sólo el neto total (sin desglose). */
    legacyNet: Prisma.Decimal | null;
    /** Reparto manual cargado (importes positivos). */
    splits: Array<{ activityCode: string; amount: Prisma.Decimal }>;
}

const ZERO = new Prisma.Decimal(0);

export function invoiceNet(i: CostInvoice): Prisma.Decimal {
    if (i.legacyNet !== null) return i.legacyNet;
    return i.vatNets.reduce((a, v) => a.plus(v.net), ZERO).plus(i.exemptAndNonTaxed).plus(i.withoutVat);
}

export type Allocation = { byActivity: Map<string, Prisma.Decimal>; pending: boolean; manual: boolean; net: Prisma.Decimal };

/** Reparte una compra (con su signo). `pending` = MANUAL sin reparto: no resta nada. */
export function allocateCost(p: CostProvider, i: CostInvoice): Allocation {
    const by = new Map<string, Prisma.Decimal>();
    const add = (code: string, v: Prisma.Decimal) => {
        if (v.isZero()) return;
        by.set(code, (by.get(code) ?? ZERO).plus(v.times(i.sign)));
    };
    const net = invoiceNet(i).times(i.sign);
    if (i.splits.length > 0) {
        for (const s of i.splits) add(s.activityCode, s.amount);
        return { byActivity: by, pending: false, manual: true, net };
    }
    if (p.mode === "MANUAL") return { byActivity: by, pending: true, manual: false, net };
    if (p.mode === "SINGLE" || i.legacyNet !== null) {
        add(p.activityCode, invoiceNet(i));
        return { byActivity: by, pending: false, manual: false, net };
    }
    const target = (k: string) => {
        const t = p.rateMap?.[k as keyof RateMap];
        return t === undefined ? p.activityCode : t;
    };
    for (const v of i.vatNets) add(target(String(v.code)), v.net);
    add(target("EXENTO"), i.exemptAndNonTaxed);
    add(target("SIN_IVA"), i.withoutVat);
    return { byActivity: by, pending: false, manual: false, net };
}

/** Valida un mapa por alícuota contra las actividades de la ficha ("" = no resta). */
export function parseRateMap(raw: unknown, codes: ReadonlySet<string>): { ok: true; value: RateMap } | { ok: false; error: string } {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "mapa por alícuota inválido" };
    const out: RateMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!(RATE_MAP_KEYS as readonly string[]).includes(k)) return { ok: false, error: `alícuota desconocida en el mapa: ${k}` };
        if (typeof v !== "string" || (v !== "" && !codes.has(v))) return { ok: false, error: `la actividad para ${RATE_MAP_LABELS[k as keyof typeof RATE_MAP_LABELS]} debe ser una actividad de la ficha o «no resta»` };
        out[k as keyof RateMap] = v;
    }
    return { ok: true, value: out };
}

/**
 * Valida un reparto manual: importes positivos (hasta 2 decimales, coma o punto),
 * actividades de la ficha o "" (no resta), sin repetir; la suma debe igualar el
 * neto de la factura (en valor absoluto). Lista vacía = quitar el reparto.
 */
export function parseSplits(raw: unknown, codes: ReadonlySet<string>, invoiceNetAbs: Prisma.Decimal): { ok: true; value: Array<{ activityCode: string; amount: string }> } | { ok: false; error: string } {
    if (!Array.isArray(raw) || raw.length > 20) return { ok: false, error: "reparto inválido" };
    const seen = new Set<string>();
    const out: Array<{ activityCode: string; amount: string }> = [];
    let total = ZERO;
    for (const r of raw) {
        const x = r as Record<string, unknown> | null;
        if (!x || typeof x !== "object" || typeof x.activityCode !== "string" || typeof x.amount !== "string") return { ok: false, error: "fila de reparto inválida" };
        if (x.activityCode !== "" && !codes.has(x.activityCode)) return { ok: false, error: "la actividad debe ser una actividad de la ficha o «no resta»" };
        if (seen.has(x.activityCode)) return { ok: false, error: "actividad repetida en el reparto" };
        seen.add(x.activityCode);
        const t = x.amount.trim().replace(/\s/g, "");
        const n = /,/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t;
        if (!/^\d{1,16}(\.\d{1,2})?$/.test(n) || Number(n) <= 0) return { ok: false, error: "importe inválido: pesos positivos, hasta 2 decimales" };
        total = total.plus(n);
        out.push({ activityCode: x.activityCode, amount: n });
    }
    if (out.length > 0 && !total.equals(invoiceNetAbs)) {
        return { ok: false, error: `el reparto suma $ ${total.toFixed(2)} y el neto de la factura es $ ${invoiceNetAbs.toFixed(2)}` };
    }
    return { ok: true, value: out };
}
