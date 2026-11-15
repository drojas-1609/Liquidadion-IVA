import { describe, expect, it, vi } from "vitest";
import { addMoney, groupReasons, reasonKey, CONSUMER_FINAL_MARK } from "@/lib/arca-sync/preview";
import { buildSyncPreview, confirmSyncPreview, ImportRejectedError, operationIdFor, PreviewChangedError, type Invoke, type SyncFile } from "@/lib/arca-sync/preview-run";

const file = (format: string | null = "MIS_COMPROBANTES"): SyncFile => ({ content: new Uint8Array([1, 2, 3]), format, sha256: "a".repeat(64) });
const totals = (total: string, extra: Record<string, string> = {}) => ({ count: 1, taxedNet: "0.00", vat: "0.00", nonTaxed: "0.00", exempt: "0.00", otherTaxes: "0.00", total, ...extra });

function invoicePreview(rows: Array<{ status: string; messages: string[] }>, token: string, ok = { total: "0.00" } as Record<string, string>) {
    const count = (status: string) => rows.filter((row) => row.status === status).length;
    return {
        token, fileErrors: [], rows,
        reconciliation: {
            statusCounts: { OK: count("OK"), DUPLICATE: count("DUPLICATE"), REVIEW: count("REVIEW"), ERROR: count("ERROR") },
            importable: { CONSOLIDATED: totals(ok.total, ok) },
            byRate: count("OK") ? { "0005": { net: "100.00", vat: "21.00" } } : {},
            notImported: { REVIEW: totals("50.00"), DUPLICATE: totals("0.00"), ERROR: { informedTotal: "0.00" } },
        },
    };
}
const legendPending = `la consulta de Mis Comprobantes no informa la denominación de la contraparte (documento 99): ${CONSUMER_FINAL_MARK}`;
const salesBase = () => invoicePreview([{ status: "REVIEW", messages: [legendPending] }, { status: "REVIEW", messages: [legendPending, "el total informado 10.01 no coincide con la suma de sus componentes 10.00 (diferencia 0.01)"] }], "b".repeat(64));
const salesLegend = () => invoicePreview([{ status: "OK", messages: [] }, { status: "REVIEW", messages: ["el total informado 10.01 no coincide con la suma de sus componentes 10.00 (diferencia 0.01)"] }], "c".repeat(64), { total: "121.00", taxedNet: "100.00", vat: "21.00", iibbPerception: "1.50", otherTaxes: "0.50" });

function salesInvoke(overrides: { legend?: () => unknown } = {}) {
    const calls: Array<{ call: string; body: Record<string, unknown> }> = [];
    const invoke: Invoke = vi.fn(async (call, body) => {
        calls.push({ call, body });
        if (call === "INVOICE_CONFIRM") return { ok: true, data: { imported: 1 } };
        return { ok: true, data: body.consumerFinalLegend ? (overrides.legend ?? salesLegend)() : salesBase() };
    });
    return { invoke, calls };
}
const task = { id: "task", source: "SALES" as const, clientId: "client" };

describe("vista previa de una fuente descargada de ARCA", () => {
    it("agrupa los motivos sin importes ni números de fila", () => {
        expect(reasonKey("el total informado 1234.50 no coincide con 10.00 (diferencia -0.01)")).toBe("el total informado … no coincide con … (diferencia …)");
        const reasons = groupReasons([
            { status: "REVIEW", messages: ["total 10.01 distinto", "sin código"] }, { status: "REVIEW", messages: ["total 99.99 distinto"] },
            { status: "OK", messages: ["no cuenta"] }, { status: "ERROR", messages: ["fecha inválida"] },
        ]);
        expect(reasons).toEqual([
            { status: "REVIEW", message: "total … distinto", rows: 2 },
            { status: "ERROR", message: "fecha inválida", rows: 1 },
            { status: "REVIEW", message: "sin código", rows: 1 },
        ]);
        expect(addMoney("10.05", "-0.10")).toBe("9.95");
    });

    it("ventas: muestra el resultado sin la leyenda y, aparte, con «CONSUMIDOR FINAL»; no confirma nada", async () => {
        const { invoke, calls } = salesInvoke();
        const summary = await buildSyncPreview(task, [file()], invoke);
        expect(summary.counts).toEqual({ OK: 0, DUPLICATE: 0, REVIEW: 2, ERROR: 0 });
        expect(summary.consumerFinal).toMatchObject({ rows: 2, counts: { OK: 1, DUPLICATE: 0, REVIEW: 1, ERROR: 0 } });
        expect(summary.consumerFinal!.invoices!.importable).toMatchObject({ total: "121.00", otherTaxes: "2.00" });
        expect(summary.consumerFinal!.reasons).toEqual([{ status: "REVIEW", message: "el total informado … no coincide con la suma de sus componentes … (diferencia …)", rows: 1 }]);
        expect(calls.map((entry) => entry.call)).toEqual(["INVOICE_PREVIEW", "INVOICE_PREVIEW"]);
        expect(JSON.stringify(summary)).not.toMatch(/token|vouchersFile/);
    });

    it("compras: no ofrece la leyenda", async () => {
        const invoke: Invoke = async () => ({ ok: true, data: salesBase() });
        expect((await buildSyncPreview({ ...task, source: "PURCHASES" }, [file()], invoke)).consumerFinal).toBeUndefined();
    });

    it("retenciones y percepciones: suma los archivos de cada impuesto", async () => {
        const tax = (ok: number, total: string) => ({ token: "d".repeat(64), fileErrors: [], rows: [], counts: { OK: ok, DUPLICATE: 0, REVIEW: 0, ERROR: 0 }, importableTotal: total, excludedTotal: "0.00" });
        const invoke: Invoke = vi.fn().mockResolvedValueOnce({ ok: true, data: tax(2, "10.10") }).mockResolvedValueOnce({ ok: true, data: tax(3, "0.95") });
        const summary = await buildSyncPreview({ ...task, source: "RETENTIONS" }, [file(null), file(null)], invoke);
        expect(summary.counts.OK).toBe(5);
        expect(summary.taxes).toEqual({ importableTotal: "11.05", excludedTotal: "0.00" });
    });

    it("el rechazo del importador no deja vista previa", async () => {
        await expect(buildSyncPreview(task, [file()], async () => ({ ok: false, data: null }))).rejects.toBeInstanceOf(ImportRejectedError);
        await expect(buildSyncPreview(task, [file()], async () => ({ ok: true, data: { ...salesBase(), fileErrors: ["columnas"] } }))).rejects.toBeInstanceOf(ImportRejectedError);
    });
});

describe("confirmación explícita", () => {
    it("incorpora la variante que vio la persona, con la leyenda sólo si la eligió", async () => {
        const seen = await buildSyncPreview(task, [file()], salesInvoke().invoke);
        const { invoke, calls } = salesInvoke();
        // PostgreSQL JSONB puede devolver las claves en otro orden.
        const stored = JSON.parse(JSON.stringify(seen, (_key, value) =>
            value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)))
                : value,
        ));
        const result = await confirmSyncPreview(task, [file()], stored, { consumerFinalLegend: true }, invoke);
        expect(result.imported).toBe(1);
        expect(result.summary.confirmed).toEqual({ consumerFinalLegend: true, imported: 1 });
        const confirm = calls.filter((entry) => entry.call === "INVOICE_CONFIRM");
        expect(confirm).toHaveLength(1);
        expect(confirm[0].body).toMatchObject({ consumerFinalLegend: true, token: "c".repeat(64), acceptPartial: true, operationId: operationIdFor("task", 0, "a".repeat(64), true) });
        expect(confirm[0].body.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("sin la leyenda no hay filas aptas: no escribe", async () => {
        const seen = await buildSyncPreview(task, [file()], salesInvoke().invoke);
        const { invoke, calls } = salesInvoke();
        expect((await confirmSyncPreview(task, [file()], seen, { consumerFinalLegend: false }, invoke)).imported).toBe(0);
        expect(calls.some((entry) => entry.call === "INVOICE_CONFIRM")).toBe(false);
    });

    it("si la vista previa cambió, no escribe y devuelve la nueva", async () => {
        const seen = await buildSyncPreview(task, [file()], salesInvoke().invoke);
        const changed = () => invoicePreview([{ status: "DUPLICATE", messages: ["ya cargado"] }, { status: "REVIEW", messages: ["x"] }], "e".repeat(64));
        const { invoke, calls } = salesInvoke({ legend: changed });
        const error = await confirmSyncPreview(task, [file()], seen, { consumerFinalLegend: true }, invoke).catch((caught) => caught);
        expect(error).toBeInstanceOf(PreviewChangedError);
        expect((error as PreviewChangedError).summary.consumerFinal!.counts.DUPLICATE).toBe(1);
        expect(calls.some((entry) => entry.call === "INVOICE_CONFIRM")).toBe(false);
    });
});
