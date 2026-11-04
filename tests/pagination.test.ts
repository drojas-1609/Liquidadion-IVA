import { describe, it, expect } from "vitest";
import { INVOICE_PAGE_SIZE, pageWindow, parsePageParam } from "@/lib/pagination";

describe("paginación de comprobantes", () => {
    it("?page= inválido se toma como 1", () => {
        for (const v of [undefined, "", "0", "-3", "1.5", "abc", "1e3", "01", " 2", "99999999"]) expect(parsePageParam(v)).toBe(1);
        expect(parsePageParam("7")).toBe(7);
        expect(parsePageParam(["3", "9"])).toBe(3);
    });
    it("ventana de la página y recorte a la última", () => {
        expect(INVOICE_PAGE_SIZE).toBe(100);
        expect(pageWindow(1, 0)).toEqual({ page: 1, pageCount: 1, pageSize: 100, skip: 0, total: 0, from: 0, to: 0 });
        expect(pageWindow(1, 18002)).toMatchObject({ page: 1, pageCount: 181, skip: 0, from: 1, to: 100 });
        expect(pageWindow(181, 18002)).toMatchObject({ page: 181, skip: 18000, from: 18001, to: 18002 });
        expect(pageWindow(999, 42011)).toMatchObject({ page: 421, pageCount: 421, skip: 42000, from: 42001, to: 42011 });
        expect(pageWindow(2, 100)).toMatchObject({ page: 1, pageCount: 1, from: 1, to: 100 });
    });
});
