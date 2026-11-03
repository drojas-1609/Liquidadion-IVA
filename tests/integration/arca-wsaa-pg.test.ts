import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createCipheriv, randomBytes } from 'node:crypto';
import { postgresTicketStore, cacheKeyId, TicketUnavailable, ISSUE_COOLDOWN_MS, ISSUE_LEASE_MS } from '@/lib/arca-padron/ticket-store';
const raw = process.env.PR17_LOCAL_PG_URL;
if (raw && !['127.0.0.1', 'localhost'].includes(new URL(raw).hostname))
    throw Error('sólo PostgreSQL local');
describe.skipIf(!raw)('WSAA: coordinación real entre instancias PostgreSQL', () => {
    let db: PrismaClient, other: PrismaClient;
    const key = Buffer.alloc(32, 9), newKey = Buffer.alloc(32, 10), lostKey = Buffer.alloc(32, 11);
    let now = Date.now();
    const ticket = (token = 'TOKEN-SINTETICO') => ({ token, sign: 'FIRMA-SINTETICA', expiresAt: now + 3600000 });
    const row = (scope: string) => db.arcaWsaaTicket.findUniqueOrThrow({ where: { key: scope } });
    const never = async () => { throw Error('no debe emitir'); };
    beforeAll(() => {
        db = new PrismaClient({ datasources: { db: { url: raw! } } });
        other = new PrismaClient({ datasources: { db: { url: raw! } } });
    });
    afterAll(async () => { await db?.$disconnect(); await other?.$disconnect(); });
    it('dos instancias: una sola emisión; la otra no espera ni emite, y luego reutiliza el ticket cifrado', async () => {
        const scope = '1'.repeat(64);
        let issued = 0;
        const issue = async () => { issued++; await new Promise(r => setTimeout(r, 150)); return ticket(); };
        const a = postgresTicketStore(scope, key, () => now, db), b = postgresTicketStore(scope, key, () => now, other);
        const pending = a.getOrIssue(issue);
        await new Promise(r => setTimeout(r, 50));
        const busy = await b.getOrIssue(issue).catch(e => e);
        expect(busy).toBeInstanceOf(TicketUnavailable);
        expect(busy.retryAt).toBe(now + ISSUE_LEASE_MS);
        const first = await pending;
        expect(await b.getOrIssue(never)).toEqual(first);
        expect(issued).toBe(1);
        const persisted = await row(scope);
        expect(persisted.ciphertext).not.toContain(first.token);
        expect(persisted.ciphertext!.split('.').slice(0, 2)).toEqual(['v2', cacheKeyId(key)]);
        expect(persisted.leaseId).toBeNull();
    });
    it('LoginCms corre sin transacción ni lock: otra conexión bloquea la fila durante la emisión', async () => {
        const scope = '6'.repeat(64);
        let probe: unknown = null;
        const store = postgresTicketStore(scope, key, () => now, db);
        await store.getOrIssue(async () => {
            probe = await other.$transaction(async tx => tx.$queryRaw`SELECT "leaseId" IS NOT NULL AS leased FROM "ArcaWsaaTicket" WHERE "key"=${scope} FOR UPDATE NOWAIT`);
            return ticket();
        });
        expect(probe).toEqual([{ leased: true }]);
    });
    it('un error confirma un enfriamiento de vencimiento fijo y no repite LoginCms', async () => {
        const scope = '2'.repeat(64);
        const store = postgresTicketStore(scope, key, () => now, db);
        let calls = 0;
        const issue = async () => { calls++; throw Error('simulado'); };
        const start = now;
        await expect(store.getOrIssue(issue)).rejects.toThrow('simulado');
        now += 10000;
        const waiting = await store.getOrIssue(issue).catch(e => e);
        expect(waiting).toBeInstanceOf(TicketUnavailable);
        expect(waiting.retryAt).toBe(start + ISSUE_COOLDOWN_MS);
        expect(calls).toBe(1);
        now = start + ISSUE_COOLDOWN_MS + 1;
        await expect(store.getOrIssue(issue)).rejects.toThrow('simulado');
        expect(calls).toBe(2);
    });
    it('un rechazo del padrón conserva el ticket, lo bloquea hasta su vencimiento sin prolongarlo, y no afecta a uno nuevo', async () => {
        const scope = '3'.repeat(64);
        const store = postgresTicketStore(scope, key, () => now, db);
        const old = await store.getOrIssue(async () => ticket());
        const before = await row(scope);
        await store.reject(old);
        now += 60000;
        await store.reject(old);
        const after = await row(scope);
        expect(after.ciphertext).toBe(before.ciphertext);
        expect(after.blockedUntil?.getTime()).toBe(old.expiresAt);
        const blocked = await store.getOrIssue(never).catch(e => e);
        expect(blocked).toBeInstanceOf(TicketUnavailable);
        expect(blocked.retryAt).toBe(old.expiresAt);
        now = old.expiresAt + 1;
        const fresh = await store.getOrIssue(async () => ticket('NUEVO-SINTETICO'));
        await store.reject(old);
        expect(await store.getOrIssue(never)).toEqual(fresh);
    });
    it('no solicita otro ticket durante el margen previo al vencimiento', async () => {
        const scope = '4'.repeat(64);
        const store = postgresTicketStore(scope, key, () => now, db);
        const old = await store.getOrIssue(async () => ticket());
        now = old.expiresAt - 30000;
        const waiting = await store.getOrIssue(never).catch(e => e);
        expect(waiting.retryAt).toBe(old.expiresAt);
        expect((await row(scope)).ciphertext).not.toBeNull();
    });
    it('rotación: lee con la clave anterior, re-cifra con la vigente y sigue sin emitir', async () => {
        const scope = '7'.repeat(64);
        const original = await postgresTicketStore(scope, key, () => now, db).getOrIssue(async () => ticket());
        const rotated = postgresTicketStore(scope, { current: newKey, previous: key }, () => now, db);
        expect(await rotated.getOrIssue(never)).toEqual(original);
        expect((await row(scope)).ciphertext!.split('.')[1]).toBe(cacheKeyId(newKey));
        expect(await postgresTicketStore(scope, newKey, () => now, other).getOrIssue(never)).toEqual(original);
    });
    it('compatibilidad: un ticket v1 existente se lee y se migra a v2', async () => {
        const scope = '8'.repeat(64);
        const legacy = ticket('LEGADO-SINTETICO');
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(Buffer.from(scope));
        const body = Buffer.concat([cipher.update(JSON.stringify(legacy), 'utf8'), cipher.final()]);
        const v1 = ['v1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
        await db.arcaWsaaTicket.create({ data: { key: scope, ciphertext: v1, expiresAt: new Date(legacy.expiresAt), updatedAt: new Date() } });
        expect(await postgresTicketStore(scope, key, () => now, db).getOrIssue(never)).toEqual(legacy);
        expect((await row(scope)).ciphertext!.startsWith('v2.')).toBe(true);
    });
    it('clave perdida: no borra el ticket vigente ni fuerza otra autenticación; la espera vence en su expiresAt', async () => {
        const scope = '9'.repeat(64);
        const original = await postgresTicketStore(scope, key, () => now, db).getOrIssue(async () => ticket());
        const before = await row(scope);
        const lost = postgresTicketStore(scope, lostKey, () => now, db);
        for (const step of [0, 120000]) {
            now += step;
            const waiting = await lost.getOrIssue(never).catch(e => e);
            expect(waiting).toBeInstanceOf(TicketUnavailable);
            expect(waiting.retryAt).toBe(original.expiresAt);
        }
        expect((await row(scope)).ciphertext).toBe(before.ciphertext);
        now = original.expiresAt + 1;
        const fresh = await lost.getOrIssue(async () => ticket('TRAS-VENCER'));
        expect(fresh.token).toBe('TRAS-VENCER');
    });
    it('una reserva abandonada (instancia caída) vence en su plazo fijo', async () => {
        const scope = 'a'.repeat(64);
        await db.arcaWsaaTicket.create({ data: { key: scope, leaseId: 'abandonada', leaseUntil: new Date(now + 5000), updatedAt: new Date() } });
        const store = postgresTicketStore(scope, key, () => now, db);
        expect((await store.getOrIssue(never).catch(e => e)).retryAt).toBe(now + 5000);
        now += 5001;
        expect((await store.getOrIssue(async () => ticket('TRAS-RESERVA'))).token).toBe('TRAS-RESERVA');
    });
    it('regresión D1: reserva vencida y tomada por otra instancia; la anterior no pisa el ticket ni libera la reserva nueva', async () => {
        const scope = 'c'.repeat(64);
        let releaseA!: () => void, releaseB!: () => void;
        const a = postgresTicketStore(scope, key, () => now, db), b = postgresTicketStore(scope, key, () => now, other);
        const pa = a.getOrIssue(() => new Promise(r => (releaseA = () => r(ticket('TICKET-A')))));
        await new Promise(r => setTimeout(r, 80));
        now += ISSUE_LEASE_MS + 1000;
        const pb = b.getOrIssue(() => new Promise(r => (releaseB = () => r(ticket('TICKET-B')))));
        await new Promise(r => setTimeout(r, 80));
        const leaseB = (await row(scope)).leaseId;
        releaseA();
        expect((await pa).token).toBe('TICKET-A');
        const mid = await row(scope);
        expect(mid.ciphertext).toBeNull();
        expect(mid.leaseId).toBe(leaseB);
        releaseB();
        await pb;
        expect((await postgresTicketStore(scope, key, () => now, db).getOrIssue(never)).token).toBe('TICKET-B');
    });
    it('regresión D2: ticket emitido pero no persistido; LoginCms como máximo una vez por reserva/enfriamiento y sólo ante una consulta', async () => {
        const scope = 'e'.repeat(64);
        let calls = 0, tx = 0;
        const flaky = new Proxy(db, { get(t, p) { if (p === '$transaction') return (...args: unknown[]) => (++tx === 2 ? Promise.reject(Error('caída')) : (t.$transaction as (...a: unknown[]) => unknown)(...args)); return Reflect.get(t, p); } });
        const store = postgresTicketStore(scope, key, () => now, flaky as PrismaClient);
        const issue = async () => { calls++; if (calls === 1) return ticket('PERDIDO'); throw Error('CEE ya posee TA'); };
        await expect(store.getOrIssue(issue)).rejects.toThrow();
        const start = now, attempts: number[] = [];
        for (let s = 5; s <= 125; s += 5) {
            now = start + s * 1000;
            const before = calls;
            await store.getOrIssue(issue).catch(() => {});
            if (calls > before) attempts.push(s);
        }
        for (let i = 1; i < attempts.length; i++) expect(attempts[i] - attempts[i - 1]).toBeGreaterThanOrEqual(30);
        expect(attempts.length).toBeLessThanOrEqual(5);
        const idle = calls;
        now += 600000; // sin consultas de usuarios no hay pedidos
        expect(calls).toBe(idle);
    });
    it('la tabla tiene RLS, no concede privilegios a PUBLIC y valida payload y reserva', async () => {
        const rows = await db.$queryRaw<Array<{
            rls: boolean;
            public_access: boolean;
        }>> `SELECT c.relrowsecurity AS rls, EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_access FROM pg_class c WHERE c.oid='"ArcaWsaaTicket"'::regclass`;
        expect(rows).toEqual([{ rls: true, public_access: false }]);
        const grants=await db.$queryRaw<Array<{role:string;can_read:boolean;can_write:boolean}>>`SELECT rolname AS role, has_table_privilege(oid, '"ArcaWsaaTicket"', 'SELECT') AS can_read, has_table_privilege(oid, '"ArcaWsaaTicket"', 'INSERT') AS can_write FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname`;
        expect(grants).toEqual(['anon','authenticated','service_role'].map(role=>({role,can_read:false,can_write:false})));
        await expect(db.arcaWsaaTicket.create({data:{key:'5'.repeat(64),ciphertext:'incompleto',updatedAt:new Date()}})).rejects.toThrow();
        await expect(db.arcaWsaaTicket.create({data:{key:'b'.repeat(64),leaseId:'sin-plazo',updatedAt:new Date()}})).rejects.toThrow();
    });
});
