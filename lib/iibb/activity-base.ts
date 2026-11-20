import { Prisma } from "@prisma/client";
import { D, roundMoney, sum } from "../decimal";

/**
 * IIBB por actividad (fase F1, contribuyente LOCAL de una jurisdicción).
 *
 * Criterio del estudio (20/11/2026): cada venta se asigna a una actividad
 *   1. corrección manual del comprobante, si la hay;
 *   2. si no, la actividad asignada a su punto de venta;
 *   3. si no, la actividad principal del cliente.
 * El impuesto es Σ (base de la actividad × alícuota de la actividad en la
 * jurisdicción), redondeado por actividad. Si una actividad no tiene alícuota
 * informada (o la venta no tiene actividad), se usa la alícuota de respaldo
 * de la ficha y se informa como advertencia: nunca se inventa una alícuota.
 */

export type ActivitySource = "MANUAL" | "POS" | "PRINCIPAL" | "NONE";
export type RateSource = "ACTIVITY" | "EXEMPT" | "FALLBACK";

export interface IibbActivityRate {
    code: string;
    description: string;
    /** Alícuota en la jurisdicción (porcentaje); null = sin informar. */
    rate: Prisma.Decimal | null;
    exempt: boolean;
}

export interface IibbActivityConfig {
    jurisdictionCode: string;
    principalCode: string | null;
    /** Punto de venta → código de actividad. */
    posMap: Readonly<Record<number, string>>;
    activities: readonly IibbActivityRate[];
}

/** Ventas agrupadas: base IIBB con signo por punto de venta y corrección manual. */
export interface IibbSaleSlice {
    pointOfSale: number | null;
    manualCode: string | null;
    base: Prisma.Decimal;
}

export interface IibbActivityLine {
    /** null: ventas sin actividad asignable. */
    code: string | null;
    description: string;
    base: Prisma.Decimal;
    rate: Prisma.Decimal;
    tax: Prisma.Decimal;
    rateSource: RateSource;
    /** Cómo se asignaron sus ventas (puede haber varias fuentes). */
    sources: ActivitySource[];
}

export interface IibbActivityResult {
    lines: IibbActivityLine[];
    base: Prisma.Decimal;
    tax: Prisma.Decimal;
    /** Alícuota efectiva (impuesto / base), para pantallas y exportaciones. */
    effectiveRate: Prisma.Decimal;
    warnings: string[];
}

export function resolveActivity(slice: Pick<IibbSaleSlice, "pointOfSale" | "manualCode">, cfg: IibbActivityConfig): { code: string | null; source: ActivitySource } {
    const known = (c: string | null | undefined): c is string => !!c && cfg.activities.some((a) => a.code === c);
    if (known(slice.manualCode)) return { code: slice.manualCode, source: "MANUAL" };
    const pos = slice.pointOfSale != null ? cfg.posMap[slice.pointOfSale] : undefined;
    if (known(pos)) return { code: pos, source: "POS" };
    if (known(cfg.principalCode)) return { code: cfg.principalCode, source: "PRINCIPAL" };
    return { code: null, source: "NONE" };
}

const pct = (r: Prisma.Decimal) => r.toFixed(2).replace(".", ",");

export function iibbByActivity(slices: readonly IibbSaleSlice[], cfg: IibbActivityConfig, fallbackRate: Prisma.Decimal): IibbActivityResult {
    const groups = new Map<string, { code: string | null; base: Prisma.Decimal[]; sources: Set<ActivitySource> }>();
    for (const s of slices) {
        const r = resolveActivity(s, cfg);
        const key = r.code ?? "";
        const g = groups.get(key) ?? { code: r.code, base: [], sources: new Set<ActivitySource>() };
        g.base.push(s.base);
        g.sources.add(r.source);
        groups.set(key, g);
    }
    const warnings: string[] = [];
    if (!cfg.principalCode || !cfg.activities.some((a) => a.code === cfg.principalCode)) {
        warnings.push("El cliente no tiene actividad principal de IIBB definida.");
    }
    const lines: IibbActivityLine[] = [];
    for (const g of [...groups.values()].sort((a, b) => (a.code ?? "~").localeCompare(b.code ?? "~"))) {
        const base = sum(g.base);
        const act = g.code ? cfg.activities.find((a) => a.code === g.code) ?? null : null;
        let rate: Prisma.Decimal;
        let rateSource: RateSource;
        if (act?.exempt) {
            rate = D(0);
            rateSource = "EXEMPT";
        } else if (act?.rate != null) {
            rate = act.rate;
            rateSource = "ACTIVITY";
        } else {
            rate = fallbackRate;
            rateSource = "FALLBACK";
            if (!base.isZero()) {
                warnings.push(
                    act
                        ? `La actividad ${act.code} no tiene alícuota informada en la jurisdicción ${cfg.jurisdictionCode}: se usó la alícuota de respaldo (${pct(fallbackRate)} %).`
                        : `Hay ventas sin actividad asignada: se usó la alícuota de respaldo (${pct(fallbackRate)} %).`,
                );
            }
        }
        lines.push({
            code: g.code,
            description: act?.description ?? "Sin actividad asignada",
            base,
            rate,
            tax: roundMoney(base.times(rate).div(100)),
            rateSource,
            sources: [...g.sources].sort(),
        });
    }
    const base = sum(lines.map((l) => l.base));
    const tax = sum(lines.map((l) => l.tax));
    return { lines, base, tax, effectiveRate: base.isZero() ? (lines[0]?.rate ?? fallbackRate) : tax.div(base).times(100).toDecimalPlaces(6), warnings };
}
