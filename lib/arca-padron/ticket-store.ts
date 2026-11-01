import 'server-only';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import prisma from '../prisma';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ticketUsable, type WsaaTicket } from './wsaa';
export interface SharedTicketStore {
    getOrIssue(issue: () => Promise<WsaaTicket>): Promise<WsaaTicket>;
    invalidate(ticket: WsaaTicket): Promise<void>;
}
export class TicketStoreFailure extends Error {
    constructor() { super('almacén de autenticación no disponible'); }
}
export function parseCacheKey(raw: string | undefined): Buffer | null {
    if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw))
        return null;
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 && key.toString('base64') === raw ? key : null;
}
export function sealTicket(ticket: WsaaTicket, key: Buffer, scope: string): string {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(scope));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(ticket), 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
export function openTicket(sealed: string, key: Buffer, scope: string): WsaaTicket {
    try {
        if (sealed.length > 32768)
            throw Error();
        const [v, n, t, c, ...extra] = sealed.split('.');
        if (v !== 'v1' || extra.length || !n || !t || !c)
            throw Error();
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
    catch {
        throw new TicketStoreFailure();
    }
}
const digest = (t: WsaaTicket) => createHash('sha256').update(JSON.stringify([t.token, t.sign, t.expiresAt])).digest();
/** Una fila por ambiente, certificado, CUIT y servicio. La transacción mantiene el lock durante LoginCms. */
export function postgresTicketStore(scope: string, key: Buffer, nowMs: () => number = Date.now, client: PrismaClient = prisma): SharedTicketStore {
    if (!/^[a-f0-9]{64}$/.test(scope) || key.length !== 32)
        throw new TicketStoreFailure();
    type Row = {
        ciphertext: string | null;
        expiresAt: Date | null;
        blockedUntil: Date | null;
    };
    const locked = async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => client.$transaction(tx => work(tx), { maxWait: 3000, timeout: 20000 });
    return {
        async getOrIssue(issue) {
            const result = await locked(async (tx) => {
                await tx.$executeRaw `SET LOCAL lock_timeout = '3s'`;
                await tx.$executeRaw `INSERT INTO "ArcaWsaaTicket" ("key", "updatedAt") VALUES (${scope}, NOW()) ON CONFLICT ("key") DO NOTHING`;
                const rows = await tx.$queryRaw<Row[]> `SELECT "ciphertext", "expiresAt", "blockedUntil" FROM "ArcaWsaaTicket" WHERE "key"=${scope} FOR UPDATE`;
                const row = rows[0];
                if (!row)
                    throw new TicketStoreFailure();
                if (row.ciphertext) {
                    const current = openTicket(row.ciphertext, key, scope);
                    const expiresAt = current.expiresAt;
                    if (ticketUsable(current, nowMs()))
                        return { ticket: current };
                    if (expiresAt > nowMs())
                        return { error: new TicketStoreFailure() };
                }
                if (row.blockedUntil && row.blockedUntil.getTime() > nowMs())
                    return { error: new TicketStoreFailure() };
                try {
                    const ticket = await issue();
                    if (!ticketUsable(ticket, nowMs()))
                        throw new TicketStoreFailure();
                    const ciphertext = sealTicket(ticket, key, scope);
                    await tx.$executeRaw `UPDATE "ArcaWsaaTicket" SET "ciphertext"=${ciphertext}, "expiresAt"=${new Date(ticket.expiresAt)}, "blockedUntil"=NULL, "updatedAt"=NOW() WHERE "key"=${scope}`;
                    return { ticket };
                }
                catch (error) {
                    await tx.$executeRaw `UPDATE "ArcaWsaaTicket" SET "ciphertext"=NULL, "expiresAt"=NULL, "blockedUntil"=${new Date(nowMs() + 30000)}, "updatedAt"=NOW() WHERE "key"=${scope}`;
                    return { error };
                }
            });
            if ('error' in result)
                throw result.error;
            if (!result.ticket)
                throw new TicketStoreFailure();
            return result.ticket;
        },
        async invalidate(ticket) {
            await locked(async (tx) => {
                await tx.$executeRaw `SET LOCAL lock_timeout = '3s'`;
                const rows = await tx.$queryRaw<Row[]> `SELECT "ciphertext", "expiresAt", "blockedUntil" FROM "ArcaWsaaTicket" WHERE "key"=${scope} FOR UPDATE`;
                const row = rows[0];
                if (!row?.ciphertext)
                    return;
                const current = openTicket(row.ciphertext, key, scope);
                if (!timingSafeEqual(digest(current), digest(ticket)))
                    return;
                await tx.$executeRaw `UPDATE "ArcaWsaaTicket" SET "ciphertext"=NULL, "expiresAt"=NULL, "blockedUntil"=${new Date(Math.max(nowMs() + 30000, ticket.expiresAt))}, "updatedAt"=NOW() WHERE "key"=${scope}`;
            });
        }
    };
}
