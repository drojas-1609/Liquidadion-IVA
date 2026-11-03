import "server-only";
import prisma from "../prisma";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Cupos PROPIOS de la consulta a ARCA en producción, compartidos entre
 * instancias mediante PostgreSQL. No son límites publicados por ARCA (el manual
 * v4.1 no documenta cuotas); son un freno del estudio sobre el uso de su
 * certificado.
 *
 * Semántica (ventana deslizante exacta): un consumo en el instante t cuenta
 * para su clave mientras now < t + ventana. Se admite un consumo si, para
 * CADA clave, los consumos que cuentan son menos que su cupo. Los tres cupos
 * se consumen en una sola transacción: todos o ninguno; un intento rechazado
 * no consume. Retry-After = instante en que deja de contar el consumo que
 * completa el cupo más restrictivo, menos now.
 *
 * Concurrencia: cada clave tiene una fila de bloqueo; se bloquean en orden de
 * clave (sin deadlocks) con lock_timeout 1 s y statement_timeout 2 s. La hora
 * es clock_timestamp() de PostgreSQL, leída una vez tras los locks. La
 * transacción termina antes de llamar a ARCA. Cualquier fallo del almacén
 * lanza QuotaStoreFailure: el llamador NO consulta ARCA.
 */
export interface QuotaRule {
    key: string;
    limit: number;
    windowMs: number;
}
export type QuotaDecision = { ok: true } | { ok: false; retryAfterMs: number };
export interface QuotaStore {
    consume(rules: readonly QuotaRule[], inTransaction?: (tx: Prisma.TransactionClient) => Promise<void>): Promise<QuotaDecision>;
}
export class QuotaStoreFailure extends Error {
    constructor() { super("almacén de cupos no disponible"); }
}

export const ARCA_QUOTA_DEFAULTS = { profilePerMinute: 10, organizationPerHour: 60, certificatePerHour: 300 } as const;
export const ARCA_QUOTA_ENV = {
    profilePerMinute: "ARCA_QUOTA_PROFILE_PER_MINUTE",
    organizationPerHour: "ARCA_QUOTA_ORGANIZATION_PER_HOUR",
    certificatePerHour: "ARCA_QUOTA_CERTIFICATE_PER_HOUR",
} as const;
export type QuotaConfig = { -readonly [K in keyof typeof ARCA_QUOTA_DEFAULTS]: number };
const MAX_QUOTA = 1000;
const KEY_RE = /^[uoc]:[A-Za-z0-9_-]{1,80}$/;

/** Valores ausentes: por defecto. Presentes pero inválidos: null (la compuerta queda cerrada). */
export function readQuotaConfig(env: Readonly<Record<string, string | undefined>>): QuotaConfig | null {
    const out = { ...ARCA_QUOTA_DEFAULTS } as QuotaConfig;
    for (const name of Object.keys(ARCA_QUOTA_ENV) as Array<keyof QuotaConfig>) {
        const raw = env[ARCA_QUOTA_ENV[name]];
        if (raw === undefined) continue;
        if (!/^[1-9]\d{0,3}$/.test(raw) || Number(raw) > MAX_QUOTA) return null;
        out[name] = Number(raw);
    }
    return out;
}

export function arcaQuotaRules(ids: { profileId: string; organizationId: string; certificateKey: string }, cfg: QuotaConfig): QuotaRule[] {
    return [
        { key: `u:${ids.profileId}`, limit: cfg.profilePerMinute, windowMs: 60_000 },
        { key: `o:${ids.organizationId}`, limit: cfg.organizationPerHour, windowMs: 3_600_000 },
        { key: `c:${ids.certificateKey}`, limit: cfg.certificatePerHour, windowMs: 3_600_000 },
    ];
}

/** Instante (epoch ms) en que se libera el cupo; 0 si admite. `countedDescMs`: consumos que cuentan, del más reciente al más antiguo. */
export function quotaRetryAt(rule: QuotaRule, countedDescMs: readonly number[]): number {
    return countedDescMs.length >= rule.limit ? countedDescMs[rule.limit - 1] + rule.windowMs : 0;
}

/**
 * `inTransaction` corre dentro de la MISMA transacción sólo si se admite el
 * consumo (por ejemplo, registrar el intento de auditoría): si falla, no se
 * consume ningún cupo.
 */
export function postgresQuotaStore(client: PrismaClient = prisma): QuotaStore {
    return {
        async consume(rules, inTransaction) {
            const sorted = [...rules].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            const keys = sorted.map((r) => r.key);
            if (keys.length === 0 || new Set(keys).size !== keys.length || sorted.some((r) => !KEY_RE.test(r.key) || !Number.isInteger(r.limit) || r.limit < 1 || r.limit > MAX_QUOTA || !Number.isInteger(r.windowMs) || r.windowMs < 1000))
                throw new QuotaStoreFailure();
            try {
                return await client.$transaction(async (tx): Promise<QuotaDecision> => {
                    await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
                    await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
                    await tx.arcaLookupQuota.createMany({ data: keys.map((key) => ({ key })), skipDuplicates: true });
                    const locked = await tx.$queryRaw<Array<{ key: string }>>`SELECT "key" FROM "ArcaLookupQuota" WHERE "key" = ANY(${keys}) ORDER BY "key" FOR UPDATE`;
                    if (locked.length !== keys.length) throw new QuotaStoreFailure();
                    // Única referencia temporal, del servidor PostgreSQL y posterior a los locks: las
                    // filas bloqueadas serializan cada clave, así que el orden de las horas coincide
                    // con el de los commits. No se usa el reloj de la instancia ni now() (inicio de la transacción).
                    const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
                    const now = clock[0]?.now?.getTime();
                    if (!Number.isFinite(now)) throw new QuotaStoreFailure();
                    let retryAt = 0;
                    for (const rule of sorted) {
                        const from = new Date(now! - rule.windowMs);
                        await tx.arcaLookupQuotaEvent.deleteMany({ where: { key: rule.key, at: { lte: from } } });
                        const counted = await tx.arcaLookupQuotaEvent.findMany({ where: { key: rule.key, at: { gt: from } }, orderBy: { at: "desc" }, take: rule.limit, select: { at: true } });
                        retryAt = Math.max(retryAt, quotaRetryAt(rule, counted.map((c) => c.at.getTime())));
                    }
                    if (retryAt > 0) return { ok: false, retryAfterMs: Math.max(1, retryAt - now!) };
                    await tx.arcaLookupQuotaEvent.createMany({ data: keys.map((key) => ({ key, at: new Date(now!) })) });
                    if (inTransaction) await inTransaction(tx);
                    return { ok: true };
                }, { maxWait: 2000, timeout: 5000 });
            } catch {
                throw new QuotaStoreFailure();
            }
        },
    };
}
