import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { computeLiquidation } from "@/lib/liquidation-calc";
import { loadPeriodLiquidationInput } from "@/lib/liquidation-totals";

/**
 * Migración 20261106120000_vat_credit_adjustments contra PostgreSQL 17 LOCAL Y
 * DESCARTABLE (scripts/pg-local-regression.sh), con datos SINTÉTICOS:
 *  - CHECK de importes y del saldo técnico anterior;
 *  - un ajuste por régimen (unique) y FK compuesta con la organización del período;
 *  - borrado en cascada con el período;
 *  - RLS sin políticas y sin privilegios para los roles de la API de Supabase;
 *  - la carga agregada de la liquidación toma el saldo anterior y los ajustes.
 */
const raw = process.env.PR17_LOCAL_PG_URL ?? "";
if (raw) {
    const u = new URL(raw);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || /supabase|pooler|bqqruaikbqculvmtirvy|esyfpakajthdifhnhcew/i.test(raw)) throw Error("sólo PostgreSQL local");
}
const ORG_A = "org_vp_a", ORG_B = "org_vp_b", CLIENT_A = "cli_vp_a", PERIOD = "per_vp_a", PERIOD_DEL = "per_vp_del";
const D = (v: string) => new Prisma.Decimal(v);

describe.skipIf(!raw)("posición de IVA: ajustes por contribuciones y saldo técnico anterior (PostgreSQL)", () => {
    let db: PrismaClient;

    beforeAll(async () => {
        db = new PrismaClient({ datasourceUrl: raw });
        await db.organization.createMany({ data: [{ id: ORG_A, name: "ORG SINTETICA VP A" }, { id: ORG_B, name: "ORG SINTETICA VP B" }] });
        await db.client.create({ data: { id: CLIENT_A, name: "CLIENTE SINTETICO VP", cuit: "20700000037", condition: "RESPONSABLE_INSCRIPTO", organizationId: ORG_A } });
        await db.period.createMany({
            data: [
                { id: PERIOD, month: 9, year: 2027, clientId: CLIENT_A, organizationId: ORG_A },
                { id: PERIOD_DEL, month: 10, year: 2027, clientId: CLIENT_A, organizationId: ORG_A },
            ],
        });
        await db.invoice.createMany({
            data: [
                { id: "inv_vp_s", periodId: PERIOD, organizationId: ORG_A, clientId: CLIENT_A, category: "SALES", type: "FACTURA A", pointOfSale: 9, number: 1, date: new Date(Date.UTC(2027, 8, 10)), netAmount: D("4761.90"), vatAmount: D("1000.00"), totalAmount: D("5761.90") },
                { id: "inv_vp_p", periodId: PERIOD, organizationId: ORG_A, clientId: CLIENT_A, category: "PURCHASES", type: "FACTURA A", pointOfSale: 9, number: 2, date: new Date(Date.UTC(2027, 8, 11)), netAmount: D("2857.14"), vatAmount: D("600.00"), totalAmount: D("3457.14") },
            ],
        });
    });
    afterAll(async () => {
        if (!db) return;
        await db.invoice.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => undefined);
        await db.period.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } }).catch(() => undefined);
        await db.$disconnect();
    });

    it("la liquidación agregada toma el saldo técnico anterior y el ajuste Anexo I (saldo a favor 150)", async () => {
        await db.periodVatSettings.create({ data: { periodId: PERIOD, organizationId: ORG_A, previousTechnicalBalance: D("500.00"), previousTechnicalBalanceReference: "DJ sintética" } });
        await db.periodVatCreditAdjustment.create({ data: { periodId: PERIOD, organizationId: ORG_A, regime: "LEY_27541_ANEXO_I", contributionsAmount: D("684.93"), computableAmount: D("50.00") } });
        const input = await loadPeriodLiquidationInput(db, { organizationId: ORG_A, periodId: PERIOD });
        expect(input).not.toBeNull();
        const r = computeLiquidation(input!);
        expect([r.iva.debit, r.iva.credit, r.iva.previousTechnicalBalance, r.iva.balance, r.iva.technicalBalanceInFavor].map((d) => d.toFixed(2))).toEqual([
            "1000.00", "650.00", "500.00", "-150.00", "150.00",
        ]);
    });

    it("CHECK: computable <= contribuciones, sin negativos; saldo anterior >= 0; un ajuste por régimen", async () => {
        const base = { periodId: PERIOD, organizationId: ORG_A, regime: "LEY_27467_ART_91" as const };
        await expect(db.periodVatCreditAdjustment.create({ data: { ...base, contributionsAmount: D("10"), computableAmount: D("11") } })).rejects.toThrow();
        await expect(db.periodVatCreditAdjustment.create({ data: { ...base, contributionsAmount: D("-1"), computableAmount: D("0") } })).rejects.toThrow();
        await expect(db.periodVatSettings.update({ where: { periodId: PERIOD }, data: { previousTechnicalBalance: D("-0.01") } })).rejects.toThrow();
        await expect(
            db.periodVatCreditAdjustment.create({ data: { periodId: PERIOD, organizationId: ORG_A, regime: "LEY_27541_ANEXO_I", contributionsAmount: D("1"), computableAmount: D("1") } }),
        ).rejects.toThrow();
    });

    it("FK compuesta: no se puede colgar un ajuste de un período de otra organización", async () => {
        await expect(
            db.periodVatCreditAdjustment.create({ data: { periodId: PERIOD, organizationId: ORG_B, regime: "LEY_27467_ART_91", contributionsAmount: D("1"), computableAmount: D("1") } }),
        ).rejects.toThrow();
    });

    it("se borra con el período (cascada)", async () => {
        await db.periodVatCreditAdjustment.create({ data: { periodId: PERIOD_DEL, organizationId: ORG_A, regime: "LEY_27541_ANEXO_I", contributionsAmount: D("1"), computableAmount: D("1") } });
        await db.period.delete({ where: { id: PERIOD_DEL } });
        expect(await db.periodVatCreditAdjustment.count({ where: { periodId: PERIOD_DEL } })).toBe(0);
    });

    it("Data API: RLS activo, sin políticas y sin privilegios para PUBLIC, anon, authenticated ni service_role", async () => {
        const [rls] = await db.$queryRaw<Array<{ rls: boolean; policies: bigint }>>`
            SELECT c.relrowsecurity AS rls, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = 'PeriodVatCreditAdjustment'`;
        expect(rls.rls).toBe(true);
        expect(Number(rls.policies)).toBe(0);
        const privs = await db.$queryRaw<Array<{ role: string; any: boolean }>>`
            SELECT r.rolname AS role,
                   has_table_privilege(r.oid, 'public."PeriodVatCreditAdjustment"', 'SELECT,INSERT,UPDATE,DELETE') AS any
            FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') ORDER BY 1`;
        expect(privs.length).toBe(3);
        expect(privs.every((p) => !p.any)).toBe(true);
    });
});
