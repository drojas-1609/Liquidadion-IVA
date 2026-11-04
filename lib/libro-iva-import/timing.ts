import { Prisma } from "@prisma/client";

/**
 * Tiempos de la confirmación de la importación, para correlacionar con los
 * logs de Netlify (`x-nf-request-id`) y separar:
 *  - plan:  recálculo de la vista previa (lectura de los archivos, claves ya
 *           cargadas y armado de las filas), fuera de la transacción;
 *  - lock:  bloqueo del período + relectura de duplicados, ya en la transacción;
 *  - write: los dos createMany;
 *  - commit: auditoría + COMMIT.
 * Sólo registra conteos, milisegundos, el id de la solicitud y el código o la
 * clase del error: nunca CUIT, nombres, importes ni mensajes (que podrían traer
 * cadenas de conexión).
 */
export function startConfirmTiming(request: Request, now: () => number = Date.now) {
    const t0 = now();
    const requestId = request.headers.get("x-nf-request-id");
    const ms: Record<string, number> = {};
    let last = t0;
    let stage = "plan";
    const counts: { rows?: number; vatLines?: number } = {};
    const lap = (name: string) => {
        const t = now();
        ms[name] = t - last;
        last = t;
    };
    const log = (outcome: string) => {
        console.info("[libro-iva-import] confirm " + JSON.stringify({ requestId, outcome, stage, ...counts, ms: { ...ms, total: now() - t0 } }));
    };
    return {
        mark(name: "plan" | "lock" | "write", c?: { rows: number; vatLines: number }) {
            lap(name);
            if (c) Object.assign(counts, c);
            stage = name === "plan" ? "lock" : name === "lock" ? "write" : "commit";
        },
        fail(err: unknown) {
            lap(stage);
            const code = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : err instanceof Error ? err.name : typeof err;
            log("error:" + code);
        },
        /** Cierra la medición y devuelve el valor del encabezado Server-Timing. */
        done(): string {
            lap("commit");
            log("ok");
            return Object.entries(ms).map(([k, v]) => `${k};dur=${v}`).join(", ");
        },
    };
}
