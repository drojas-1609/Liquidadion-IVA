import { describe, it, expect, vi, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import { startConfirmTiming } from "@/lib/libro-iva-import/timing";

const req = (id: string | null) => new Request("https://x.test/api", { method: "POST", headers: id ? { "x-nf-request-id": id } : {} });

function clock(steps: number[]) {
    let i = 0;
    return () => steps[Math.min(i++, steps.length - 1)];
}

afterEach(() => vi.restoreAllMocks());

describe("tiempos de la confirmación de la importación", () => {
    it("éxito: separa plan, bloqueo, escritura y commit; Server-Timing y un log con el id de Netlify", () => {
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        // t0=0, plan=1200, lock=1300, write=9300, commit=9500, total=9500
        const t = startConfirmTiming(req("01ABC"), clock([0, 1200, 1300, 9300, 9500, 9500]));
        t.mark("plan", { rows: 4001, vatLines: 5335 });
        t.mark("lock");
        t.mark("write");
        expect(t.done()).toBe("plan;dur=1200, lock;dur=100, write;dur=8000, commit;dur=200");
        expect(info).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(String(info.mock.calls[0][0]).replace("[libro-iva-import] confirm ", ""));
        expect(logged).toEqual({ requestId: "01ABC", outcome: "ok", stage: "commit", rows: 4001, vatLines: 5335, ms: { plan: 1200, lock: 100, write: 8000, commit: 200, total: 9500 } });
    });

    it("falla en la escritura: registra la etapa, el código de Prisma y sólo conteos y tiempos", () => {
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const t = startConfirmTiming(req(null), clock([0, 1000, 1100, 11100, 11100]));
        t.mark("plan", { rows: 9001, vatLines: 12002 });
        t.mark("lock");
        t.fail(new Prisma.PrismaClientKnownRequestError("Transaction already closed: postgres://secret", { code: "P2028", clientVersion: "6" }));
        const line = String(info.mock.calls[0][0]);
        expect(line).not.toMatch(/secret|postgres/);
        const logged = JSON.parse(line.replace("[libro-iva-import] confirm ", ""));
        expect(logged).toEqual({ requestId: null, outcome: "error:P2028", stage: "write", rows: 9001, vatLines: 12002, ms: { plan: 1000, lock: 100, write: 10000, total: 11100 } });
    });

    it("error que no es de Prisma: sólo la clase", () => {
        const info = vi.spyOn(console, "info").mockImplementation(() => {});
        const t = startConfirmTiming(req("r"), clock([0, 5, 5]));
        t.fail(new TypeError("detalle sensible"));
        expect(String(info.mock.calls[0][0])).toContain('"outcome":"error:TypeError"');
        expect(String(info.mock.calls[0][0])).not.toContain("sensible");
    });
});
