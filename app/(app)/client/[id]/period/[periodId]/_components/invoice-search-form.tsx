import Link from "next/link";

/**
 * Buscador del detalle de ventas o compras: formulario GET (sin estado del
 * cliente). Busca en todo el período: razón social, CUIT, comprobante
 * («PV-número» o número) o importe total. lib/invoice-search interpreta el texto.
 */
export function InvoiceSearchForm({ basePath, query, noun, matches }: { basePath: string; query: string; noun: string; matches: number }) {
    return (
        <form method="get" action={basePath} role="search" aria-label={`Buscar ${noun}`} className="toolbar invoice-search">
            <input
                type="search"
                name="q"
                defaultValue={query}
                maxLength={60}
                placeholder="Razón social, CUIT, comprobante (7-13442) o importe (909.799,99)"
                aria-label={`Buscar ${noun}`}
                className="input"
            />
            <button type="submit" className="btn btn-primary">Buscar</button>
            {query && <Link href={basePath} className="btn btn-secondary">Limpiar</Link>}
            {query && (
                <span className="muted text-sm" role="status">
                    {matches === 0 ? `Ninguna ${noun.replace(/s$/, "")} coincide con «${query}».` : `${matches.toLocaleString("es-AR")} coincidencias con «${query}».`}
                </span>
            )}
        </form>
    );
}
