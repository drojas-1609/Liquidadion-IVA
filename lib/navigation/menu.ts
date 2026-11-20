/**
 * Menú lateral por módulos (estilo «módulos del cliente»): funciones puras, sin
 * React, para poder probarlas. El componente sólo las dibuja.
 */

export interface MenuItem {
    label: string;
    /** Sin href: ítem anunciado pero todavía no disponible. */
    href?: string;
    hint?: string;
}

export interface MenuGroup {
    key: "resumen" | "impuestos" | "contabilidad" | "sueldos" | "respaldos" | "cliente";
    label: string;
    items: MenuItem[];
}

export interface RouteContext {
    clientId: string | null;
    periodId: string | null;
    /** Sub-pantalla del período (p. ej. "liquidation"); null en la pantalla del período. */
    periodPage: string | null;
}

/** Lee cliente, período y sub-pantalla desde la ruta actual. */
export function parseRoute(pathname: string): RouteContext {
    const m = /^\/client\/([^/?#]+)(?:\/period\/([^/?#]+)(?:\/([^/?#]+))?)?/.exec(pathname);
    if (!m) return { clientId: null, periodId: null, periodPage: null };
    const periodId = m[2] && m[2] !== "new" ? m[2] : null;
    return { clientId: m[1], periodId, periodPage: periodId ? m[3] ?? null : null };
}

/** Pantallas de un período que el selector de período conserva al cambiarlo. */
export const PERIOD_PAGES = ["sales", "purchases", "liquidation", "taxes", "presentation", "import"] as const;

export function periodHref(clientId: string, periodId: string, page: string | null): string {
    const base = `/client/${clientId}/period/${periodId}`;
    return page && (PERIOD_PAGES as readonly string[]).includes(page) ? `${base}/${page}` : base;
}

export const FINANCIAL_STATEMENTS = [
    "Estado de situación patrimonial",
    "Estado de resultados",
    "Estado de evolución del patrimonio neto",
    "Estado de flujo de efectivo",
    "Anexos y notas",
    "Informe del auditor",
] as const;

export function buildClientMenu(opts: { clientId: string; periodId: string | null; hasIva: boolean }): MenuGroup[] {
    const c = `/client/${opts.clientId}`;
    const groups: MenuGroup[] = [{ key: "resumen", label: "Resumen", items: [{ label: "Resumen del cliente", href: `${c}/dashboard` }] }];
    if (opts.hasIva) {
        const p = opts.periodId;
        groups.push({
            key: "impuestos",
            label: "Impuestos",
            items: p
                ? [
                      { label: "Período", href: `${c}/period/${p}` },
                      { label: "Libro IVA ventas", href: `${c}/period/${p}/sales` },
                      { label: "Libro IVA compras", href: `${c}/period/${p}/purchases` },
                      { label: "Liquidación IVA e IIBB", href: `${c}/period/${p}/liquidation` },
                      { label: "Ventas por actividad IIBB", href: `${c}/period/${p}/iibb-activities` },
                      { label: "Retenciones y percepciones", href: `${c}/period/${p}/taxes` },
                      { label: "Presentación ARCA", href: `${c}/period/${p}/presentation` },
                      { label: "Importar Libro IVA Digital", href: `${c}/period/${p}/import` },
                  ]
                : [{ label: "Crear el primer período", href: `${c}/period/new` }],
        });
    }
    groups.push(
        {
            key: "contabilidad",
            label: "Contabilidad",
            items: [
                { label: "Libro diario", href: `${c}/journal` },
                { label: "Plan de cuentas", href: `${c}/accounts` },
                { label: "Estados contables", hint: `Próximamente: ${FINANCIAL_STATEMENTS.join(", ")}.` },
            ],
        },
        { key: "sueldos", label: "Sueldos", items: [{ label: "F.931 y boletas sindicales", href: `${c}/payroll` }] },
        { key: "respaldos", label: "Respaldos", items: [{ label: "Respaldos en Drive", href: `${c}/backups` }] },
        { key: "cliente", label: "Cliente", items: [{ label: "Datos del cliente", href: `${c}/edit` }, { label: "IIBB por actividad", href: `${c}/iibb` }] },
    );
    return groups;
}

/** El ítem activo es el de href más largo que es prefijo de la ruta (por segmentos). */
export function activeHref(pathname: string, groups: MenuGroup[]): string | null {
    let best: string | null = null;
    for (const g of groups)
        for (const it of g.items) {
            if (!it.href) continue;
            const hit = pathname === it.href || pathname.startsWith(`${it.href}/`);
            if (hit && (!best || it.href.length > best.length)) best = it.href;
        }
    return best;
}
