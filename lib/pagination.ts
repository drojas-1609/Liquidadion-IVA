/**
 * Paginación de listados por número de página (lógica pura).
 *
 * `?page=` llega del usuario: cualquier valor que no sea un entero positivo se
 * toma como la página 1, y una página posterior a la última se lleva a la última
 * (nunca se consulta con un desplazamiento fuera de rango).
 */
export const INVOICE_PAGE_SIZE = 100;

export interface PageWindow {
    page: number;
    pageCount: number;
    pageSize: number;
    skip: number;
    total: number;
    /** Posiciones 1-based mostradas; 0 y 0 si no hay filas. */
    from: number;
    to: number;
}

export function parsePageParam(raw: string | string[] | undefined): number {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v === undefined || !/^[1-9]\d{0,6}$/.test(v)) return 1;
    return Number(v);
}

export function pageWindow(requested: number, total: number, pageSize: number = INVOICE_PAGE_SIZE): PageWindow {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Math.floor(requested)), pageCount);
    const skip = (page - 1) * pageSize;
    return { page, pageCount, pageSize, skip, total, from: total === 0 ? 0 : skip + 1, to: Math.min(skip + pageSize, total) };
}
