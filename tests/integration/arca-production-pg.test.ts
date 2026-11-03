import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postgresQuotaStore, QuotaStoreFailure, type QuotaRule } from "@/lib/arca-padron/quota-store";
import { productionLookupEnabled } from "@/lib/arca-padron/production-switch";
import { listLookupAudit } from "@/lib/arca-padron/lookup-audit";
import { recordAudit } from "@/lib/auth/audit";
import { recordLookupAudit } from "@/lib/arca-padron/production-lookup";

/**
 * Cupos, interruptor y auditoría contra un PostgreSQL LOCAL y descartable
 * (scripts/pg-local-regression.sh). Datos sintéticos; dos PrismaClient simulan
 * dos instancias serverless con pools independientes.
 */
const raw = process.env.PR17_LOCAL_PG_URL;
if (raw) {
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
}
const ORG_A = "org_arca_a", ORG_B = "org_arca_b", ORG_AUD = "org_arca_auditoria";
const PROFILE = "aaaaaaaa-0000-4000-8000-0000000000a1";

describe.skipIf(!raw)("ARCA producción: almacenes compartidos en PostgreSQL", () => {
    let a: PrismaClient, b: PrismaClient;
    let n = 0;
    const key = (p: "u" | "o" | "c") => `${p}:k${process.pid}x${++n}`;
    beforeAll(async () => {
        a = new PrismaClient({ datasources: { db: { url: raw! } } });
        b = new PrismaClient({ datasources: { db: { url: raw! } } });
        await a.organization.createMany({ data: [{ id: ORG_A, name: "ESTUDIO SINTETICO A" }, { id: ORG_B, name: "ESTUDIO SINTETICO B" }, { id: ORG_AUD, name: "ESTUDIO SINTETICO AUDITORIA" }], skipDuplicates: true });
        await a.profile.upsert({ where: { id: PROFILE }, create: { id: PROFILE, email: "sintetico@example.invalid" }, update: {} });
    });
    afterAll(async () => { await a?.$disconnect(); await b?.$disconnect(); });

    describe("cupos", () => {
        const dbNow = async () => (await a.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`)[0].now.getTime();
        const seed = (k: string, ats: number[]) => a.$transaction([
            a.arcaLookupQuota.createMany({ data: [{ key: k }], skipDuplicates: true }),
            a.arcaLookupQuotaEvent.createMany({ data: ats.map((at) => ({ key: k, at: new Date(at) })) }),
        ]);
        it("concurrencia entre instancias: exactamente el cupo, nunca más", async () => {
            const k = key("u");
            const stores = [postgresQuotaStore(a), postgresQuotaStore(b)];
            const results = await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 2].consume([{ key: k, limit: 10, windowMs: 60000 }]).catch((e) => e)));
            expect(results.filter((r) => r instanceof QuotaStoreFailure)).toEqual([]);
            expect(results.filter((r) => r.ok)).toHaveLength(10);
            expect(await a.arcaLookupQuotaEvent.count({ where: { key: k } })).toBe(10);
        });
        it("tres cupos concurrentes: el compartido limita a todos y ninguno se consume a medias", async () => {
            const cert = key("c");
            const store = [postgresQuotaStore(a), postgresQuotaStore(b)];
            const runs = Array.from({ length: 12 }, (_, i) => {
                const rules: QuotaRule[] = [
                    { key: `u:p${n}x${i}`, limit: 10, windowMs: 60000 },
                    { key: `o:o${n}x${i % 3}`, limit: 60, windowMs: 3600000 },
                    { key: cert, limit: 5, windowMs: 3600000 },
                ];
                return store[i % 2].consume(rules);
            });
            const out = await Promise.all(runs);
            expect(out.filter((r) => r.ok)).toHaveLength(5);
            expect(await a.arcaLookupQuotaEvent.count({ where: { key: cert } })).toBe(5);
            expect(await a.arcaLookupQuotaEvent.count({ where: { key: { startsWith: `u:p${n}x` } } })).toBe(5);
        });
        it("todos o ninguno: si un cupo está agotado, los demás no se consumen", async () => {
            const u = key("u"), o = key("o"), c = key("c");
            const store = postgresQuotaStore(a);
            expect(await store.consume([{ key: o, limit: 1, windowMs: 3600000 }])).toEqual({ ok: true });
            const r = await store.consume([{ key: u, limit: 10, windowMs: 60000 }, { key: o, limit: 1, windowMs: 3600000 }, { key: c, limit: 300, windowMs: 3600000 }]);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.retryAfterMs).toBeGreaterThan(3590000);
            expect(await a.arcaLookupQuotaEvent.count({ where: { key: { in: [u, c] } } })).toBe(0);
        });
        it("ventana con la hora de PostgreSQL: cuenta lo posterior a now − ventana, depura lo anterior; Retry-After exacto respecto de esa hora", async () => {
            const k = key("u"), t = await dbNow();
            // Un consumo justo fuera de la ventana (depurado) y dos dentro (el más viejo vence en ~1,5 s).
            await seed(k, [t - 60000 - 2000, t - 60000 + 1500, t - 1000]);
            const r = await postgresQuotaStore(a).consume([{ key: k, limit: 2, windowMs: 60000 }]);
            expect(r.ok).toBe(false);
            if (!r.ok) { expect(r.retryAfterMs).toBeGreaterThan(0); expect(r.retryAfterMs).toBeLessThanOrEqual(1500); }
            expect((await a.arcaLookupQuotaEvent.findMany({ where: { key: k }, orderBy: { at: "asc" } })).map((e) => e.at.getTime())).toEqual([t - 60000 + 1500, t - 1000]);
            await new Promise((res) => setTimeout(res, 1600));
            expect(await postgresQuotaStore(a).consume([{ key: k, limit: 2, windowMs: 60000 }])).toEqual({ ok: true });
            expect(await a.arcaLookupQuotaEvent.count({ where: { key: k } })).toBe(2);
        });
        it("regresión D3: el reloj de la instancia no interviene (una instancia adelantada no duplica el cupo)", async () => {
            const k = key("u"), rule = [{ key: k, limit: 10, windowMs: 60000 }];
            let admitted = 0;
            for (let i = 0; i < 10; i++) if ((await postgresQuotaStore(a).consume(rule)).ok) admitted++;
            const skew = vi.spyOn(Date, "now").mockImplementation(() => new Date().getTime() + 61000);
            try {
                for (let i = 0; i < 10; i++) if ((await postgresQuotaStore(b).consume(rule)).ok) admitted++;
            } finally { skew.mockRestore(); }
            expect(admitted).toBe(10);
            const t = await dbNow();
            for (const e of await a.arcaLookupQuotaEvent.findMany({ where: { key: k } })) expect(Math.abs(e.at.getTime() - t)).toBeLessThan(10000);
        });
        it("H2: el intento de auditoría se registra en la misma transacción; si falla, no se consume", async () => {
            const u = key("u"), lookupId = `consulta-${n}`;
            const ok = await postgresQuotaStore(a).consume([{ key: u, limit: 1, windowMs: 60000 }], (tx) => recordLookupAudit(tx, { organizationId: ORG_A, profileId: PROFILE, lookupId, result: "STARTED" }));
            expect(ok).toEqual({ ok: true });
            expect(await a.auditLog.count({ where: { targetId: lookupId, metadata: { path: ["result"], equals: "STARTED" } } })).toBe(1);
            // Cupo agotado: no hay intento.
            const denied = await postgresQuotaStore(a).consume([{ key: u, limit: 1, windowMs: 60000 }], (tx) => recordLookupAudit(tx, { organizationId: ORG_A, profileId: PROFILE, lookupId: lookupId + "-b", result: "STARTED" }));
            expect(denied.ok).toBe(false);
            expect(await a.auditLog.count({ where: { targetId: lookupId + "-b" } })).toBe(0);
            // El registro del intento falla (organización inexistente): no se consume ningún cupo.
            const u2 = key("u"), o2 = key("o");
            await expect(postgresQuotaStore(a).consume([{ key: u2, limit: 5, windowMs: 60000 }, { key: o2, limit: 5, windowMs: 3600000 }], (tx) => recordLookupAudit(tx, { organizationId: "org-inexistente", profileId: PROFILE, lookupId: lookupId + "-c", result: "STARTED" }))).rejects.toBeInstanceOf(QuotaStoreFailure);
            expect(await a.arcaLookupQuotaEvent.count({ where: { key: { in: [u2, o2] } } })).toBe(0);
        });
        it("fallo del almacén: fila bloqueada por otra transacción -> QuotaStoreFailure en ~1 s, sin consumir", async () => {
            const k = key("c");
            await postgresQuotaStore(a).consume([{ key: k, limit: 5, windowMs: 60000 }]);
            let release!: () => void;
            const held = b.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT "key" FROM "ArcaLookupQuota" WHERE "key" = ${k} FOR UPDATE`;
                await new Promise<void>((r) => (release = r));
            }, { timeout: 10000 });
            await new Promise((r) => setTimeout(r, 100));
            const start = Date.now();
            await expect(postgresQuotaStore(a).consume([{ key: k, limit: 5, windowMs: 60000 }])).rejects.toBeInstanceOf(QuotaStoreFailure);
            expect(Date.now() - start).toBeLessThan(3000);
            release();
            await held;
            expect(await a.arcaLookupQuotaEvent.count({ where: { key: k } })).toBe(1);
        });
        it("fallo del almacén: base inaccesible o claves inválidas -> QuotaStoreFailure", async () => {
            const down = new PrismaClient({ datasources: { db: { url: "postgresql://postgres@127.0.0.1:1/postgres?connect_timeout=1" } } });
            await expect(postgresQuotaStore(down).consume([{ key: key("u"), limit: 1, windowMs: 60000 }])).rejects.toBeInstanceOf(QuotaStoreFailure);
            await down.$disconnect();
            await expect(postgresQuotaStore(a).consume([{ key: "u:20-70000003-7 en claro", limit: 1, windowMs: 60000 }])).rejects.toBeInstanceOf(QuotaStoreFailure);
            await expect(postgresQuotaStore(a).consume([])).rejects.toBeInstanceOf(QuotaStoreFailure);
        });
    });

    describe("interruptor y habilitación por organización", () => {
        it("nace apagado; requiere global Y organización; se apaga sin redeploy", async () => {
            expect(await a.arcaPadronControl.findUniqueOrThrow({ where: { id: "global" } })).toMatchObject({ enabled: false });
            expect(await productionLookupEnabled(ORG_A, a)).toBe(false);
            await a.arcaPadronOrganization.create({ data: { organizationId: ORG_A, enabled: true } });
            expect(await productionLookupEnabled(ORG_A, a)).toBe(false);
            await a.arcaPadronControl.update({ where: { id: "global" }, data: { enabled: true } });
            expect(await productionLookupEnabled(ORG_A, b)).toBe(true);
            expect(await productionLookupEnabled(ORG_B, b)).toBe(false);
            await a.arcaPadronControl.update({ where: { id: "global" }, data: { enabled: false } });
            expect(await productionLookupEnabled(ORG_A, b)).toBe(false);
            await expect(a.arcaPadronControl.create({ data: { id: "otra", enabled: true } })).rejects.toThrow();
        });
        it("sin acceso a la base: la lectura falla (el llamador no consulta ARCA)", async () => {
            const down = new PrismaClient({ datasources: { db: { url: "postgresql://postgres@127.0.0.1:1/postgres?connect_timeout=1" } } });
            await expect(productionLookupEnabled(ORG_A, down)).rejects.toThrow();
            await down.$disconnect();
        });
    });

    describe("auditoría mínima", () => {
        it("intento y resultado vinculados por id interno; sólo perfil, organización, fecha y resultado; lectura acotada a la organización", async () => {
            await recordLookupAudit(a, { organizationId: ORG_AUD, profileId: PROFILE, lookupId: "aud-1", result: "STARTED" });
            await recordLookupAudit(a, { organizationId: ORG_AUD, profileId: PROFILE, lookupId: "aud-1", result: "FOUND" });
            await recordLookupAudit(a, { organizationId: ORG_AUD, profileId: PROFILE, lookupId: "aud-2", result: "STARTED" });
            await recordLookupAudit(a, { organizationId: ORG_B, profileId: PROFILE, lookupId: "aud-3", result: "STARTED" });
            await recordAudit(a, { organizationId: ORG_AUD, actorProfileId: PROFILE, action: "arca.cuit_lookup", targetType: "ArcaPadronLookup", targetId: "aud-4", metadata: { result: "STARTED", cuit: "20700000037", token: "TOKEN-SINTETICO" } });
            const rowsA = await listLookupAudit(ORG_AUD, a);
            expect(rowsA.map((r) => r.result).sort()).toEqual(["FOUND", "SIN_RESULTADO", "SIN_RESULTADO"]);
            expect(rowsA.every((r) => r.actorProfileId === PROFILE)).toBe(true);
            expect(JSON.stringify(rowsA)).not.toMatch(/aud-|20700000037/);
            const stored = await a.auditLog.findMany({ where: { action: "arca.cuit_lookup" } });
            expect(JSON.stringify(stored)).not.toMatch(/20700000037|TOKEN/);
        });
    });

    it("tablas nuevas: RLS sin políticas, sin privilegios para PUBLIC ni roles API (también la secuencia)", async () => {
        for (const t of ["ArcaPadronControl", "ArcaPadronOrganization", "ArcaLookupQuota", "ArcaLookupQuotaEvent"]) {
            const rows = await a.$queryRawUnsafe<Array<{ rls: boolean; policies: bigint; public_access: boolean }>>(
                `SELECT c.relrowsecurity AS rls, (SELECT count(*) FROM pg_policy WHERE polrelid=c.oid) AS policies, EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE x.grantee=0) AS public_access FROM pg_class c WHERE c.oid='"${t}"'::regclass`,
            );
            expect(rows, t).toEqual([{ rls: true, policies: BigInt(0), public_access: false }]);
            const grants = await a.$queryRawUnsafe<Array<{ any: boolean }>>(
                `SELECT bool_or(has_table_privilege(oid, '"${t}"', 'SELECT') OR has_table_privilege(oid, '"${t}"', 'INSERT') OR has_table_privilege(oid, '"${t}"', 'UPDATE') OR has_table_privilege(oid, '"${t}"', 'DELETE')) AS any FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`,
            );
            expect(grants, t).toEqual([{ any: false }]);
        }
        const seq = await a.$queryRaw<Array<{ any: boolean }>>`SELECT bool_or(has_sequence_privilege(oid, '"ArcaLookupQuotaEvent_id_seq"', 'USAGE')) AS any FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`;
        expect(seq).toEqual([{ any: false }]);
    });
});
