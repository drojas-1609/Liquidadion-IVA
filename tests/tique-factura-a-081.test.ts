import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { parseLidFile } from "@/lib/libro-iva-import/format";
import { parsePortalDownload } from "@/lib/libro-iva-import/portal-csv";
import { buildImportPreview, voucherKey, type PreviewContext } from "@/lib/libro-iva-import/build";
import { computeLiquidation, type InvoiceForCalc } from "@/lib/liquidation-calc";
import { voucherSign, voucherDisplayLabel } from "@/lib/invoice-model";
import { VOUCHER_TYPES } from "@/lib/arca/catalogs";
import { derivedVoucherClass } from "@/lib/arca/voucher-legal-class";
import {
    ansiFile, cuit, portalCsv, purchaseAliquotLine, purchaseVoucherLine,
    type SynthAliquot, type SynthPortalRow, type SynthVoucher,
} from "./helpers/libro-iva-synth";

/**
 * 081 "TIQUE FACTURA A CONTROLADORES FISCALES" (Libro IVA Digital, Tabla 3):
 * clase A con el IVA discriminado (RG 3561, Anexo II, campo 12). Datos
 * SINTÉTICOS: CUIT ficticios con dígito verificador válido.
 */
const SELLER = cuit("3071111111");
const D = (v: string) => new Prisma.Decimal(v);
const m = (d: Prisma.Decimal) => d.toFixed(2);
const ctx = (over: Partial<PreviewContext> = {}): PreviewContext => ({
    category: "PURCHASES",
    period: { month: 10, year: 2026 },
    settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: false },
    existingKeys: new Set(),
    ...over,
});
const tique = (over: Partial<SynthVoucher> = {}): SynthVoucher => ({
    date: "20261010", code: 81, pos: 4, number: 57001, doc: SELLER, name: "PROVEEDOR SINTETICO SRL", total: "1210.00", aliquotCount: 1, computableCredit: "210.00", ...over,
});
const tAli = (over: Partial<SynthAliquot> = {}): SynthAliquot => ({ code: 81, pos: 4, number: 57001, doc: SELLER, net: "1000.00", rate: 5, vat: "210.00", ...over });
function txtPreview(vouchers: SynthVoucher[], aliquots: SynthAliquot[], c = ctx()) {
    return buildImportPreview(
        c,
        parseLidFile(ansiFile(vouchers.map((v) => purchaseVoucherLine(v, false))), "PURCHASES", "VOUCHERS"),
        parseLidFile(ansiFile(aliquots.map(purchaseAliquotLine)), "PURCHASES", "ALIQUOTS"),
    );
}
const portalTique = (over: Partial<SynthPortalRow> = {}): SynthPortalRow => ({
    date: "2026-10-10", code: 81, pos: 4, number: 57001, doc: SELLER, name: "PROVEEDOR SINTETICO SRL", total: "1210.00", computableCredit: "210.00", rates: { "21": ["1000.00", "210.00"] }, ...over,
});
function portalPreview(rows: SynthPortalRow[], c = ctx({ source: "PORTAL_CSV" })) {
    const p = parsePortalDownload(portalCsv("PURCHASES", rows), "PURCHASES");
    return buildImportPreview(c, p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.totalColumnNotes });
}

describe("081 Tique Factura A — catálogo", () => {
    it("clase A, factura (suma), sin etiqueta heredada; se muestra con la denominación oficial", () => {
        expect(VOUCHER_TYPES.find((v) => v.code === 81)).toMatchObject({ letter: "A", kind: "INVOICE", legacyLabel: null });
        expect(voucherSign(81)).toBe(1);
        expect(voucherDisplayLabel(81)).toBe("TIQUE FACTURA A CONTROLADORES FISCALES");
        expect(derivedVoucherClass(81, "2026-09-10").legalClass).toBe("A");
    });
});

describe("081 Tique Factura A — importación", () => {
    it("TXT del Libro IVA Digital: compra 081 al 21 % es OK, con crédito computable directo", () => {
        const p = txtPreview([tique()], [tAli()]);
        expect(p.rows[0].status).toBe("OK");
        expect(p.rows[0].model?.voucherCode).toBe(81);
        expect(p.rows[0].model?.vatLines.map((l) => [l.vatRateCode, m(l.netAmount), m(l.vatAmount), l.creditAllocation])).toEqual([[5, "1000.00", "210.00", "DIRECT_COMPUTABLE"]]);
        expect(m(p.reconciliation.importable.CONSOLIDATED.computableCredit)).toBe("210.00");
    });

    it("descarga de Portal IVA: compra 081 al 21 % es OK, igual que una factura A", () => {
        const p = portalPreview([portalTique(), portalTique({ code: 1, number: 9001 })]);
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "OK"]);
        expect(p.rows.map((r) => r.model?.voucherCode)).toEqual([81, 1]);
        expect(m(p.reconciliation.importable.CONSOLIDATED.computableCredit)).toBe("420.00");
    });

    it("duplicados: un 081 ya cargado es DUPLICATE y no suma; el mismo número con otro código no lo es", () => {
        const key = voucherKey({ category: "PURCHASES", voucherCode: 81, pointOfSale: 4, number: 57001, counterpartyDocType: 80, counterpartyDocNumber: SELLER });
        const dup = txtPreview([tique()], [tAli()], ctx({ existingKeys: new Set([key]) }));
        expect(dup.rows[0].status).toBe("DUPLICATE");
        expect(dup.reconciliation.importable.CONSOLIDATED.count).toBe(0);
        const otherCode = voucherKey({ category: "PURCHASES", voucherCode: 1, pointOfSale: 4, number: 57001, counterpartyDocType: 80, counterpartyDocNumber: SELLER });
        expect(txtPreview([tique()], [tAli()], ctx({ existingKeys: new Set([otherCode]) })).rows[0].status).toBe("OK");
        // Repetido dentro del mismo archivo: ERROR en la segunda fila.
        expect(txtPreview([tique(), tique()], [tAli()]).rows.map((r) => r.status)).toEqual(["OK", "ERROR"]);
    });

    it("082 (Tique Factura B) y 083 (Tique) siguen fuera del catálogo: quedan para revisión", () => {
        const p = txtPreview([tique({ code: 82, number: 1 }), tique({ code: 83, number: 2 })], [tAli({ code: 82, number: 1 }), tAli({ code: 83, number: 2 })]);
        expect(p.rows.map((r) => r.status)).toEqual(["REVIEW", "REVIEW"]);
        expect(p.rows[0].messages[0]).toMatch(/082 no admitido/);
    });
});

describe("081 Tique Factura A — crédito fiscal en la liquidación", () => {
    it("su IVA computable entra al crédito fiscal como el de una factura A", () => {
        const row = (code: number): InvoiceForCalc => ({
            category: "PURCHASES", netAmount: D("0"), vatAmount: D("0"), totalAmount: D("0"),
            voucherCode: code, taxedNetAmount: D("1000.00"), totalVatAmount: D("210.00"), netWithoutVatBreakdownAmount: D("0"),
            directComputableVatCreditAmount: D("210.00"), voucherTotalAmount: D("1210.00"), grossIncomeTaxBaseAmount: null,
            vatLines: [{ vatAmount: D("210.00"), creditAllocation: "DIRECT_COMPUTABLE" }],
        });
        const base = { taxRecords: [], client: { defaultIibbRate: D("3") }, vatSettings: null };
        const withTique = computeLiquidation({ ...base, invoices: [row(81)] });
        const withA = computeLiquidation({ ...base, invoices: [row(1)] });
        expect(m(withTique.iva.creditDirect)).toBe("210.00");
        expect([m(withTique.iva.credit), m(withTique.purchases.vat)]).toEqual([m(withA.iva.credit), m(withA.purchases.vat)]);
    });
});
