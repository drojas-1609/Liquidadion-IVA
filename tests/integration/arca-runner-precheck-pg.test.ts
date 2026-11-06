import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { precheck, FP, EXPECTED_MIGRATIONS, EXPECTED_RELATIONS } from "../../scripts/arca/homologation-runner";

/**
 * Precheck del runner de homologación contra PostgreSQL LOCAL y descartable
 * (scripts/pg-local-regression.sh): runner_prev tiene las 14 migraciones previas y
 * runner_cur las 14, ambas aplicadas con Prisma. Datos sintéticos. Cada alteración
 * se deshace y se comprueba que el precheck vuelve a pasar, para atribuir el rechazo
 * exactamente a esa alteración. La huella local difiere de la de DEV (otros UUID).
 */
const local = (raw: string | undefined) => {
    if (raw) {
        const u = new URL(raw);
        if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
    }
    return raw;
};
const prevUrl = local(process.env.PR17_LOCAL_PG_RUNNER_PREV_URL);
const curUrl = local(process.env.PR17_LOCAL_PG_RUNNER_URL);

const TABLES = EXPECTED_RELATIONS.filter((r) => r.kind === "r").map((r) => r.name);
const SEQ = '"ArcaLookupQuotaEvent_id_seq"';
const LEASE = `CHECK (("leaseId" IS NULL) = ("leaseUntil" IS NULL))`;

describe.skipIf(!prevUrl || !curUrl)("runner de homologación: precheck de DEV", () => {
    let prev: PrismaClient, cur: PrismaClient, localFp: string;
    const outcome = async (db: PrismaClient, fp?: string) => {
        try { await precheck(db, fp); return "OK"; } catch (error) { return (error as Error).message; }
    };
    const withMutation = async (apply: string[], undo: string[]) => {
        for (const sql of apply) await cur.$executeRawUnsafe(sql);
        let result: string;
        try { result = await outcome(cur, localFp); } finally { for (const sql of undo) await cur.$executeRawUnsafe(sql); }
        expect(await outcome(cur, localFp)).toBe("OK");
        return result;
    };

    beforeAll(async () => {
        prev = new PrismaClient({ datasources: { db: { url: prevUrl! } } });
        cur = new PrismaClient({ datasources: { db: { url: curUrl! } } });
        // SQL explícito: runner_cur tiene el esquema del DEV actual (sin las columnas de
        // migraciones posteriores, p. ej. Organization.seatLimit), que el cliente Prisma
        // del repositorio ya conoce.
        await cur.$executeRawUnsafe(`INSERT INTO "Organization" ("id", "name", "updatedAt") VALUES ('org_runner_sintetica', 'ESTUDIO SINTETICO RUNNER', now())`);
        await cur.arcaPadronOrganization.create({ data: { organizationId: "org_runner_sintetica" } });
        await cur.arcaWsaaTicket.create({ data: { key: "sintetico:runner", ciphertext: "v2:no-es-un-ticket", expiresAt: new Date(Date.now() + 3600000), updatedAt: new Date() } });
        localFp = (await cur.$queryRaw<Array<{ fp: string }>>`SELECT encode(sha256(convert_to(string_agg(id||':'||migration_name||':'||checksum,'|' ORDER BY migration_name),'UTF8')),'hex') AS fp FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)[0].fp;
    });
    afterAll(async () => { await prev?.$disconnect(); await cur?.$disconnect(); });

    it("fija 15 migraciones y la huella verificada en DEV", () => {
        expect(EXPECTED_MIGRATIONS).toHaveLength(15);
        expect(EXPECTED_MIGRATIONS[10]).toEqual(["20261102120000_arca_production_controls", "1546bb960aee01bb4ad26871a3a22d4ba7f844b0215f64b293e5ef7f8ea2ca36"]);
        expect(EXPECTED_MIGRATIONS[11]).toEqual(["20261104120000_studio_users_permissions", "cc70bc0be6b90df80151da841aa58f64b3e275ce72c96373d977f40492c3a512"]);
        expect(EXPECTED_MIGRATIONS[12]).toEqual(["20261104230000_add_operator_role", "1bd8d2ce8a29934399a36871687e5946d7e776c8fb252d9dc2e4de96a438416f"]);
        expect(EXPECTED_MIGRATIONS[13]).toEqual(["20261106120000_vat_credit_adjustments", "5093b64d9a968a736455a3e03c79ebae1c3e075c3da00c9ebd685e5ade156151"]);
        expect(EXPECTED_MIGRATIONS[14]).toEqual(["20261107120000_vat_export_close_versions", "e2f768ad2b81ba05e856fed098e48ae5201dee187875d36188875b8692fc5f73"]);
        expect(FP).toBe("3e9cd2c0ad3aad3a0cfb8ee2ca7f1612ebe08eea1ba4ed267acb358d184885fd");
    });

    it("rechaza el esquema anterior (14 migraciones), con cualquier huella", async () => {
        expect(await outcome(prev)).toBe("MIGRACIONES_DEV");
        const prevFp = (await prev.$queryRaw<Array<{ fp: string }>>`SELECT encode(sha256(convert_to(string_agg(id||':'||migration_name||':'||checksum,'|' ORDER BY migration_name),'UTF8')),'hex') AS fp FROM "_prisma_migrations"`)[0].fp;
        expect(await outcome(prev, prevFp)).toBe("MIGRACIONES_DEV");
    });

    it("acepta el esquema actual sólo con su huella; la de DEV no coincide con la local", async () => {
        expect(await outcome(cur, localFp)).toBe("OK");
        expect(await outcome(cur)).toBe("HUELLA_DEV");
        expect(await outcome(cur, "0".repeat(64))).toBe("HUELLA_DEV");
    });

    it("detecta una fila del historial reescrita (misma cantidad y checksums)", async () => {
        expect(await withMutation(
            [`UPDATE "_prisma_migrations" SET id = reverse(id) WHERE migration_name = '0_init'`],
            [`UPDATE "_prisma_migrations" SET id = reverse(id) WHERE migration_name = '0_init'`])).toBe("HUELLA_DEV");
    });

    it.each([
        ["fila extra", [`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ('extra', 'x', '20991231000000_extra', now(), now(), 1)`], [`DELETE FROM "_prisma_migrations" WHERE id = 'extra'`]],
        ["checksum distinto", [`UPDATE "_prisma_migrations" SET checksum = reverse(checksum) WHERE migration_name = '20261028120000_arca_wsaa_ticket_cache'`], [`UPDATE "_prisma_migrations" SET checksum = reverse(checksum) WHERE migration_name = '20261028120000_arca_wsaa_ticket_cache'`]],
        ["nombre distinto", [`UPDATE "_prisma_migrations" SET migration_name = migration_name || '_x' WHERE migration_name = '20261009120000_period_close_reopen'`], [`UPDATE "_prisma_migrations" SET migration_name = '20261009120000_period_close_reopen' WHERE migration_name = '20261009120000_period_close_reopen_x'`]],
        ["nueva sin terminar", [`UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name = '20261102120000_arca_production_controls'`], [`UPDATE "_prisma_migrations" SET finished_at = started_at WHERE migration_name = '20261102120000_arca_production_controls'`]],
        ["con logs", [`UPDATE "_prisma_migrations" SET logs = 'x' WHERE migration_name = '0_init'`], [`UPDATE "_prisma_migrations" SET logs = NULL WHERE migration_name = '0_init'`]],
        ["revertida", [`UPDATE "_prisma_migrations" SET rolled_back_at = now() WHERE migration_name = '0_init'`], [`UPDATE "_prisma_migrations" SET rolled_back_at = NULL WHERE migration_name = '0_init'`]],
    ])("migraciones: %s", async (_label, apply, undo) => {
        expect(await withMutation(apply, undo)).toBe("MIGRACIONES_DEV");
    });

    const dropAdd = (table: string, name: string, bad: string, good: string): [string[], string[]] => [
        [`ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`, ...(bad ? [`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${bad}`] : [])],
        [`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`, `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${good}`]];
    it.each([
        ["CHECK de reserva ausente", ...dropAdd("ArcaWsaaTicket", "ArcaWsaaTicket_lease_check", "", LEASE)],
        ["CHECK de reserva NOT VALID", ...dropAdd("ArcaWsaaTicket", "ArcaWsaaTicket_lease_check", `${LEASE} NOT VALID`, LEASE)],
        ["CHECK de reserva con otra expresión", ...dropAdd("ArcaWsaaTicket", "ArcaWsaaTicket_lease_check", `CHECK ("leaseId" IS NULL OR "leaseUntil" IS NOT NULL)`, LEASE)],
        ["CHECK de payload ausente", ...dropAdd("ArcaWsaaTicket", "ArcaWsaaTicket_payload_check", "", `CHECK ((ciphertext IS NULL) = ("expiresAt" IS NULL))`)],
        ["CHECK de fila única ausente", ...dropAdd("ArcaPadronControl", "ArcaPadronControl_singleton_check", "", `CHECK (id = 'global')`)],
        ["CHECK de clave de cupo más laxo", ...dropAdd("ArcaLookupQuota", "ArcaLookupQuota_key_check", `CHECK (key ~ '^.*$')`, `CHECK (key ~ '^[uoc]:[A-Za-z0-9_-]{1,80}$')`)],
        ["CHECK extra en consumos", [`ALTER TABLE "ArcaLookupQuotaEvent" ADD CONSTRAINT "extra_check" CHECK (id > 0)`], [`ALTER TABLE "ArcaLookupQuotaEvent" DROP CONSTRAINT "extra_check"`]],
        ["CHECK extra en habilitación", [`ALTER TABLE "ArcaPadronOrganization" ADD CONSTRAINT "extra_check" CHECK (enabled IS NOT NULL)`], [`ALTER TABLE "ArcaPadronOrganization" DROP CONSTRAINT "extra_check"`]],
    ] as Array<[string, string[], string[]]>)("restricciones: %s", async (_label, apply, undo) => {
        expect(await withMutation(apply, undo)).toBe("RESTRICCION_TABLA");
    });

    const tableCases: Array<[string, string[], string[]]> = TABLES.flatMap((t) => [
        [`${t}: SELECT para anon`, [`GRANT SELECT ON "${t}" TO anon`], [`REVOKE ALL ON "${t}" FROM anon`]],
        [`${t}: ALL para service_role`, [`GRANT ALL ON "${t}" TO service_role`], [`REVOKE ALL ON "${t}" FROM service_role`]],
        [`${t}: SELECT para PUBLIC`, [`GRANT SELECT ON "${t}" TO PUBLIC`], [`REVOKE ALL ON "${t}" FROM PUBLIC`]],
        [`${t}: sin RLS`, [`ALTER TABLE "${t}" DISABLE ROW LEVEL SECURITY`], [`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`]],
        [`${t}: FORCE RLS`, [`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`], [`ALTER TABLE "${t}" NO FORCE ROW LEVEL SECURITY`]],
        [`${t}: con política`, [`CREATE POLICY "p_extra" ON "${t}" FOR SELECT TO authenticated USING (true)`], [`DROP POLICY "p_extra" ON "${t}"`]],
        [`${t}: otro propietario`, [`ALTER TABLE "${t}" OWNER TO service_role`], [`ALTER TABLE "${t}" OWNER TO postgres`]],
        [`${t}: ausente`, [`ALTER TABLE "${t}" RENAME TO "${t}_renombrada"`], [`ALTER TABLE "${t}_renombrada" RENAME TO "${t}"`]],
    ] as Array<[string, string[], string[]]>);
    it.each([
        ...tableCases,
        ["secuencia: USAGE para authenticated", [`GRANT USAGE ON SEQUENCE ${SEQ} TO authenticated`], [`REVOKE ALL ON SEQUENCE ${SEQ} FROM authenticated`]],
        ["secuencia: SELECT para PUBLIC", [`GRANT SELECT ON SEQUENCE ${SEQ} TO PUBLIC`], [`REVOKE ALL ON SEQUENCE ${SEQ} FROM PUBLIC`]],
        ["secuencia: ACL del propietario alterada", [`REVOKE UPDATE ON SEQUENCE ${SEQ} FROM postgres`], [`GRANT UPDATE ON SEQUENCE ${SEQ} TO postgres`]],
        ["secuencia: ausente", [`ALTER SEQUENCE ${SEQ} RENAME TO "seq_renombrada"`], [`ALTER SEQUENCE "seq_renombrada" RENAME TO ${SEQ}`]],
    ] as Array<[string, string[], string[]]>)("permisos: %s", async (_label, apply, undo) => {
        expect(await withMutation(apply, undo)).toBe("PERMISOS_TABLA");
    });

    it("el precheck es de sólo lectura: no cambia datos sintéticos", async () => {
        const state = () => cur.$queryRaw`SELECT (SELECT count(*) FROM "ArcaWsaaTicket") AS t, (SELECT count(*) FROM "ArcaPadronOrganization") AS o, (SELECT bool_or(enabled) FROM "ArcaPadronControl") AS g, (SELECT is_called FROM "ArcaLookupQuotaEvent_id_seq") AS s`;
        const before = await state();
        expect(await outcome(cur, localFp)).toBe("OK");
        expect(await state()).toEqual(before);
    });
});
