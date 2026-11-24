"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { SidebarClient } from "@/lib/navigation/sidebar-data";
import { activeHref, buildClientMenu, parseRoute, periodHref } from "@/lib/navigation/menu";
import { rememberClient } from "./remember-client";

/**
 * Módulos del cliente activo en la barra lateral (Impuestos, Contabilidad,
 * Sueldos, Respaldos). El cliente activo sale de la ruta; si la ruta no es de
 * un cliente, del último elegido en el selector (cookie).
 */
export function ClientMenu({ clients, hasIva, rememberedId }: { clients: SidebarClient[]; hasIva: boolean; rememberedId: string | null }) {
    const pathname = usePathname() ?? "/";
    const router = useRouter();
    const route = parseRoute(pathname);
    const client = clients.find((c) => c.id === (route.clientId ?? rememberedId)) ?? null;

    // Recordar el cliente que se está viendo, para volver a él desde otras secciones.
    useEffect(() => {
        if (route.clientId && route.clientId !== rememberedId && clients.some((c) => c.id === route.clientId)) rememberClient(route.clientId);
    }, [route.clientId, rememberedId, clients]);

    if (!client) return null;
    const periodId = client.periods.some((p) => p.id === route.periodId) ? route.periodId : client.periods[0]?.id ?? null;
    const groups = buildClientMenu({ clientId: client.id, periodId, hasIva });
    const current = activeHref(pathname, groups);

    return (
        <div className="client-menu">
            <Link href={`/client/${client.id}/dashboard`} className="client-menu-head" title={`${client.name} · ${client.cuit}`}>
                <small>Cliente</small>
                <strong>{client.name}</strong>
                <span>{client.cuit}</span>
            </Link>
            {groups.map((g) => (
                <details key={g.key} className="menu-group" open={g.key !== "cliente" || g.items.some((i) => i.href === current)}>
                    <summary>{g.label}</summary>
                    {g.key === "impuestos" && periodId && client.periods.length > 1 && (
                        <label className="menu-period">
                            <span className="sr-only">Período</span>
                            <select
                                value={periodId}
                                onChange={(e) => router.push(periodHref(client.id, e.target.value, route.periodId ? route.periodPage : "liquidation"))}
                            >
                                {client.periods.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.label}
                                        {p.closed ? " · cerrado" : ""}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    {g.key === "impuestos" && periodId && client.periods.length === 1 && (
                        <p className="menu-period-single">Período {client.periods[0].label}</p>
                    )}
                    {g.items.map((it, i) => [
                        it.section && it.section !== g.items[i - 1]?.section && (
                            <p key={`s-${it.section}`} className="menu-section">{it.section}</p>
                        ),
                        it.href ? (
                            <Link key={it.label} href={it.href} className="menu-item" aria-current={it.href === current ? "page" : undefined}>
                                {it.label}
                            </Link>
                        ) : (
                            <span key={it.label} className="menu-item is-soon" title={it.hint} aria-disabled="true">
                                {it.label} <em>próximamente</em>
                            </span>
                        ),
                    ])}
                </details>
            ))}
        </div>
    );
}
