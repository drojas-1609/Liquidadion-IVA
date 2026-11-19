"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { SidebarClient } from "@/lib/navigation/sidebar-data";
import { parseRoute } from "@/lib/navigation/menu";
import { rememberClient } from "./remember-client";

/** Quita tildes y pasa a minúsculas (y saca guiones del CUIT) para buscar. */
function norm(s: string): string {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/-/g, "").toLowerCase();
}

/** Buscador de cliente de la barra superior: elige el cliente con el que trabajan los módulos. */
export function ClientSwitcher({ clients, rememberedId }: { clients: SidebarClient[]; rememberedId: string | null }) {
    const pathname = usePathname() ?? "/";
    const router = useRouter();
    const route = parseRoute(pathname);
    const active = clients.find((c) => c.id === (route.clientId ?? rememberedId)) ?? null;
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [cursor, setCursor] = useState(0);
    const box = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);

    const matches = useMemo(() => {
        const q = norm(query.trim());
        return q ? clients.filter((c) => norm(c.name).includes(q) || norm(c.cuit).includes(q)) : clients;
    }, [clients, query]);

    useEffect(() => {
        if (!open) return;
        input.current?.focus();
        const onDown = (e: MouseEvent) => {
            if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    function choose(c: SidebarClient) {
        rememberClient(c.id);
        setOpen(false);
        setQuery("");
        router.push(`/client/${c.id}/dashboard`);
    }

    function clear() {
        rememberClient(null);
        setOpen(false);
        router.push("/clients");
        router.refresh();
    }

    return (
        <div className="client-switcher" ref={box}>
            <button type="button" className="client-switcher-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="7" />
                    <path d="M21 21l-4.3-4.3" />
                </svg>
                {active ? (
                    <span>
                        <strong>{active.name}</strong> <small>{active.cuit}</small>
                    </span>
                ) : (
                    <span className="is-placeholder">Seleccioná un cliente…</span>
                )}
            </button>
            {open && (
                <div className="client-switcher-pop">
                    <input
                        ref={input}
                        type="search"
                        placeholder="Buscar por razón social o CUIT"
                        aria-label="Buscar cliente"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setCursor(0);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") setOpen(false);
                            else if (e.key === "ArrowDown") {
                                e.preventDefault();
                                setCursor((i) => Math.min(i + 1, matches.length - 1));
                            } else if (e.key === "ArrowUp") {
                                e.preventDefault();
                                setCursor((i) => Math.max(i - 1, 0));
                            } else if (e.key === "Enter" && matches[cursor]) {
                                e.preventDefault();
                                choose(matches[cursor]);
                            }
                        }}
                    />
                    <ul role="listbox" aria-label="Clientes">
                        {matches.length === 0 && <li className="is-empty">Sin coincidencias.</li>}
                        {matches.map((c, i) => (
                            <li key={c.id} role="option" aria-selected={c.id === active?.id}>
                                <button type="button" className={i === cursor ? "is-cursor" : undefined} onMouseEnter={() => setCursor(i)} onClick={() => choose(c)}>
                                    <strong>{c.name}</strong>
                                    <small>{c.cuit}</small>
                                </button>
                            </li>
                        ))}
                    </ul>
                    {active && (
                        <button type="button" className="client-switcher-clear" onClick={clear}>
                            Quitar selección
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
