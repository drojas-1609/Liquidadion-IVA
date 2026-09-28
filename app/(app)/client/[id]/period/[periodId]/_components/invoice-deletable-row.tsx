"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Filas de ventas / compras que se dejan de renderizar DESPUÉS de una baja
 * confirmada por el servidor (204), sin esperar a que router.refresh() traiga
 * la lista nueva. No es borrado optimista: mientras el DELETE está pendiente o
 * si falla, la fila sigue visible.
 *
 * El anuncio de la baja vive en una región `role="status"` FUERA de la tabla
 * (HTML de tabla válido), así sobrevive a la desaparición de la fila. Al
 * retirar la fila, el foco pasa al contenedor de la lista (no queda en el
 * body).
 *
 * Limitación: si se elimina la última fila, el mensaje de lista vacía aparece
 * recién cuando llega el refresco del Server Component.
 */
export interface InvoiceRowDeletion {
    isDeleted(invoiceId: string): boolean;
    markDeleted(invoiceId: string, announcement: string): void;
}

export const InvoiceRowDeletionContext = createContext<InvoiceRowDeletion | null>(null);

/** Ids eliminados localmente: el conjunto previo más `invoiceId` (sin mutar). */
export function withDeletedRow(ids: ReadonlySet<string>, invoiceId: string): ReadonlySet<string> {
    if (ids.has(invoiceId)) return ids;
    const next = new Set(ids);
    next.add(invoiceId);
    return next;
}

const VISUALLY_HIDDEN = {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0,
} as const;

export function DeletableInvoiceRows({ label, children }: { label: string; children: ReactNode }) {
    const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
    const [announcement, setAnnouncement] = useState("");
    const container = useRef<HTMLDivElement>(null);

    const markDeleted = useCallback((invoiceId: string, message: string) => {
        setDeletedIds((prev) => withDeletedRow(prev, invoiceId));
        setAnnouncement(message);
        // La fila (y el botón con foco) desaparece: el foco pasa a la lista.
        container.current?.focus();
    }, []);
    const value = useMemo<InvoiceRowDeletion>(
        () => ({ isDeleted: (invoiceId) => deletedIds.has(invoiceId), markDeleted }),
        [deletedIds, markDeleted],
    );

    return (
        <InvoiceRowDeletionContext.Provider value={value}>
            <div ref={container} tabIndex={-1} aria-label={label} style={{ outline: "none" }}>
                {children}
            </div>
            <p role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
                {announcement}
            </p>
        </InvoiceRowDeletionContext.Provider>
    );
}

/** `<tr>` de un comprobante; no se renderiza si ya fue eliminado localmente. */
export function DeletableInvoiceRow({ invoiceId, children }: { invoiceId: string; children: ReactNode }) {
    const deletion = useContext(InvoiceRowDeletionContext);
    if (deletion?.isDeleted(invoiceId)) return null;
    return <tr>{children}</tr>;
}

/** Para las acciones de la fila: marca la baja confirmada (no-op sin contenedor). */
export function useMarkInvoiceDeleted(): (invoiceId: string, announcement: string) => void {
    const deletion = useContext(InvoiceRowDeletionContext);
    return deletion?.markDeleted ?? noop;
}

function noop() {}
