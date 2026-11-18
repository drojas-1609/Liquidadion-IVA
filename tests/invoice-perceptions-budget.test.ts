import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Prisma } from "@prisma/client";
import { reconcileInvoicePerceptions, RECONCILE_MAX_WRITES, IIBB_PERCEPTION_TYPE, IVA_PERCEPTION_TYPE } from "@/lib/invoice-perceptions";

// Datos sintéticos (CUIT de prueba). Base en memoria que cuenta las sentencias de escritura.
const AGENT = "30999999993";
const day = new Date("2026-10-16T00:00:00.000Z");
const d = (v: string) => new Prisma.Decimal(v);
const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (v && typeof v === "object" && "in" in (v as object)) ? (v as { in: unknown[] }).in.includes(row[k]) : row[k] === v);

function world(n: number) {
    const invoices = Array.from({ length: n }, (_, i) => ({
        id: `inv${i}`, voucherCode: 1, pointOfSale: 7, number: 1000 + i, voucherDate: day, date: day,
        counterpartyDocType: 80, counterpartyDocNumber: AGENT, vatPerceptionAmount: null, iibbPerceptionAmount: null,
        otherTaxesAmount: d("100.00"), internalTaxesAmount: null, organizationId: "o", periodId: "p",
    })) as Record<string, unknown>[];
    const records: Record<string, unknown>[] = [];
    const writes = { count: 0 };
    let seq = 0;
    const tx = {
        invoice: {
            findMany: async () => invoices.map((r) => ({ ...r })),
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { writes.count++; invoices.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, data)); return { count: 1 }; },
        },
        taxRecord: {
            findMany: async () => records.map((r) => ({ ...r })),
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { writes.count++; records.filter((r) => matches(r, where)).forEach((r) => Object.assign(r, data)); return { count: 1 }; },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => { writes.count++; for (let i = records.length - 1; i >= 0; i--) if (matches(records[i], where)) records.splice(i, 1); return { count: 1 }; },
            createMany: async ({ data }: { data: Record<string, unknown>[] }) => { writes.count++; data.forEach((r) => records.push({ id: `t${seq++}`, nature: null, voucherNumber: null, ...r })); return { count: data.length }; },
        },
        clientJurisdiction: { findMany: async () => [{ jurisdictionCode: "902", isHeadquarters: true }] },
        supplierOtherTaxesRule: { findMany: async () => [{ supplierCuit: AGENT, kind: "IIBB_PERCEPTION" }] },
    };
    return { tx: tx as never, invoices, records, writes };
}
const scope = { organizationId: "o", periodId: "p", clientId: "c", profileId: "u" };

describe("conciliación por tramos (tope de escrituras por transacción)", () => {
    it("con mucho trabajo aplica a lo sumo el tope y avisa que quedó pendiente", async () => {
        const w = world(30);
        const r = await reconcileInvoicePerceptions(w.tx, scope);
        expect(w.writes.count).toBeLessThanOrEqual(RECONCILE_MAX_WRITES);
        expect(r).toEqual({ changes: RECONCILE_MAX_WRITES, pending: true });
    });

    it("tramo a tramo converge al mismo resultado y luego no hay más cambios", async () => {
        const w = world(30);
        let rounds = 0, r;
        do { w.writes.count = 0; r = await reconcileInvoicePerceptions(w.tx, scope); rounds++; expect(w.writes.count).toBeLessThanOrEqual(RECONCILE_MAX_WRITES); } while (r.pending && rounds < 10);
        expect(r.pending).toBe(false);
        expect(w.invoices.every((i) => String(i.iibbPerceptionAmount) === "100" && String(i.otherTaxesAmount) === "0")).toBe(true);
        expect(w.records.filter((t) => t.type === IIBB_PERCEPTION_TYPE && t.fromInvoice)).toHaveLength(30);
        expect(w.records.some((t) => t.type === IVA_PERCEPTION_TYPE)).toBe(false);
        expect(await reconcileInvoicePerceptions(w.tx, scope)).toEqual({ changes: 0, pending: false });
    });

    it("las altas de un tramo van en una sola sentencia", async () => {
        const w = world(5);
        expect(await reconcileInvoicePerceptions(w.tx, scope, { maxWrites: 5 })).toEqual({ changes: 5, pending: true }); // sólo separa las 5 compras
        w.writes.count = 0;
        const r = await reconcileInvoicePerceptions(w.tx, scope);
        expect(r).toEqual({ changes: 5, pending: false });
        expect(w.writes.count).toBe(1);
        expect(w.records.every((t) => t.invoiceId && t.jurisdictionCode === "902")).toBe(true);
    });
});
