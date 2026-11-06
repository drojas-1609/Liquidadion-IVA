import { describe, it, expect } from "vitest";
import { inflateRawSync, crc32 as nodeCrc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { parseLidFile } from "@/lib/libro-iva-import/format";
import { buildImportPreview } from "@/lib/libro-iva-import/build";
import { computeLiquidation, type InvoiceForCalc } from "@/lib/liquidation-calc";
import { writeLidFiles, LID_FILE_NAMES } from "@/lib/vat-export/lid-writer";
import { writeIvaSimpleFiles, IVA_SIMPLE_FILE_NAMES } from "@/lib/vat-export/iva-simple-csv";
import { writeF2051Files, F2051_FILE_NAMES } from "@/lib/vat-export/f2051-csv";
import { buildPackage, periodExportIssues } from "@/lib/vat-export/package";
import { buyerTypeFromVatCondition, invoiceIssues } from "@/lib/vat-export/classification";
import { lidAmount, lidText, ExportFormatError, csvAmount } from "@/lib/vat-export/text";
import { writeZip } from "@/lib/vat-export/zip";
import type { ExportInvoice, ExportTaxRecord } from "@/lib/vat-export/types";
import { cuit } from "./helpers/libro-iva-synth";

/** Datos 100 % sintéticos. */
const D = (v: string | number) => new Prisma.Decimal(v);
const CUIT_A = cuit("3071111111");
const CUIT_B = cuit("2033333333");
const CUIT_AGENT = cuit("3070000000");

let seq = 0;
function line(rate: number, net: string, vat: string, alloc = "NOT_APPLICABLE", computable: string | null = null) {
    return { vatRateCode: rate, netAmount: D(net), vatAmount: D(vat), creditAllocation: alloc, computableVatAmount: computable === null ? null : D(computable) };
}
function inv(p: Partial<ExportInvoice> & Pick<ExportInvoice, "category" | "voucherCode">): ExportInvoice {
    const lines = p.vatLines ?? [];
    const taxed = lines.reduce((s, l) => s.plus(l.netAmount), D(0));
    const vat = lines.reduce((s, l) => s.plus(l.vatAmount), D(0));
    const base: ExportInvoice = {
        id: `inv${++seq}`,
        pointOfSale: 3,
        number: seq,
        numberTo: null,
        voucherDate: "2027-01-15",
        counterpartyDocType: 80,
        counterpartyDocNumber: CUIT_A,
        counterpartyName: "PROVEEDOR SINTETICO SA",
        counterpartyVatConditionCode: null,
        currencyCode: "PES",
        exchangeRate: D(1),
        taxedNetAmount: taxed,
        totalVatAmount: vat,
        directComputableVatCreditAmount: p.category === "PURCHASES" ? lines.reduce((s, l) => s.plus(l.computableVatAmount ?? 0), D(0)) : D(0),
        netWithoutVatBreakdownAmount: D(0),
        nonTaxedAmount: D(0),
        exemptAmount: D(0),
        vatPerceptionAmount: D(0),
        nationalPerceptionAmount: D(0),
        iibbPerceptionAmount: D(0),
        municipalPerceptionAmount: D(0),
        internalTaxesAmount: D(0),
        otherTaxesAmount: D(0),
        voucherTotalAmount: D(0),
        turivaRefundAmount: D(0),
        lidSection: "GENERAL",
        operationCode: null,
        activityCode: p.category === "SALES" ? "620100" : null,
        saleOperationType: p.category === "SALES" ? "GOODS_SERVICES" : null,
        buyerType: null,
        purchaseCreditConcept: p.category === "PURCHASES" ? "GOODS" : null,
        dationInPayment: false,
        vatLines: lines,
        ...p,
    };
    const total = [base.taxedNetAmount, base.totalVatAmount, base.netWithoutVatBreakdownAmount, base.nonTaxedAmount, base.exemptAmount, base.vatPerceptionAmount, base.nationalPerceptionAmount, base.iibbPerceptionAmount, base.municipalPerceptionAmount, base.internalTaxesAmount, base.otherTaxesAmount]
        .reduce<Prisma.Decimal>((s, v) => s.plus(v ?? 0), D(0));
    return { ...base, voucherTotalAmount: p.voucherTotalAmount ?? total };
}

const SETTINGS = { creditProrationMode: "NONE", turivaIncluded: false } as const;

function sampleInvoices(): ExportInvoice[] {
    seq = 0;
    return [
        // Ventas
        inv({ category: "SALES", voucherCode: 1, counterpartyVatConditionCode: 1, vatLines: [line(5, "1000.00", "210.00"), line(4, "200.00", "21.00")] }),
        inv({ category: "SALES", voucherCode: 6, counterpartyDocType: 99, counterpartyDocNumber: "0", counterpartyName: "CONSUMIDOR FINAL", counterpartyVatConditionCode: 5, vatLines: [line(5, "500.00", "105.00")] }),
        inv({ category: "SALES", voucherCode: 6, counterpartyDocType: 96, counterpartyDocNumber: "30111222", counterpartyName: "Ñandú García", counterpartyVatConditionCode: 6, vatLines: [line(5, "100.00", "21.00")], dationInPayment: true }),
        inv({ category: "SALES", voucherCode: 3, counterpartyVatConditionCode: 1, vatLines: [line(5, "100.00", "21.00")] }), // NC emitida
        inv({ category: "SALES", voucherCode: 1, counterpartyVatConditionCode: 1, exemptAmount: D("300.00"), operationCode: "E", saleOperationType: null, vatLines: [] }), // sólo exenta
        inv({ category: "SALES", voucherCode: 19, counterpartyDocType: 80, counterpartyDocNumber: "50000000016", counterpartyName: "CLIENTE EXTERIOR", operationCode: "X", activityCode: null, saleOperationType: null, vatLines: [line(3, "800.00", "0.00")] }),
        // Compras
        inv({ category: "PURCHASES", voucherCode: 1, vatLines: [line(5, "400.00", "84.00", "DIRECT_COMPUTABLE", "84.00")], vatPerceptionAmount: D("12.00") }),
        inv({ category: "PURCHASES", voucherCode: 1, counterpartyDocNumber: CUIT_B, purchaseCreditConcept: "SERVICES", vatLines: [line(4, "100.00", "10.50", "DIRECT_COMPUTABLE", "10.50"), line(5, "50.00", "10.50", "DIRECT_COMPUTABLE", "10.50")] }),
        inv({ category: "PURCHASES", voucherCode: 3, vatLines: [line(5, "40.00", "8.40", "DIRECT_COMPUTABLE", "8.40")] }), // NC recibida
        inv({ category: "PURCHASES", voucherCode: 11, purchaseCreditConcept: null, netWithoutVatBreakdownAmount: D("77.00"), vatLines: [] }), // factura C
    ];
}

function toCalc(i: ExportInvoice): InvoiceForCalc {
    return {
        category: i.category, netAmount: D(0), vatAmount: D(0), totalAmount: D(0),
        voucherCode: i.voucherCode, taxedNetAmount: i.taxedNetAmount, totalVatAmount: i.totalVatAmount,
        netWithoutVatBreakdownAmount: i.netWithoutVatBreakdownAmount, directComputableVatCreditAmount: i.directComputableVatCreditAmount,
        grossIncomeTaxBaseAmount: i.category === "SALES" ? D(0) : null, voucherTotalAmount: i.voucherTotalAmount,
        vatLines: i.vatLines.map((l) => ({ vatAmount: l.vatAmount, creditAllocation: l.creditAllocation })),
    } as InvoiceForCalc;
}

const byName = (files: { name: string; bytes: Uint8Array }[], name: string) => {
    const f = files.find((x) => x.name === name);
    if (!f) throw new Error(`falta ${name}`);
    return f.bytes;
};

describe("Libro IVA Digital: escritura verificada con el lector del importador (independiente)", () => {
    const invoices = sampleInvoices();
    const { files, omitted } = writeLidFiles(invoices, SETTINGS);

    it("genera los pares general de ventas y compras; omite TurIVA y no genera vacíos", () => {
        expect(files.map((f) => f.name).sort()).toEqual([
            LID_FILE_NAMES.PURCHASES_GENERAL_ALIQUOTS, LID_FILE_NAMES.PURCHASES_GENERAL_VOUCHERS,
            LID_FILE_NAMES.SALES_GENERAL_ALIQUOTS, LID_FILE_NAMES.SALES_GENERAL_VOUCHERS,
        ].sort());
        expect(files.every((f) => f.bytes.length > 0)).toBe(true);
        expect(omitted).toEqual([]);
    });

    it("longitudes del diseño (266 / 62 / 325 / 84), ANSI de un byte por carácter y CRLF", () => {
        const check = (name: string, len: number) => {
            const b = byName(files, name);
            const text = Buffer.from(b).toString("latin1");
            const lines = text.split("\r\n");
            expect(lines.at(-1)).toBe("");
            for (const l of lines.slice(0, -1)) expect(l.length).toBe(len);
        };
        check(LID_FILE_NAMES.SALES_GENERAL_VOUCHERS, 266);
        check(LID_FILE_NAMES.SALES_GENERAL_ALIQUOTS, 62);
        check(LID_FILE_NAMES.PURCHASES_GENERAL_VOUCHERS, 325);
        check(LID_FILE_NAMES.PURCHASES_GENERAL_ALIQUOTS, 84);
        // "Ñandú García" en ISO 8859-1: Ñ = 0xD1, ú = 0xFA, í = 0xED.
        const sales = byName(files, LID_FILE_NAMES.SALES_GENERAL_VOUCHERS);
        expect([...sales].includes(0xd1) && [...sales].includes(0xfa) && [...sales].includes(0xed)).toBe(true);
    });

    it("posiciones fijas del Anexo I (verificadas a mano en el primer registro de ventas)", () => {
        const first = Buffer.from(byName(files, LID_FILE_NAMES.SALES_GENERAL_VOUCHERS)).toString("latin1").split("\r\n")[0];
        const pos = (a: number, b: number) => first.slice(a - 1, b);
        expect(pos(1, 8)).toBe("20270115");
        expect(pos(9, 11)).toBe("001");
        expect(pos(12, 16)).toBe("00003");
        expect(pos(17, 36)).toBe("00000000000000000001");
        expect(pos(37, 56)).toBe("00000000000000000001");
        expect(pos(57, 58)).toBe("80");
        expect(pos(59, 78)).toBe(CUIT_A.padStart(20, "0"));
        expect(pos(79, 108)).toBe("PROVEEDOR SINTETICO SA        ");
        expect(pos(109, 123)).toBe("000000000143100"); // 1000 + 210 + 200 + 21
        expect(pos(229, 231)).toBe("PES");
        expect(pos(232, 241)).toBe("0001000000");
        expect(pos(242, 242)).toBe("2");
        expect(pos(243, 243)).toBe("0");
        expect(pos(259, 266)).toBe("00000000");
    });

    it("el importador vuelve a leer todo como importable y con los mismos importes (ida y vuelta)", () => {
        for (const category of ["SALES", "PURCHASES"] as const) {
            const vName = category === "SALES" ? LID_FILE_NAMES.SALES_GENERAL_VOUCHERS : LID_FILE_NAMES.PURCHASES_GENERAL_VOUCHERS;
            const aName = category === "SALES" ? LID_FILE_NAMES.SALES_GENERAL_ALIQUOTS : LID_FILE_NAMES.PURCHASES_GENERAL_ALIQUOTS;
            const vouchers = parseLidFile(byName(files, vName), category, "VOUCHERS");
            const aliquots = parseLidFile(byName(files, aName), category, "ALIQUOTS");
            expect(vouchers.issues).toEqual([]);
            expect(aliquots.issues).toEqual([]);
            const preview = buildImportPreview(
                { category, period: { month: 1, year: 2027 }, settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: false }, existingKeys: new Set() },
                vouchers, aliquots,
            );
            expect(preview.fileErrors).toEqual([]);
            const mine = invoices.filter((i) => i.category === category);
            expect(preview.rows.map((r) => [r.status, r.messages])).toEqual(mine.map(() => ["OK", []]));
            for (const r of preview.rows) {
                const orig = mine.find((i) => i.voucherCode === r.model!.voucherCode && i.number === r.model!.number)!;
                expect(r.model!.voucherTotalAmount.toFixed(2)).toBe(orig.voucherTotalAmount!.toFixed(2));
                expect(r.model!.totalVatAmount.toFixed(2)).toBe(orig.totalVatAmount!.toFixed(2));
                expect(r.model!.taxedNetAmount.toFixed(2)).toBe(orig.taxedNetAmount!.toFixed(2));
                expect(r.model!.exemptAmount.toFixed(2)).toBe(orig.exemptAmount!.toFixed(2));
                expect(r.model!.vatPerceptionAmount.toFixed(2)).toBe(orig.vatPerceptionAmount!.toFixed(2));
                expect(r.model!.counterpartyName).toBe(orig.counterpartyName);
                expect(r.model!.operationCode).toBe(orig.vatLines.some((l) => l.vatRateCode === 3) || orig.vatLines.length === 0 ? (orig.operationCode ?? null) : null);
            }
            // Notas de crédito: importes positivos en el archivo; el signo lo da el código (sin doble inversión).
            const signed = preview.reconciliation.importable.CONSOLIDATED.vat;
            const expected = mine.reduce((s, i) => s.plus(i.totalVatAmount!.times([3, 8, 13, 21, 53].includes(i.voucherCode!) ? -1 : 1)), D(0));
            expect(signed.toFixed(2)).toBe(expected.toFixed(2));
        }
    });

    it("compras B/C con cantidad de alícuotas 0 y sin registro de alícuotas; venta sólo exenta con 0003 neto 0 y código E", () => {
        const pv = Buffer.from(byName(files, LID_FILE_NAMES.PURCHASES_GENERAL_VOUCHERS)).toString("latin1").split("\r\n");
        const factC = pv.find((l) => l.slice(8, 11) === "011")!;
        expect(factC.slice(237, 238)).toBe("0");
        const pa = Buffer.from(byName(files, LID_FILE_NAMES.PURCHASES_GENERAL_ALIQUOTS)).toString("latin1");
        expect(pa.split("\r\n").some((l) => l.startsWith("011"))).toBe(false);
        const sa = Buffer.from(byName(files, LID_FILE_NAMES.SALES_GENERAL_ALIQUOTS)).toString("latin1").split("\r\n");
        const sv = Buffer.from(byName(files, LID_FILE_NAMES.SALES_GENERAL_VOUCHERS)).toString("latin1").split("\r\n");
        const exemptIdx = sv.findIndex((l) => l.slice(242, 243) === "E");
        expect(exemptIdx).toBeGreaterThanOrEqual(0);
        const num = sv[exemptIdx].slice(16, 36);
        const al = sa.filter((l) => l.slice(8, 28) === num);
        expect(al).toHaveLength(1);
        expect(al[0].slice(28, 43)).toBe("0".repeat(15));
        expect(al[0].slice(43, 47)).toBe("0003");
    });

    it("mismo orden de comprobantes en cabecera y alícuotas", () => {
        const sv = Buffer.from(byName(files, LID_FILE_NAMES.SALES_GENERAL_VOUCHERS)).toString("latin1").split("\r\n").filter(Boolean);
        const sa = Buffer.from(byName(files, LID_FILE_NAMES.SALES_GENERAL_ALIQUOTS)).toString("latin1").split("\r\n").filter(Boolean);
        const order = sv.flatMap((l) => Array(Number(l.slice(241, 242))).fill(l.slice(8, 36)));
        expect(sa.map((l) => l.slice(0, 28))).toEqual(order);
    });

    it("crédito computable del campo 21 según la modalidad del período", () => {
        const one = [inv({ category: "PURCHASES", voucherCode: 1, vatLines: [line(5, "100.00", "21.00", "DIRECT_COMPUTABLE", "10.00")] })];
        one[0].directComputableVatCreditAmount = D("10.00");
        const f21 = (mode: string) => Buffer.from(writeLidFiles(one, { creditProrationMode: mode, turivaIncluded: false }).files[0].bytes).toString("latin1").slice(239, 254);
        expect(f21("NONE")).toBe("000000000002100");
        expect(f21("DIRECT")).toBe("000000000001000");
        expect(f21("DIRECT_AND_GLOBAL")).toBe("000000000001000");
        expect(f21("GLOBAL")).toBe("000000000000000");
    });

    it("TurIVA en archivo propio con el reintegro (281 posiciones)", () => {
        const t = [inv({ category: "SALES", voucherCode: 195, lidSection: "TURIVA", turivaRefundAmount: D("15.00"), vatLines: [line(5, "100.00", "21.00")] })];
        const out = writeLidFiles(t, { creditProrationMode: "NONE", turivaIncluded: true });
        const v = Buffer.from(out.files.find((f) => f.name === LID_FILE_NAMES.SALES_TURIVA_VOUCHERS)!.bytes).toString("latin1").split("\r\n")[0];
        expect(v).toHaveLength(281);
        expect(v.slice(266, 281)).toBe("000000000001500");
        expect(out.omitted.map((o) => o.name)).toContain(LID_FILE_NAMES.SALES_GENERAL_VOUCHERS);
    });

    it("formato: importes negativos con '-' en la primera posición; texto fuera de ANSI se rechaza", () => {
        expect(lidAmount(D("-12.34"))).toBe("-00000000001234");
        expect(lidAmount(D("0"))).toBe("000000000000000");
        expect(() => lidAmount(D("10000000000000.00"))).toThrow(ExportFormatError);
        expect(lidText("Comillas “tipográficas” – guion", 40)).toBe('Comillas "tipográficas" - guion         ');
        expect(() => lidText("Emoji 😀", 30)).toThrow(ExportFormatError);
    });
});

/** Parser CSV de la prueba (independiente del escritor). */
function parseCsv(b: Uint8Array): string[][] {
    const text = Buffer.from(b).toString("latin1");
    expect(text.endsWith("\r\n")).toBe(false);
    return text.split("\r\n").map((l) => l.split(";"));
}

describe("IVA Simple: apertura de otros conceptos", () => {
    const invoices = sampleInvoices();
    const { files, totals } = writeIvaSimpleFiles(invoices);

    it("encabezados como las plantillas de IVA Simple y cantidad completa de campos en cada registro", () => {
        const df = parseCsv(byName(files, IVA_SIMPLE_FILE_NAMES.DEBIT));
        expect(df[0].join(";")).toBe('"Actividad";"Tipo de Operacion";"Tipo de sujeto comprador";"Codigo de Alicuota";"Monto Neto Gravado";"Debito Fiscal Facturado";"Debito Fiscal O.D.P.";"Monto Neto Exento o No Gravado"');
        expect(df.every((r) => r.length === 8)).toBe(true);
        const rdf = parseCsv(byName(files, IVA_SIMPLE_FILE_NAMES.DEBIT_RESTITUTION));
        expect(rdf[0].join(";")).toBe('"Actividad";"Tipo de Operacion";"Tipo de sujeto comprador";"Codigo de Alicuota";"Monto Neto Gravado";"Debito Fiscal a Restituir";"Monto Neto Exento o No Gravado"');
        expect(rdf.every((r) => r.length === 7)).toBe(true);
        const cf = parseCsv(byName(files, IVA_SIMPLE_FILE_NAMES.CREDIT));
        expect(cf[0].join(";")).toBe('"Concepto";"Codigo de Alicuota";"Monto Neto Gravado";"Credito Fiscal Facturado";"Credito Fiscal Computable"');
        expect(cf.every((r) => r.length === 5)).toBe(true);
        const rcf = parseCsv(byName(files, IVA_SIMPLE_FILE_NAMES.CREDIT_RESTITUTION));
        expect(rcf[0].join(";")).toBe('"Concepto";"Codigo de Alicuota";"Monto Neto Gravado";"Credito Fiscal Facturado"');
        expect(rcf.every((r) => r.length === 4)).toBe(true);
    });

    it("débito: agrupado por actividad, tipo, sujeto y alícuota; O.D.P. sólo para la dación en pago; exentas en tipo 3; sin exportaciones", () => {
        const df = parseCsv(byName(files, IVA_SIMPLE_FILE_NAMES.DEBIT)).slice(1);
        expect(df).toEqual([
            ["620100", "1", "1", "4", "200,00", "21,00", "", ""],
            ["620100", "1", "1", "5", "1000,00", "210,00", "", ""],
            ["620100", "1", "2", "5", "100,00", "21,00", "21,00", ""],
            ["620100", "1", "3", "5", "500,00", "105,00", "", ""],
            ["620100", "3", "", "", "", "", "", "300,00"],
        ]);
        expect(totals.exportsTotal.toFixed(2)).toBe("800.00");
    });

    it("restitución de débito con las notas de crédito emitidas (importes positivos)", () => {
        expect(parseCsv(byName(files, IVA_SIMPLE_FILE_NAMES.DEBIT_RESTITUTION)).slice(1)).toEqual([["620100", "1", "1", "5", "100,00", "21,00", ""]]);
    });

    it("crédito por concepto y alícuota con el computable; restitución con las notas de crédito recibidas; las C no integran", () => {
        expect(parseCsv(byName(files, IVA_SIMPLE_FILE_NAMES.CREDIT)).slice(1)).toEqual([
            ["1", "5", "400,00", "84,00", "84,00"],
            ["3", "4", "100,00", "10,50", "10,50"],
            ["3", "5", "50,00", "10,50", "10,50"],
        ]);
        expect(parseCsv(byName(files, IVA_SIMPLE_FILE_NAMES.CREDIT_RESTITUTION)).slice(1)).toEqual([["1", "5", "40,00", "8,40"]]);
    });

    it("conciliación con el MISMO motor de la pantalla: débito y crédito por compras", () => {
        const liq = computeLiquidation({ invoices: invoices.map(toCalc), taxRecords: [], client: { defaultIibbRate: D(3) } });
        expect(totals.debitVat.minus(totals.debitRestitutionVat).toFixed(2)).toBe(liq.iva.debit.toFixed(2));
        expect(totals.creditComputable.minus(totals.creditRestitutionVat).toFixed(2)).toBe(liq.iva.creditPurchases.toFixed(2));
    });

    it("no inventa datos: sin actividad, tipo o sujeto, no genera el archivo", () => {
        const bad = sampleInvoices();
        bad[0].activityCode = null;
        expect(() => writeIvaSimpleFiles(bad)).toThrow(ExportFormatError);
        const noBuyer = sampleInvoices();
        noBuyer[0].counterpartyVatConditionCode = 7; // no categorizado: no se deriva
        expect(() => writeIvaSimpleFiles(noBuyer)).toThrow(/sujeto/);
        const prorr = sampleInvoices();
        prorr[6].vatLines = [line(5, "400.00", "84.00", "GLOBAL_PRORATION")];
        expect(() => writeIvaSimpleFiles(prorr)).toThrow(/prorrateo/);
    });

    it("importes con coma decimal, sin separador de miles y hasta 13 enteros", () => {
        expect(csvAmount(D("1234567.5"), 13)).toBe("1234567,50");
        expect(() => csvAmount(D("12345678901234"), 13)).toThrow(ExportFormatError);
        expect(() => csvAmount(D("-1"), 13)).toThrow(ExportFormatError);
    });
});

describe("Clasificación: derivación literal y controles", () => {
    it("tipo de sujeto derivado sólo de condiciones con correspondencia literal", () => {
        expect(buyerTypeFromVatCondition(1)).toBe("RESPONSABLE_INSCRIPTO");
        expect(buyerTypeFromVatCondition(6)).toBe("MONOTRIBUTO");
        expect(buyerTypeFromVatCondition(5)).toBe("CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO");
        for (const c of [7, 8, 9, 10, null]) expect(buyerTypeFromVatCondition(c)).toBeNull();
    });

    it("bloqueos de exportación: actividad, tipo, sujeto, concepto y código de operación faltantes", () => {
        seq = 100;
        const s = inv({ category: "SALES", voucherCode: 1, activityCode: null, saleOperationType: null, vatLines: [line(5, "10.00", "2.10")] });
        expect(invoiceIssues(s, SETTINGS).map((i) => [i.level, i.code])).toEqual([
            ["EXPORT", "SALE_ACTIVITY_MISSING"], ["EXPORT", "SALE_OPERATION_TYPE_MISSING"], ["EXPORT", "SALE_BUYER_TYPE_MISSING"],
        ]);
        const p = inv({ category: "PURCHASES", voucherCode: 1, purchaseCreditConcept: null, vatLines: [line(3, "10.00", "0.00", "DIRECT_COMPUTABLE", "0.00")] });
        expect(invoiceIssues(p, SETTINGS).map((i) => i.code)).toEqual(["OPERATION_CODE_MISSING", "PURCHASE_CONCEPT_MISSING"]);
    });

    it("percepción del comprobante sin registrar: advertencia (no se computa ni se duplica)", () => {
        const invoices = sampleInvoices();
        const issues = periodExportIssues(invoices, [], SETTINGS);
        expect(issues.filter((i) => i.code === "INVOICE_PERCEPTIONS_NOT_REGISTERED")).toHaveLength(1);
        const linked: ExportTaxRecord = { id: "t1", date: "2027-01-15", type: "PERCEPCION IVA", amount: D("12.00"), nature: "PERCEPTION", taxCode: null, regimeCode: 493, agentCuit: CUIT_A, intermediaryCuit: null, voucherTypeCode: 1, voucherNumber: "00003-00000007", certificateNumber: null, customsDocument: null, invoiceId: invoices[6].id };
        expect(periodExportIssues(invoices, [linked], SETTINGS).filter((i) => i.code === "INVOICE_PERCEPTIONS_NOT_REGISTERED")).toHaveLength(0);
    });
});

describe("F.2051: retenciones, percepciones y percepciones aduaneras", () => {
    const base = { taxCode: null, regimeCode: null, agentCuit: null, intermediaryCuit: null, voucherTypeCode: null, voucherNumber: null, certificateNumber: null, customsDocument: null, invoiceId: null };
    const records: ExportTaxRecord[] = [
        { ...base, id: "r1", date: "2027-01-10", type: "RETENCION IVA", amount: D("1500.5"), nature: "RETENTION", taxCode: 767, regimeCode: 830, agentCuit: CUIT_AGENT, voucherTypeCode: 6, voucherNumber: "000012345678", certificateNumber: "0001-00001234" },
        { ...base, id: "p1", date: "2027-01-12", type: "PERCEPCION IVA", amount: D("200"), nature: "PERCEPTION", regimeCode: 493, agentCuit: CUIT_AGENT, voucherTypeCode: 1, voucherNumber: "00003-00000007" },
        { ...base, id: "c1", date: "2027-01-20", type: "PERCEPCION IVA", amount: D("-50"), nature: "CUSTOMS_PERCEPTION", regimeCode: 1, customsDocument: "27-001-IC04-123456-K" },
        { ...base, id: "i1", date: "2027-01-20", type: "RETENCION IIBB", amount: D("99"), nature: null },
    ];
    it("columnas y formatos del diseño, sin encabezado; IIBB fuera", () => {
        const { files, totals } = writeF2051Files(records);
        expect(Buffer.from(byName(files, F2051_FILE_NAMES.RETENTIONS)).toString("latin1")).toBe(`767;830;${CUIT_AGENT};;2027-01-10;6;000012345678;0001-00001234;1500,50`);
        expect(Buffer.from(byName(files, F2051_FILE_NAMES.PERCEPTIONS)).toString("latin1")).toBe(`493;${CUIT_AGENT};;2027-01-12;1;00003-00000007;200,00`);
        expect(Buffer.from(byName(files, F2051_FILE_NAMES.CUSTOMS)).toString("latin1")).toBe("1;2027-01-20;27-001-IC04-123456-K;-50,00");
        expect(totals.retentions.plus(totals.perceptions).plus(totals.customs).toFixed(2)).toBe("1650.50");
    });
    it("datos faltantes o inválidos: no genera", () => {
        expect(() => writeF2051Files([{ ...records[0], certificateNumber: null }])).toThrow(ExportFormatError);
        expect(() => writeF2051Files([{ ...records[2], customsDocument: "27-001-IC04-123456-O" }])).toThrow(/despacho/);
        expect(() => writeF2051Files([{ ...records[1], amount: D("0") }])).toThrow(ExportFormatError);
    });
});

/** Lector ZIP de la prueba (independiente del escritor; CRC con node:zlib). */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let eocd = zip.length - 22;
    while (v.getUint32(eocd, true) !== 0x06054b50) eocd--;
    const n = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const out = new Map<string, Uint8Array>();
    for (let k = 0; k < n; k++) {
        expect(v.getUint32(p, true)).toBe(0x02014b50);
        const crc = v.getUint32(p + 16, true), cs = v.getUint32(p + 20, true), us = v.getUint32(p + 24, true), nl = v.getUint16(p + 28, true), off = v.getUint32(p + 42, true);
        const name = Buffer.from(zip.subarray(p + 46, p + 46 + nl)).toString("latin1");
        const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
        const data = new Uint8Array(inflateRawSync(zip.subarray(start, start + cs)));
        expect(data.length).toBe(us);
        expect(nodeCrc32(data)).toBe(crc);
        out.set(name, data);
        p += 46 + nl;
    }
    return out;
}

describe("Paquete de presentación (ZIP)", () => {
    const invoices = sampleInvoices();
    const ready = invoices.map((i) => (i.id === invoices[6].id ? i : i));
    const record: ExportTaxRecord = { id: "p1", date: "2027-01-15", type: "PERCEPCION IVA", amount: D("12.00"), nature: "PERCEPTION", taxCode: null, regimeCode: 493, agentCuit: CUIT_A, intermediaryCuit: null, voucherTypeCode: 1, voucherNumber: "00003-00000007", certificateNumber: null, customsDocument: null, invoiceId: invoices[6].id };
    const liquidation = computeLiquidation({ invoices: ready.map(toCalc), taxRecords: [{ type: "PERCEPCION IVA", amount: D("12.00"), nature: "PERCEPTION" }], client: { defaultIibbRate: D(3) } });
    const input = {
        mode: "FINAL" as const,
        identity: { clientName: "CLIENTE SINTETICO SA", clientCuit: "30-71111111-1", month: 1, year: 2027 },
        version: 2,
        generatedAt: new Date("2027-02-10T15:00:00.000Z"),
        contentHash: "a".repeat(64),
        settings: { ...SETTINGS, previousTechnicalBalanceReference: null, previousFreeBalanceReference: null },
        adjustments: [{ regime: "LEY_27541_ANEXO_I", contributionsAmount: D("1000"), computableAmount: D("73"), reference: "F.931 01/2027" }],
        liquidation,
        invoices: ready,
        taxRecords: [record],
    };

    it("final: archivos ARCA + resumen + conceptos + LEEME; conciliación OK; huellas correctas", () => {
        const pkg = buildPackage(input);
        expect(pkg.fileName).toBe("IVA_30711111111_202701_v2.zip");
        const entries = readZip(pkg.zip);
        expect([...entries.keys()]).toEqual([...pkg.files.map((f) => f.name), "RESUMEN.txt", "CONCEPTOS_A_CARGAR_EN_ARCA.txt", "LEEME.txt"]);
        for (const f of pkg.files) expect(createHash("sha256").update(entries.get(f.name)!).digest("hex")).toBe(f.sha256);
        expect(pkg.reconciliation.every((r) => r.ok)).toBe(true);
        const resumen = Buffer.from(entries.get("RESUMEN.txt")!).toString("utf8");
        expect(resumen).toContain("versión 2");
        expect(resumen).not.toContain("BORRADOR");
        const manual = Buffer.from(entries.get("CONCEPTOS_A_CARGAR_EN_ARCA.txt")!).toString("utf8");
        expect(manual).toContain("Anexo I Ley 27.541: crédito fiscal 1.000,00 · computable 73,00 (ref. F.931 01/2027)");
        expect(manual).toContain("Total de comprobantes de exportación: 800,00");
    });

    it("determinista: el mismo contenido produce los mismos bytes", () => {
        expect(Buffer.from(buildPackage(input).zip).equals(Buffer.from(buildPackage(input).zip))).toBe(true);
    });

    it("final con bloqueos: no se genera; borrador: se genera identificado y lista lo omitido", () => {
        const blocked = { ...input, invoices: input.invoices.map((i, k) => (k === 0 ? { ...i, activityCode: null } : i)) };
        expect(() => buildPackage(blocked)).toThrow(ExportFormatError);
        const draft = buildPackage({ ...blocked, mode: "DRAFT", version: null });
        expect(draft.fileName).toBe("BORRADOR_IVA_30711111111_202701.zip");
        const entries = readZip(draft.zip);
        expect(entries.has("BORRADOR_RESUMEN.txt")).toBe(true);
        expect(Buffer.from(entries.get("BORRADOR_RESUMEN.txt")!).toString("utf8")).toMatch(/^﻿BORRADOR — NO PRESENTAR/);
        expect(draft.omitted.some((o) => o.name === "IVA_SIMPLE_*.csv")).toBe(true);
        expect(entries.has(LID_FILE_NAMES.SALES_GENERAL_VOUCHERS)).toBe(true);
    });

    it("ZIP: nombres seguros y sin repetidos", () => {
        expect(() => writeZip([{ name: "../x.txt", data: new Uint8Array() }], new Date())).toThrow();
        expect(() => writeZip([{ name: "a.txt", data: new Uint8Array() }, { name: "a.txt", data: new Uint8Array() }], new Date())).toThrow();
    });
});

describe("Huella del contenido (versiones cerradas)", () => {
    // Import dinámico: load.ts usa el cliente Prisma sólo en tipos.
    const base = () => {
        const invoices = sampleInvoices();
        return {
            period: { id: "per1", clientId: "c1", month: 1, year: 2027, status: "OPEN", updatedAt: new Date(0) },
            settings: { creditProrationMode: "NONE", turivaIncluded: false, globalCoefficient: null, previousTechnicalBalance: D(0), previousTechnicalBalanceReference: null, previousFreeBalance: D(0), previousFreeBalanceReference: null },
            adjustments: [],
            invoices,
            taxRecords: [] as ExportTaxRecord[],
        };
    };
    it("v1: campos explícitos; un campo nuevo del cargador no la cambia; un cambio real sí; v0 se conserva para versiones viejas", async () => {
        const { contentHash, contentHashFor, contentHashV0, CONTENT_HASH_SCHEME } = await import("@/lib/vat-export/load");
        const d = base();
        const h = contentHash(d);
        expect(CONTENT_HASH_SCHEME).toBe("v1");
        const withExtra = { ...d, invoices: d.invoices.map((i) => ({ ...i, campoFuturo: "x" }) as unknown as ExportInvoice) };
        expect(contentHash(withExtra)).toBe(h);
        const changed = { ...d, invoices: d.invoices.map((i, k) => (k === 0 ? { ...i, activityCode: "620101" } : i)) };
        expect(contentHash(changed)).not.toBe(h);
        const lineChanged = { ...d, invoices: d.invoices.map((i, k) => (k === 0 ? { ...i, vatLines: [{ ...i.vatLines[0], vatAmount: D("210.01") }, ...i.vatLines.slice(1)] } : i)) };
        expect(contentHash(lineChanged)).not.toBe(h);
        expect(contentHashFor("v1", d)).toBe(h);
        expect(contentHashFor(undefined, d)).toBe(contentHashV0(d));
        expect(contentHashFor("v9", d)).toBeNull();
    });
});
