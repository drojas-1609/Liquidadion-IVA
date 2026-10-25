import "server-only";

/**
 * Límite de uso de la consulta de CUIT (ventana deslizante en memoria).
 *
 * Por usuario y por organización. En funciones serverless cada instancia lleva
 * su propia cuenta: es un freno contra el uso abusivo desde la UI, no un cupo
 * global exacto (documentado en docs/clientes-ficha/README.md).
 */
export interface RateLimitRule {
    limit: number;
    windowMs: number;
}

export const ARCA_LOOKUP_LIMITS = {
    perProfile: { limit: 10, windowMs: 60_000 },
    perOrganization: { limit: 60, windowMs: 60 * 60_000 },
} as const;

export class SlidingWindowLimiter {
    private readonly hits = new Map<string, number[]>();

    constructor(private readonly maxKeys = 5_000) {}

    /** Registra un intento; false si excede alguna regla (y entonces NO lo cuenta). */
    tryConsume(entries: Array<{ key: string; rule: RateLimitRule }>, nowMs: number): boolean {
        const pruned = entries.map(({ key, rule }) => {
            const list = (this.hits.get(key) ?? []).filter((t) => t > nowMs - rule.windowMs);
            return { key, rule, list };
        });
        if (pruned.some(({ rule, list }) => list.length >= rule.limit)) {
            for (const { key, list } of pruned) this.hits.set(key, list);
            return false;
        }
        for (const { key, list } of pruned) {
            list.push(nowMs);
            this.hits.set(key, list);
        }
        if (this.hits.size > this.maxKeys) {
            const oldest = this.hits.keys().next().value;
            if (oldest !== undefined) this.hits.delete(oldest);
        }
        return true;
    }
}

/** Instancia del proceso (una por instancia serverless). */
export const arcaLookupLimiter = new SlidingWindowLimiter();
