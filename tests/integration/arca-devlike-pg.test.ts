import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postgresTicketStore, TicketStoreFailure } from "@/lib/arca-padron/ticket-store";
import { postgresQuotaStore, QuotaStoreFailure } from "@/lib/arca-padron/quota-store";
import { productionLookupEnabled } from "@/lib/arca-padron/production-switch";

/**
 * Esquema equivalente al DEV actual (las migraciones anteriores a
 * 20261102120000_arca_production_controls), en un PostgreSQL local descartable
 * que arma scripts/pg-local-regression.sh. El código nuevo debe fallar cerrado
 * sin pedir tickets a WSAA.
 */
const raw = process.env.PR17_LOCAL_PG_DEVLIKE_URL;
if (raw && !["127.0.0.1", "localhost"].includes(new URL(raw).hostname)) throw Error("sólo PostgreSQL local");

describe.skipIf(!raw)("esquema DEV previo a la migración de controles de producción", () => {
    let db: PrismaClient;
    beforeAll(() => { db = new PrismaClient({ datasources: { db: { url: raw! } } }); });
    afterAll(async () => { await db?.$disconnect(); });
    it("tickets, cupos e interruptor fallan cerrados; no se emite ningún ticket", async () => {
        let issued = 0;
        const store = postgresTicketStore("f".repeat(64), Buffer.alloc(32, 5), Date.now, db);
        await expect(store.getOrIssue(async () => { issued++; return { token: "X", sign: "Y", expiresAt: Date.now() + 3600000 }; })).rejects.toBeInstanceOf(TicketStoreFailure);
        expect(issued).toBe(0);
        await expect(postgresQuotaStore(db).consume([{ key: "u:p1", limit: 1, windowMs: 60000 }])).rejects.toBeInstanceOf(QuotaStoreFailure);
        await expect(productionLookupEnabled("org", db)).rejects.toThrow();
    });
});
