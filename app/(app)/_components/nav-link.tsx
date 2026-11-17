"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS: Record<string, string> = {
    "/": "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10",
    "/clients": "M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a4 4 0 100-8 4 4 0 000 8zM22 19v-1a4 4 0 00-3-3.87M16 2.13a4 4 0 010 7.75",
    "/settings": "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z",
};

/** Enlace de la barra lateral; marca la sección actual (los clientes incluyen sus períodos). */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
    const path = usePathname() ?? "/";
    const active = href === "/" ? path === "/" : path.startsWith(href) || (href === "/clients" && path.startsWith("/client/"));
    return (
        <Link href={href} className="nav-link" aria-current={active ? "page" : undefined}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={ICONS[href] ?? ""} />
            </svg>
            {children}
        </Link>
    );
}
