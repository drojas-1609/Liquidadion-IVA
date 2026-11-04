import Link from "next/link";
import type { PageWindow } from "@/lib/pagination";

/** Navegación del detalle paginado (enlaces del servidor, sin estado del cliente). */
export function InvoicePager({ basePath, window, noun }: { basePath: string; window: PageWindow; noun: string }) {
    const href = (page: number) => (page === 1 ? basePath : `${basePath}?page=${page}`);
    const { page, pageCount, from, to, total } = window;
    return (
        <nav aria-label={`Páginas de ${noun}`} data-invoice-pager style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", flexWrap: "wrap", margin: "var(--spacing-md) 0" }}>
            <span style={{ color: "var(--secondary)" }}>
                {total === 0 ? `Sin ${noun}.` : `Mostrando ${from.toLocaleString("es-AR")}–${to.toLocaleString("es-AR")} de ${total.toLocaleString("es-AR")} ${noun}.`}
                {" "}Los totales del período están en el resumen del período.
            </span>
            {pageCount > 1 && (
                <span style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
                    {page > 1 ? <Link href={href(1)} className="btn btn-secondary">« Primera</Link> : null}
                    {page > 1 ? <Link href={href(page - 1)} className="btn btn-secondary" rel="prev">‹ Anterior</Link> : null}
                    <span>Página {page} de {pageCount}</span>
                    {page < pageCount ? <Link href={href(page + 1)} className="btn btn-secondary" rel="next">Siguiente ›</Link> : null}
                    {page < pageCount ? <Link href={href(pageCount)} className="btn btn-secondary">Última »</Link> : null}
                </span>
            )}
        </nav>
    );
}
