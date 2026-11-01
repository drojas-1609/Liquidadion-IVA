import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { postgresTicketStore } from '@/lib/arca-padron/ticket-store';
const raw = process.env.PR17_LOCAL_PG_URL;
if (raw && !['127.0.0.1', 'localhost'].includes(new URL(raw).hostname))
    throw Error('sólo PostgreSQL local');
describe.skipIf(!raw)('WSAA: coordinación real entre instancias PostgreSQL', () => {
    let db: PrismaClient;
    const key = Buffer.alloc(32, 9);
    let now = Date.now();
    const ticket = () => ({ token: 'TOKEN-SINTETICO', sign: 'FIRMA-SINTETICA', expiresAt: now + 3600000 });
    beforeAll(() => { db = new PrismaClient({ datasources: { db: { url: raw! } } }); });
    afterAll(async () => { await db?.$disconnect(); });
    it('dos instancias emiten una sola vez; el ticket persistido está cifrado', async () => {
        const scope = '1'.repeat(64);
        let issued = 0;
        const issue = async () => { issued++; await new Promise(r => setTimeout(r, 100)); return ticket(); };
        const a = postgresTicketStore(scope, key, () => now, db), b = postgresTicketStore(scope, key, () => now, db);
        const [first, second] = await Promise.all([a.getOrIssue(issue), b.getOrIssue(issue)]);
        expect(first).toEqual(second);
        expect(issued).toBe(1);
        const row = await db.arcaWsaaTicket.findUniqueOrThrow({ where: { key: scope } });
        expect(row.ciphertext).not.toContain(first.token);
    });
    it('un error confirma el enfriamiento y no repite LoginCms', async () => {
        const store = postgresTicketStore('2'.repeat(64), key, () => now, db);
        let calls = 0;
        const issue = async () => { calls++; throw Error('simulado'); };
        await expect(store.getOrIssue(issue)).rejects.toThrow();
        await expect(store.getOrIssue(issue)).rejects.toThrow();
        expect(calls).toBe(1);
        now += 31000;
        await expect(store.getOrIssue(issue)).rejects.toThrow();
        expect(calls).toBe(2);
    });
    it('un rechazo tardío del ticket viejo no invalida el ticket nuevo', async () => {
        const store = postgresTicketStore('3'.repeat(64), key, () => now, db);
        const old = await store.getOrIssue(async () => ticket());
        await store.invalidate(old);
        await expect(store.getOrIssue(async () => ticket())).rejects.toThrow();
        now = old.expiresAt + 1;
        const fresh = await store.getOrIssue(async () => ({ ...ticket(), token: 'NUEVO-SINTETICO' }));
        await store.invalidate(old);
        expect(await store.getOrIssue(async () => { throw Error('no debe emitir'); })).toEqual(fresh);
    });
    it('no solicita otro ticket durante el margen previo al vencimiento', async () => {
        const store = postgresTicketStore('4'.repeat(64), key, () => now, db);
        const old = await store.getOrIssue(async () => ticket());
        now = old.expiresAt - 30000;
        await expect(store.getOrIssue(async () => { throw Error('no debe solicitar'); })).rejects.toThrow();
        const row = await db.arcaWsaaTicket.findUniqueOrThrow({ where: { key: '4'.repeat(64) } });
        expect(row.ciphertext).not.toBeNull();
    });
    it('la tabla tiene RLS y no concede privilegios a PUBLIC', async () => {
        const rows = await db.$queryRaw<Array<{
            rls: boolean;
            public_access: boolean;
        }>> `SELECT c.relrowsecurity AS rls, EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_access FROM pg_class c WHERE c.oid='"ArcaWsaaTicket"'::regclass`;
        expect(rows).toEqual([{ rls: true, public_access: false }]);
        const grants=await db.$queryRaw<Array<{role:string;can_read:boolean;can_write:boolean}>>`SELECT rolname AS role, has_table_privilege(oid, '"ArcaWsaaTicket"', 'SELECT') AS can_read, has_table_privilege(oid, '"ArcaWsaaTicket"', 'INSERT') AS can_write FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname`;
        expect(grants).toEqual(['anon','authenticated','service_role'].map(role=>({role,can_read:false,can_write:false})));
        await expect(db.arcaWsaaTicket.create({data:{key:'5'.repeat(64),ciphertext:'incompleto',updatedAt:new Date()}})).rejects.toThrow();

    });
});
