import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { parseMisComprobantes } from "@/lib/libro-iva-import/mis-comprobantes-csv";
import { parseLidFile } from "@/lib/libro-iva-import/format";
import { buildImportPreview, type PreviewContext } from "@/lib/libro-iva-import/build";
import { computeLiquidation, type InvoiceForCalc } from "@/lib/liquidation-calc";
import { purchaseHasNoVatBreakdown, voucherDisplayLabel, voucherSign } from "@/lib/invoice-model";
import { VOUCHER_LIQUIDACIONES_A, VOUCHER_TYPES } from "@/lib/arca/catalogs";
import { derivedVoucherClass } from "@/lib/arca/voucher-legal-class";
import { invoiceIssues } from "@/lib/vat-export/classification";
import { writeLidFiles } from "@/lib/vat-export/lid-writer";
import { ExportFormatError } from "@/lib/vat-export/text";
import type { ExportInvoice } from "@/lib/vat-export/types";
import { ansiFile, cuit, purchaseAliquotLine, purchaseVoucherLine, salesAliquotLine, salesVoucherLine, type SynthAliquot, type SynthVoucher } from "./helpers/libro-iva-synth";

/**
 * 063 "LIQUIDACIONES A" (Libro IVA Digital – Tablas del Sistema, Tabla 3) en
 * COMPRAS y sin intermediario. Especificaciones (rev. 30/07/2025), Libro
 * Compras, campo 23 "CUIT Emisor / Corredor": se informa para 033, 058, 059,
 * 060 y 063; si no interviene un tercero, la CUIT del informante. Campo 25 "IVA
 * Comisión": sólo con corredor. Datos SINTÉTICOS.
 */
const CLIENT = cuit("2070000003");
const ISSUER = cuit("3071111111");
const BROKER = cuit("3070000001");
const D = (v: string) => new Prisma.Decimal(v);
const m = (d: Prisma.Decimal) => d.toFixed(2);
const ctx = (over: Partial<PreviewContext> = {}): PreviewContext => ({
    category: "PURCHASES",
    period: { month: 10, year: 2027 },
    settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: false },
    existingKeys: new Set(),
    informantCuit: CLIENT,
    ...over,
});

// ── Mis Comprobantes Recibidos (forma de la consulta; encabezado escrito a mano).
const H_RECIBIDOS = '"Fecha de Emisión";"Tipo de Comprobante";"Punto de Venta";"Número Desde";"Número Hasta";"Cód. Autorización";"Tipo Doc. Emisor";"Nro. Doc. Emisor";"Denominación Emisor";"Tipo Doc. Receptor";"Nro. Doc. Receptor";"Tipo Cambio";"Moneda";"Imp. Neto Gravado IVA 0%";"IVA 2,5%";"Imp. Neto Gravado IVA 2,5%";"IVA 5%";"Imp. Neto Gravado IVA 5%";"IVA 10,5%";"Imp. Neto Gravado IVA 10,5%";"IVA 21%";"Imp. Neto Gravado IVA 21%";"IVA 27%";"Imp. Neto Gravado IVA 27%";"Imp. Neto Gravado Total";"Imp. Neto No Gravado";"Imp. Op. Exentas";"Otros Tributos";"Total IVA";"Imp. Total"';
const recibido = (code: number, nro: number, r: { r21?: [string, string]; r105?: [string, string] }, net: string, vat: string, total: string) =>
    ["2027-10-31", code, 6, nro, nro, "71234567890123", 80, ISSUER, "BANCO SINTETICO SA", 80, CLIENT, "1,00", "$",
        "", "", "", "", "", r.r105?.[1] ?? "", r.r105?.[0] ?? "", r.r21?.[1] ?? "", r.r21?.[0] ?? "", "", "",
        net, "0,00", "0,00", "0,00", vat, total].join(";");
const utf8 = (lines: string[]) => new TextEncoder().encode(lines.join("\n") + "\n");
function misComprobantes(rows: string[], c = ctx({ source: "MIS_COMPROBANTES" })) {
    const p = parseMisComprobantes(utf8([H_RECIBIDOS, ...rows]), "PURCHASES", CLIENT);
    return buildImportPreview(c, p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.rowNotes });
}

// ── TXT del Libro IVA Digital.
const liq = (over: Partial<SynthVoucher> = {}): SynthVoucher => ({
    date: "20271031", code: 63, pos: 6, number: 8001, doc: ISSUER, name: "BANCO SINTETICO SA", total: "1210.00", aliquotCount: 1, computableCredit: "210.00", brokerCuit: CLIENT, ...over,
});
const lAli = (over: Partial<SynthAliquot> = {}): SynthAliquot => ({ code: 63, pos: 6, number: 8001, doc: ISSUER, net: "1000.00", rate: 5, vat: "210.00", ...over });
function txt(vouchers: SynthVoucher[], aliquots: SynthAliquot[], c = ctx()) {
    return buildImportPreview(
        c,
        parseLidFile(ansiFile(vouchers.map((v) => purchaseVoucherLine(v, false))), "PURCHASES", "VOUCHERS"),
        parseLidFile(ansiFile(aliquots.map(purchaseAliquotLine)), "PURCHASES", "ALIQUOTS"),
    );
}

describe("063 Liquidaciones A — catálogo, signo y clase", () => {
    it("clase A, factura (suma), sin etiqueta heredada; discrimina IVA en compras", () => {
        expect(VOUCHER_LIQUIDACIONES_A).toBe(63);
        expect(VOUCHER_TYPES.find((v) => v.code === 63)).toMatchObject({ label: "LIQUIDACIONES A", letter: "A", kind: "INVOICE", legacyLabel: null });
        expect(voucherSign(63)).toBe(1);
        expect(voucherDisplayLabel(63)).toBe("LIQUIDACIONES A");
        expect(derivedVoucherClass(63, "2027-10-31").legalClass).toBe("A");
        expect(purchaseHasNoVatBreakdown("PURCHASES", 63)).toBe(false);
    });
});

describe("063 Liquidaciones A — importación", () => {
    it("Mis Comprobantes Recibidos: dos liquidaciones (21 % y 10,5 %) quedan OK, con crédito computable directo y nota del campo 23", () => {
        const p = misComprobantes([
            recibido(63, 8001, { r21: ["1000,00", "210,00"] }, "1000,00", "210,00", "1210,00"),
            recibido(63, 8002, { r105: ["2000,00", "210,00"] }, "2000,00", "210,00", "2210,00"),
        ]);
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "OK"]);
        expect(p.rows.map((r) => r.model?.voucherCode)).toEqual([63, 63]);
        expect(p.rows.flatMap((r) => r.model!.vatLines.map((l) => [l.vatRateCode, m(l.vatAmount), l.creditAllocation]))).toEqual([[5, "210.00", "DIRECT_COMPUTABLE"], [4, "210.00", "DIRECT_COMPUTABLE"]]);
        expect(m(p.reconciliation.importable.CONSOLIDATED.computableCredit)).toBe("420.00");
        expect(p.rows[0].notes.join()).toMatch(/063 \(Liquidaciones A\) sin intermediario: el Libro IVA Digital informará la CUIT del informante/);
    });

    it("no se duplica: el mismo 063 repetido en el archivo es ERROR en la segunda fila", () => {
        const fila = recibido(63, 8001, { r21: ["1000,00", "210,00"] }, "1000,00", "210,00", "1210,00");
        expect(misComprobantes([fila, fila]).rows.map((r) => r.status)).toEqual(["OK", "ERROR"]);
    });

    it("TXT: con la CUIT del informante en el campo 23 y comisión 0 es OK", () => {
        const p = txt([liq()], [lAli()]);
        expect(p.rows[0].status).toBe("OK");
        expect(m(p.reconciliation.importable.CONSOLIDATED.computableCredit)).toBe("210.00");
    });

    it("TXT: con un corredor (otra CUIT) o con IVA comisión queda para revisión", () => {
        const p = txt([liq({ brokerCuit: BROKER }), liq({ number: 8002, commissionVat: "5.00" })], [lAli(), lAli({ number: 8002 })]);
        expect(p.rows.map((r) => r.status)).toEqual(["REVIEW", "REVIEW"]);
        expect(p.rows[0].messages.join()).toMatch(/063 \(Liquidaciones A\) con intermediario o IVA comisión/);
    });

    it("TXT: sin la CUIT del informante en el contexto, un campo 23 informado no se puede validar y queda para revisión", () => {
        expect(txt([liq()], [lAli()], ctx({ informantCuit: undefined })).rows[0].status).toBe("REVIEW");
    });

    it("ventas: el 063 no se admite (sólo compras en esta etapa)", () => {
        const p = buildImportPreview(
            ctx({ category: "SALES" }),
            parseLidFile(ansiFile([salesVoucherLine({ date: "20271031", code: 63, pos: 6, number: 1, doc: ISSUER, name: "CLIENTE SINTETICO SA", total: "1210.00", aliquotCount: 1 })]), "SALES", "VOUCHERS"),
            parseLidFile(ansiFile([salesAliquotLine({ code: 63, pos: 6, number: 1, net: "1000.00", rate: 5, vat: "210.00" })]), "SALES", "ALIQUOTS"),
        );
        expect(p.rows[0].status).toBe("REVIEW");
        expect(p.rows[0].messages.join()).toMatch(/sólo se admite en compras/);
    });

    it("los demás códigos con corredor siguen para revisión (sin cambios)", () => {
        const p = txt([liq({ code: 1, brokerCuit: CLIENT })], [lAli({ code: 1 })]);
        expect(p.rows[0].status).toBe("REVIEW");
        expect(p.rows[0].messages.join()).toMatch(/emisor\/corredor o IVA comisión informados/);
    });
});

describe("063 Liquidaciones A — crédito fiscal", () => {
    it("su IVA computable entra al crédito fiscal igual que el de una factura A", () => {
        const row = (code: number): InvoiceForCalc => ({
            category: "PURCHASES", netAmount: D("0"), vatAmount: D("0"), totalAmount: D("0"),
            voucherCode: code, taxedNetAmount: D("1000.00"), totalVatAmount: D("210.00"), netWithoutVatBreakdownAmount: D("0"),
            directComputableVatCreditAmount: D("210.00"), voucherTotalAmount: D("1210.00"), grossIncomeTaxBaseAmount: null,
            vatLines: [{ vatAmount: D("210.00"), creditAllocation: "DIRECT_COMPUTABLE" }],
        });
        const base = { taxRecords: [], client: { defaultIibbRate: D("3") }, vatSettings: null };
        const with63 = computeLiquidation({ ...base, invoices: [row(63)] });
        const withA = computeLiquidation({ ...base, invoices: [row(1)] });
        expect(m(with63.iva.creditDirect)).toBe("210.00");
        expect([m(with63.iva.credit), m(with63.purchases.vat)]).toEqual([m(withA.iva.credit), m(withA.purchases.vat)]);
    });
});

describe("063 Liquidaciones A — exportación al Libro IVA Digital", () => {
    const exportInvoice = (code: number): ExportInvoice => ({
        id: `x${code}`, category: "PURCHASES", voucherCode: code, pointOfSale: 6, number: 8001, numberTo: null, voucherDate: "2027-10-31",
        counterpartyDocType: 80, counterpartyDocNumber: ISSUER, counterpartyName: "BANCO SINTETICO SA", counterpartyVatConditionCode: null,
        currencyCode: "PES", exchangeRate: D("1"), taxedNetAmount: D("1000.00"), totalVatAmount: D("210.00"), directComputableVatCreditAmount: D("210.00"),
        netWithoutVatBreakdownAmount: D("0"), nonTaxedAmount: D("0"), exemptAmount: D("0"), vatPerceptionAmount: D("0"), nationalPerceptionAmount: D("0"),
        iibbPerceptionAmount: D("0"), municipalPerceptionAmount: D("0"), internalTaxesAmount: D("0"), otherTaxesAmount: D("0"), voucherTotalAmount: D("1210.00"),
        turivaRefundAmount: D("0"), lidSection: "GENERAL", operationCode: null, activityCode: null, saleOperationType: null, buyerType: null,
        purchaseCreditConcept: "SERVICES", dationInPayment: false,
        vatLines: [{ vatRateCode: 5, netAmount: D("1000.00"), vatAmount: D("210.00"), creditAllocation: "DIRECT_COMPUTABLE", computableVatAmount: D("210.00") }],
    } as ExportInvoice);
    const SETTINGS = { creditProrationMode: "NONE", turivaIncluded: false } as const;
    const INFORMANT = { cuit: CLIENT, name: "CONTRIBUYENTE SINTETICO" };
    const record = (files: { name: string; bytes: Uint8Array }[], prefix: string) => Buffer.from(files.find((f) => f.name.includes(prefix))!.bytes).toString("latin1").split("\r\n")[0];

    it("campos 23–25: CUIT y denominación del informante, IVA comisión 0; registro de 325 posiciones", () => {
        const out = writeLidFiles([exportInvoice(63)], SETTINGS, INFORMANT);
        const r = record(out.files, "COMPRAS_CBTE");
        expect(r).toHaveLength(325);
        expect(r.slice(8, 11)).toBe("063");
        expect(r.slice(269, 280)).toBe(CLIENT);
        expect(r.slice(280, 310)).toBe("CONTRIBUYENTE SINTETICO".padEnd(30, " "));
        expect(r.slice(310, 325)).toBe("0".repeat(15));
        // Una factura A sigue con ceros y espacios.
        const a = record(writeLidFiles([exportInvoice(1)], SETTINGS, INFORMANT).files, "COMPRAS_CBTE");
        expect(a.slice(269, 325)).toBe("0".repeat(11) + " ".repeat(30) + "0".repeat(15));
    });

    it("sin la CUIT del informante el 063 no se exporta (error de formato, nunca ceros)", () => {
        expect(() => writeLidFiles([exportInvoice(63)], SETTINGS)).toThrow(ExportFormatError);
    });

    it("ida y vuelta: lo que escribe la exportación lo vuelve a leer la importación como OK", () => {
        const out = writeLidFiles([exportInvoice(63)], SETTINGS, INFORMANT);
        const bytes = (prefix: string) => out.files.find((f) => f.name.includes(prefix))!.bytes;
        const p = buildImportPreview(ctx(), parseLidFile(bytes("COMPRAS_CBTE"), "PURCHASES", "VOUCHERS"), parseLidFile(bytes("COMPRAS_ALICUOTAS"), "PURCHASES", "ALIQUOTS"));
        expect(p.rows[0].status).toBe("OK");
        expect(m(p.reconciliation.importable.CONSOLIDATED.computableCredit)).toBe("210.00");
    });

    it("controles de presentación: como compra A con IVA, pide el concepto del crédito si falta", () => {
        const sinConcepto = { ...exportInvoice(63), purchaseCreditConcept: null };
        expect(invoiceIssues(sinConcepto, SETTINGS).map((i) => i.code)).toContain("PURCHASE_CONCEPT_MISSING");
        expect(invoiceIssues(exportInvoice(63), SETTINGS)).toEqual([]);
    });
});

describe("063 Liquidaciones A — sin carga manual", () => {
    it("el alta manual y el contrato de la API lo rechazan (sólo entra por la importación)", async () => {
        const { modelFromVoucher } = await import("@/lib/invoice-model");
        const { IMPORT_ONLY_VOUCHER_CODES } = await import("@/lib/arca/catalogs");
        expect(IMPORT_ONLY_VOUCHER_CODES.has(63)).toBe(true);
        const r = modelFromVoucher({
            category: "PURCHASES", voucherCode: 63, lidSection: "GENERAL", netAmount: D("1000.00"), vatRate: D("21"),
        } as Parameters<typeof modelFromVoucher>[0]);
        expect(r).toMatchObject({ ok: false, field: "voucherCode" });
        if (!r.ok) expect(r.error).toMatch(/sólo entra por la importación/);
    });
});
