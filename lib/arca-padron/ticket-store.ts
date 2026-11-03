import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import prisma from '../prisma';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ticketUsable, type WsaaTicket } from './wsaa';
export interface SharedTicketStore {
    getOrIssue(issue: () => Promise<WsaaTicket>): Promise<WsaaTicket>;
    /** El padrón rechazó la autenticación: no se reutiliza ni se reemplaza ese ticket hasta su vencimiento. */
    reject(ticket: WsaaTicket): Promise<void>;
}
/** Clave de cifrado vigente y, durante una rotación, la anterior (sólo lectura). */
export interface TicketKeys {
    current: Buffer;
    previous?: Buffer;
}
export class TicketStoreFailure extends Error {
    constructor() { super('almacén de autenticación no disponible'); }
}
/** No hay ticket utilizable y todavía no corresponde pedir otro. `retryAt` es fijo: lo define la fila, no la consulta. */
export class TicketUnavailable extends Error {
    constructor(readonly retryAt: number) { super('autenticación ARCA en espera'); }
}
/** Reserva de una emisión LoginCms; mayor que el timeout HTTP más la firma. */
export const ISSUE_LEASE_MS = 30000;
/** Enfriamiento tras una emisión fallida (comportamiento previo conservado; ver docs/arca/PRODUCCION.md). */
export const ISSUE_COOLDOWN_MS = 30000;
export function parseCacheKey(raw: string | undefined): Buffer | null {
    if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw))
        return null;
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 && key.toString('base64') === raw ? key : null;
}
/** Identificador público de la clave: no permite derivarla. */
export const cacheKeyId = (key: Buffer) => createHash('sha256').update('arca-wsaa-cache-key|').update(key).digest('hex').slice(0, 16);
const keysOf = (keys: Buffer | TicketKeys): TicketKeys => Buffer.isBuffer(keys) ? { current: keys } : keys;
export function sealTicket(ticket: WsaaTicket, key: Buffer, scope: string): string {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(scope));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(ticket), 'utf8'), cipher.final()]);
    return ['v2', cacheKeyId(key), nonce.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
function decrypt(n: string, t: string, c: string, key: Buffer, scope: string): WsaaTicket {
    const nonce = Buffer.from(n, 'base64'), tag = Buffer.from(t, 'base64');
    if (nonce.length !== 12 || tag.length !== 16)
        throw Error();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(tag);
    const ticket = JSON.parse(Buffer.concat([decipher.update(Buffer.from(c, 'base64')), decipher.final()]).toString('utf8'));
    if (typeof ticket.token !== 'string' || !ticket.token || typeof ticket.sign !== 'string' || !ticket.sign || !Number.isFinite(ticket.expiresAt))
        throw Error();
    return { token: ticket.token, sign: ticket.sign, expiresAt: ticket.expiresAt };
}
/** Abre v2 (clave identificada) o v1 (anterior a la rotación: se prueba la vigente y luego la anterior). */
function openWith(sealed: string, keys: TicketKeys, scope: string): { ticket: WsaaTicket; stale: boolean } | null {
    try {
        if (sealed.length > 32768)
            return null;
        const parts = sealed.split('.');
        const candidates = [keys.current, ...(keys.previous ? [keys.previous] : [])];
        if (parts[0] === 'v2' && parts.length === 5) {
            const key = candidates.find(k => cacheKeyId(k) === parts[1]);
            return key ? { ticket: decrypt(parts[2], parts[3], parts[4], key, scope), stale: key !== keys.current } : null;
        }
        if (parts[0] !== 'v1' || parts.length !== 4)
            return null;
        for (const key of candidates) {
            try {
                return { ticket: decrypt(parts[1], parts[2], parts[3], key, scope), stale: true };
            }
            catch { /* siguiente clave */ }
        }
        return null;
    }
    catch {
        return null;
    }
}
export function openTicket(sealed: string, keys: Buffer | TicketKeys, scope: string): WsaaTicket {
    const opened = openWith(sealed, keysOf(keys), scope);
    if (!opened)
        throw new TicketStoreFailure();
    return opened.ticket;
}
const digest = (t: WsaaTicket) => createHash('sha256').update(JSON.stringify([t.token, t.sign, t.expiresAt])).digest();
/**
 * Una fila por ambiente, certificado, CUIT y servicio. Las transacciones son
 * cortas y nunca abarcan LoginCms: una reserva (`leaseId`/`leaseUntil`) evita
 * emisiones simultáneas entre instancias; quien no la obtiene recibe
 * TicketUnavailable sin esperar ni reintentar.
 */
export function postgresTicketStore(scope: string, keyOrKeys: Buffer | TicketKeys, nowMs: () => number = Date.now, client: PrismaClient = prisma): SharedTicketStore {
    const keys = keysOf(keyOrKeys);
    if (!/^[a-f0-9]{64}$/.test(scope) || keys.current.length !== 32 || (keys.previous && (keys.previous.length !== 32 || keys.previous.equals(keys.current))))
        throw new TicketStoreFailure();
    type Row = {
        ciphertext: string | null;
        expiresAt: Date | null;
        blockedUntil: Date | null;
        leaseId: string | null;
        leaseUntil: Date | null;
    };
    const short = async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
        try {
            return await client.$transaction(async (tx) => {
                await tx.$executeRaw `SET LOCAL lock_timeout = '2s'`;
                return work(tx);
            }, { maxWait: 2000, timeout: 5000 });
        }
        catch (error) {
            if (error instanceof TicketUnavailable)
                throw error;
            throw new TicketStoreFailure();
        }
    };
    const lockRow = async (tx: Prisma.TransactionClient) => {
        const rows = await tx.$queryRaw<Row[]> `SELECT "ciphertext", "expiresAt", "blockedUntil", "leaseId", "leaseUntil" FROM "ArcaWsaaTicket" WHERE "key"=${scope} FOR UPDATE`;
        if (!rows[0])
            throw new TicketStoreFailure();
        return rows[0];
    };
    return {
        async getOrIssue(issue) {
            const claim = await short(async (tx): Promise<{ ticket: WsaaTicket } | { leaseId: string }> => {
                await tx.$executeRaw `INSERT INTO "ArcaWsaaTicket" ("key", "updatedAt") VALUES (${scope}, NOW()) ON CONFLICT ("key") DO NOTHING`;
                const row = await lockRow(tx);
                const now = nowMs();
                if (row.blockedUntil && row.blockedUntil.getTime() > now)
                    throw new TicketUnavailable(row.blockedUntil.getTime());
                if (row.ciphertext && row.expiresAt) {
                    const opened = openWith(row.ciphertext, keys, scope);
                    if (opened && ticketUsable(opened.ticket, now)) {
                        if (opened.stale)
                            await tx.$executeRaw `UPDATE "ArcaWsaaTicket" SET "ciphertext"=${sealTicket(opened.ticket, keys.current, scope)}, "updatedAt"=NOW() WHERE "key"=${scope}`;
                        return { ticket: opened.ticket };
                    }
                    // Ticket ilegible (clave ausente) o en su último minuto: no se pide otro mientras ARCA lo considere vigente.
                    if (row.expiresAt.getTime() > now)
                        throw new TicketUnavailable(row.expiresAt.getTime());
                }
                if (row.leaseUntil && row.leaseUntil.getTime() > now)
                    throw new TicketUnavailable(row.leaseUntil.getTime());
                const leaseId = randomUUID();
                await tx.$executeRaw `UPDATE "ArcaWsaaTicket" SET "leaseId"=${leaseId}, "leaseUntil"=${new Date(now + ISSUE_LEASE_MS)}, "updatedAt"=NOW() WHERE "key"=${scope}`;
                return { leaseId };
            });
            if ('ticket' in claim)
                return claim.ticket;
            let outcome: { ticket: WsaaTicket } | { error: unknown };
            try {
                const ticket = await issue();
                outcome = ticketUsable(ticket, nowMs()) ? { ticket } : { error: new TicketStoreFailure() };
            }
            catch (error) {
                outcome = { error };
            }
            await short(async (tx) => {
                const row = await lockRow(tx);
                if (row.leaseId !== claim.leaseId)
                    return;
                if ('ticket' in outcome)
                    await tx.$executeRaw `UPDATE "ArcaWsaaTicket" SET "ciphertext"=${sealTicket(outcome.ticket, keys.current, scope)}, "expiresAt"=${new Date(outcome.ticket.expiresAt)}, "blockedUntil"=NULL, "leaseId"=NULL, "leaseUntil"=NULL, "updatedAt"=NOW() WHERE "key"=${scope}`;
                else
                    await tx.$executeRaw `UPDATE "ArcaWsaaTicket" SET "blockedUntil"=${new Date(nowMs() + ISSUE_COOLDOWN_MS)}, "leaseId"=NULL, "leaseUntil"=NULL, "updatedAt"=NOW() WHERE "key"=${scope}`;
            });
            if ('error' in outcome)
                throw outcome.error;
            return outcome.ticket;
        },
        async reject(ticket) {
            await short(async (tx) => {
                const row = await lockRow(tx);
                const opened = row.ciphertext ? openWith(row.ciphertext, keys, scope) : null;
                if (!opened || !timingSafeEqual(digest(opened.ticket), digest(ticket)))
                    return;
                // Vencimiento fijo: el del propio ticket. Un segundo rechazo no lo prolonga.
                if (row.blockedUntil && row.blockedUntil.getTime() >= ticket.expiresAt)
                    return;
                await tx.$executeRaw `UPDATE "ArcaWsaaTicket" SET "blockedUntil"=${new Date(ticket.expiresAt)}, "updatedAt"=NOW() WHERE "key"=${scope}`;
            });
        }
    };
}
