import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { parseLidFile, RECORD_LENGTH } from "@/lib/libro-iva-import/format";
import { buildImportPreview, voucherKey, type PreviewContext, type SectionTotals } from "@/lib/libro-iva-import/build";
import { parseImportRequest, MAX_FILE_BYTES } from "@/lib/libro-iva-import/request";
import { SOURCE_LID_DISENO_REGISTROS } from "@/lib/arca/catalogs";
import {
    ansiFile, amt, cuit, purchaseAliquotLine, purchaseVoucherLine, salesAliquotLine, salesVoucherLine,
    type SynthAliquot, type SynthVoucher,
} from "./helpers/libro-iva-synth";

// Datos SINTÉTICOS. CUIT ficticios con dígito verificador válido.
const BUYER = cuit("2070000003");
const SELLER = cuit("3071111111");
const SELLER2 = cuit("3072222222");
const PERIOD = { month: 10, year: 2026 };
const ctx = (over: Partial<PreviewContext> = {}): PreviewContext => ({
    category: "SALES",
    period: PERIOD,
    settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: false },
    existingKeys: new Set(),
    ...over,
});
const sale = (over: Partial<SynthVoucher> = {}): SynthVoucher => ({
    date: "20261015", code: 1, pos: 3, number: 101, doc: BUYER, name: "CLIENTE SINTETICO SA", total: "1210.00", aliquotCount: 1, ...over,
});
const purchase = (over: Partial<SynthVoucher> = {}): SynthVoucher => ({
    date: "20261005", code: 1, pos: 7, number: 5001, doc: SELLER, name: "PROVEEDOR SINTETICO SRL", total: "1210.00", aliquotCount: 1, computableCredit: "210.00", ...over,
});
const sAli = (over: Partial<SynthAliquot> = {}): SynthAliquot => ({ code: 1, pos: 3, number: 101, net: "1000.00", rate: 5, vat: "210.00", ...over });
const pAli = (over: Partial<SynthAliquot> = {}): SynthAliquot => ({ code: 1, pos: 7, number: 5001, doc: SELLER, net: "1000.00", rate: 5, vat: "210.00", ...over });

function salesPreview(vouchers: SynthVoucher[], aliquots: SynthAliquot[], c = ctx(), turiva = false) {
    return buildImportPreview(
        c,
        parseLidFile(ansiFile(vouchers.map((v) => salesVoucherLine(v, turiva))), "SALES", "VOUCHERS"),
        parseLidFile(ansiFile(aliquots.map(salesAliquotLine)), "SALES", "ALIQUOTS"),
    );
}
function purchasesPreview(vouchers: SynthVoucher[], aliquots: SynthAliquot[], c = ctx({ category: "PURCHASES" }), turiva = false) {
    return buildImportPreview(
        c,
        parseLidFile(ansiFile(vouchers.map((v) => purchaseVoucherLine(v, turiva))), "PURCHASES", "VOUCHERS"),
        parseLidFile(ansiFile(aliquots.map(purchaseAliquotLine)), "PURCHASES", "ALIQUOTS"),
    );
}
const money = (d: Prisma.Decimal) => d.toFixed(2);

describe("formato oficial del Libro IVA Digital (Anexo I – Diseños de Registros)", () => {
    it("cita la fuente oficial y fija las longitudes de registro del diseño", () => {
        expect(SOURCE_LID_DISENO_REGISTROS.url).toMatch(/^https:\/\/www\.afip\.gob\.ar\/iva\/documentos\/libro-iva-digital-diseno-registros\.pdf$/);
        expect(RECORD_LENGTH).toEqual({ SALES_VOUCHERS: 266, SALES_TURIVA_VOUCHERS: 281, SALES_ALIQUOTS: 62, PURCHASES_VOUCHERS: 325, PURCHASES_TURIVA_VOUCHERS: 340, PURCHASES_ALIQUOTS: 84 });
    });
    it("lee cada campo de su posición: venta escrita a mano, sin el generador", () => {
        const line =
            "20261015" + "001" + "00003" + "00000000000000000101" + "00000000000000000101" + "80" + BUYER.padStart(20, "0") +
            "CLIENTE SINTETICO SA".padEnd(30) + "000000000121000" + "0".repeat(15) + "0".repeat(15) + "000000000005000" + "0".repeat(15 * 4) +
            "PES" + "0001000000" + "1" + " " + "0".repeat(15) + "00000000";
        expect(line.length).toBe(266);
        const f = parseLidFile(ansiFile([line]), "SALES", "VOUCHERS");
        expect(f.issues).toEqual([]);
        const v = f.records[0].values;
        expect([v.date, v.voucherCode, v.pointOfSale, v.number, v.docType, (v.name as string).trim()]).toEqual(["20261015", "001", "00003", "00000000000000000101", "80", "CLIENTE SINTETICO SA"]);
        expect((v.total as Prisma.Decimal).toFixed(2)).toBe("1210.00");
        expect((v.exempt as Prisma.Decimal).toFixed(2)).toBe("50.00");
        expect((v.exchangeRate as Prisma.Decimal).toString()).toBe("1");
    });
    it("importes negativos con '-' en la primera posición, CRLF o LF, y nombre con 'Ñ' en un byte", () => {
        expect(amt("-12.34")).toBe("-00000000001234");
        const line = salesVoucherLine(sale({ name: "PEÑA SINTETICA", total: "-12.34" }));
        for (const eol of ["\r\n", "\n"]) {
            const f = parseLidFile(ansiFile([line], eol), "SALES", "VOUCHERS");
            expect(f.issues).toEqual([]);
            expect((f.records[0].values.total as Prisma.Decimal).toFixed(2)).toBe("-12.34");
            expect((f.records[0].values.name as string).trim()).toBe("PEÑA SINTETICA");
        }
    });
    it("rechaza longitudes ajenas (otro libro o UTF-8), dígitos inválidos y fechas inexistentes", () => {
        const ok = salesVoucherLine(sale());
        const utf8 = new TextEncoder().encode(salesVoucherLine(sale({ name: "PEÑA" })));
        expect(parseLidFile(utf8, "SALES", "VOUCHERS").issues[0].message).toMatch(/longitud 267.*ANSI/);
        expect(parseLidFile(ansiFile([ok]), "PURCHASES", "VOUCHERS").issues[0].message).toMatch(/se esperaba 325 o 340/);
        expect(parseLidFile(ansiFile([ok.slice(0, 9) + "0A1" + ok.slice(12)]), "SALES", "VOUCHERS").issues[0].field).toBe("voucherCode");
        expect(parseLidFile(ansiFile(["20260231" + ok.slice(8)]), "SALES", "VOUCHERS").issues[0].field).toBe("date");
        const mixed = parseLidFile(ansiFile([ok, salesVoucherLine(sale({ number: 102 }), true)]), "SALES", "VOUCHERS");
        expect(mixed.issues[0].message).toMatch(/mezcla/);
    });
});

describe("vista previa: vínculo comprobante–alícuotas, errores por fila y conciliación", () => {
    it("venta A con una alícuota: OK, débito y totales", () => {
        const p = salesPreview([sale()], [sAli()]);
        expect(p.fileErrors).toEqual([]);
        expect(p.rows.map((r) => r.status)).toEqual(["OK"]);
        const t = p.reconciliation.importable.CONSOLIDATED;
        expect([money(t.taxedNet), money(t.vat), money(t.total), t.count]).toEqual(["1000.00", "210.00", "1210.00", 1]);
        expect(p.rows[0].model?.grossIncomeTaxBaseAmount?.toFixed(2)).toBe("1000.00");
    });
    it("compra con varias alícuotas (21 % y 10,5 %): dos líneas, crédito y totales por alícuota", () => {
        // Total de cabecera que no cierra con las dos alícuotas (1000+210+1000+105 = 2315): REVIEW.
        const p = purchasesPreview([purchase({ total: "1316.00", aliquotCount: 2, computableCredit: "315.00" })], [pAli(), pAli({ rate: 4, vat: "105.00" })]);
        expect(p.rows[0].status).toBe("REVIEW");
        expect(p.rows[0].messages.join(" ")).toMatch(/no coincide con la suma de sus componentes 2315\.00/);
        const okV = purchase({ total: "2315.00", aliquotCount: 2, computableCredit: "315.00" });
        const q = purchasesPreview([okV], [pAli(), pAli({ rate: 4, vat: "105.00" })]);
        expect(q.rows[0].status).toBe("OK");
        expect(q.rows[0].aliquotLines).toEqual([1, 2]);
        expect(q.rows[0].model?.vatLines.map((l) => [l.vatRateCode, money(l.netAmount), money(l.vatAmount), l.creditAllocation])).toEqual([
            [5, "1000.00", "210.00", "DIRECT_COMPUTABLE"],
            [4, "1000.00", "105.00", "DIRECT_COMPUTABLE"],
        ]);
        expect(money(q.reconciliation.importable.CONSOLIDATED.computableCredit)).toBe("315.00");
        expect(Object.fromEntries(Object.entries(q.reconciliation.byRate).map(([k, x]) => [k, [money(x.net), money(x.vat)]]))).toEqual({ "0005": ["1000.00", "210.00"], "0004": ["1000.00", "105.00"] });
    });
    it("fila inválida (dígito verificador) queda en ERROR y no impide leer las demás", () => {
        const bad = sale({ number: 102, doc: BUYER.slice(0, 10) + String((Number(BUYER[10]) + 1) % 10) });
        const p = salesPreview([sale(), bad], [sAli(), sAli({ number: 102 })]);
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "ERROR"]);
        expect(p.rows[1].messages.join(" ")).toMatch(/dígito verificador/);
        expect(p.rows[1].model).toBeNull();
        expect(p.reconciliation.statusCounts).toEqual({ OK: 1, DUPLICATE: 0, REVIEW: 0, ERROR: 1 });
        expect(p.reconciliation.importable.CONSOLIDATED.count).toBe(1);
    });
    it("cantidad de alícuotas declarada distinta de las encontradas: ERROR; alícuota sin comprobante: error de archivo", () => {
        const p = salesPreview([sale({ aliquotCount: 2 })], [sAli(), sAli({ number: 999 })]);
        expect(p.rows[0].status).toBe("ERROR");
        expect(p.rows[0].messages.join(" ")).toMatch(/declarada 2 y encontradas 1/);
        expect(p.fileErrors[0]).toMatch(/1 alícuota\(s\) sin comprobante/);
    });
    it("total que no cierra y IVA que no corresponde a la alícuota: REVIEW con el detalle", () => {
        const p = salesPreview([sale({ total: "1211.00" }), sale({ number: 102, total: "1215.00" })], [sAli(), sAli({ number: 102, vat: "215.00" })]);
        expect(p.rows[0].status).toBe("REVIEW");
        expect(p.rows[0].messages.join(" ")).toMatch(/diferencia 1\.00/);
        expect(p.rows[1].status).toBe("REVIEW");
        expect(p.rows[1].messages.join(" ")).toMatch(/IVA informado 215\.00 y calculado 210\.00/);
    });
    it("nota de crédito resta en la conciliación (signo por código oficial)", () => {
        const p = salesPreview([sale(), sale({ code: 3, number: 7, total: "121.00" })], [sAli(), sAli({ code: 3, number: 7, net: "100.00", vat: "21.00" })]);
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "OK"]);
        expect(money(p.reconciliation.importable.CONSOLIDATED.vat)).toBe("189.00");
        expect(p.rows[1].model?.totalVatAmount.toFixed(2)).toBe("21.00");
    });
    it("compra B sin alícuotas: neto sin discriminación, sin crédito", () => {
        const p = purchasesPreview([purchase({ code: 6, aliquotCount: 0, computableCredit: "0", total: "500.00", exempt: "20.00" })], []);
        expect(p.rows[0].status).toBe("OK");
        const m = p.rows[0].model!;
        expect([money(m.netWithoutVatBreakdownAmount), money(m.exemptAmount), money(m.directComputableVatCreditAmount), m.vatLines.length]).toEqual(["480.00", "20.00", "0.00", 0]);
    });
    it("fechas: venta fuera del período es ERROR; compra de un período anterior advierte", () => {
        const p = salesPreview([sale({ date: "20260930" })], [sAli()]);
        expect(p.rows[0].status).toBe("ERROR");
        const q = purchasesPreview([purchase({ date: "20260920" })], [pAli()]);
        expect(q.rows[0].status).toBe("OK");
        expect(q.rows[0].warnings[0].code).toBe("PURCHASE_PRIOR_PERIOD");
    });
    it("duplicados: repetido en el archivo es ERROR; ya cargado es DUPLICATE y no suma", () => {
        const p = salesPreview([sale(), sale()], [sAli()]);
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "ERROR"]);
        const key = voucherKey({ category: "SALES", voucherCode: 1, pointOfSale: 3, number: 101, counterpartyDocType: 80, counterpartyDocNumber: BUYER });
        const q = salesPreview([sale()], [sAli()], ctx({ existingKeys: new Set([key]) }));
        expect(q.rows[0].status).toBe("DUPLICATE");
        expect(q.reconciliation.importable.CONSOLIDATED.count).toBe(0);
        // Compras: la clave incluye el documento del vendedor (dos vendedores, mismo número).
        const r = purchasesPreview([purchase(), purchase({ doc: SELLER2 })], [pAli(), pAli({ doc: SELLER2 })]);
        expect(r.rows.map((x) => x.status)).toEqual(["OK", "OK"]);
    });
    it("datos faltantes o ambiguos quedan para revisión: código no admitido, moneda extranjera, rango agrupado, despacho", () => {
        const p = salesPreview([sale({ code: 81, number: 1, aliquotCount: 1 }), sale({ number: 2, currency: "DOL", exchangeRate: "1000000000" }), sale({ number: 3, numberTo: 9 })],
            [sAli({ code: 81, number: 1 }), sAli({ number: 2 }), sAli({ number: 3 })]);
        expect(p.rows.map((r) => r.status)).toEqual(["REVIEW", "REVIEW", "REVIEW"]);
        expect(p.rows[0].messages[0]).toMatch(/081 no admitido/);
        const q = purchasesPreview([purchase({ customsDispatch: "26001IC04000001A" })], [pAli()]);
        expect(q.rows[0].status).toBe("REVIEW");
    });
    it("crédito computable según la modalidad del período", () => {
        const none = purchasesPreview([purchase({ computableCredit: "100.00" })], [pAli()]);
        expect(none.rows[0].status).toBe("REVIEW");
        const direct = ctx({ category: "PURCHASES", settings: { creditProrationMode: "DIRECT", globalCoefficient: null } });
        const one = purchasesPreview([purchase({ computableCredit: "100.00" })], [pAli()], direct);
        expect(one.rows[0].status).toBe("OK");
        expect([money(one.rows[0].model!.directComputableVatCreditAmount), one.rows[0].model!.vatLines[0].computableOverridden]).toEqual(["100.00", true]);
        const two = purchasesPreview([purchase({ total: "2315.00", aliquotCount: 2, computableCredit: "100.00" })], [pAli(), pAli({ rate: 4, vat: "105.00" })], direct);
        expect(two.rows[0].status).toBe("REVIEW");
        const global = purchasesPreview([purchase()], [pAli()], ctx({ category: "PURCHASES", settings: { creditProrationMode: "GLOBAL", globalCoefficient: new Prisma.Decimal("0.5") } }));
        expect(global.rows[0].status).toBe("REVIEW");
        const over = purchasesPreview([purchase({ computableCredit: "300.00" })], [pAli()]);
        expect(over.rows[0].status).toBe("ERROR");
    });
});

describe("total sin signo frente a total con signo (piloto: notas de crédito)", () => {
    it("ventas: FC A, FC A exenta anulada por NC A exenta y FC B; la diferencia es 2 × notas de crédito", () => {
        const p = salesPreview(
            [
                sale(),
                sale({ number: 102, total: "500.00", exempt: "500.00", operationCode: "E" }),
                sale({ code: 3, number: 7, total: "500.00", exempt: "500.00", operationCode: "E" }),
                sale({ code: 6, number: 30, docType: 99, doc: "0", name: "CONSUMIDOR FINAL", total: "121.00" }),
            ],
            [sAli(), sAli({ number: 102, net: "0", rate: 3, vat: "0" }), sAli({ code: 3, number: 7, net: "0", rate: 3, vat: "0" }), sAli({ code: 6, number: 30, net: "100.00", vat: "21.00" })],
        );
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "OK", "OK", "OK"]);
        const r = p.reconciliation;
        expect(money(r.informed.voucherTotal)).toBe("2331.00");
        expect(money(r.importable.CONSOLIDATED.total)).toBe("1331.00");
        expect(money(r.importable.CONSOLIDATED.exempt)).toBe("0.00");
        expect(money(r.importable.CONSOLIDATED.vat)).toBe("231.00");
        expect(r.byVoucherType.map((t) => [t.voucherCode, t.sign, t.rows, money(t.informedTotal), money(t.signedTotal)])).toEqual([
            [1, 1, 2, "1710.00", "1710.00"],
            [3, -1, 1, "500.00", "-500.00"],
            [6, 1, 1, "121.00", "121.00"],
        ]);
        const b = r.signBridge;
        expect([money(b.unsignedTotal), money(b.creditNotesTotal), b.creditNotesCount, money(b.signedTotal)]).toEqual(["2331.00", "500.00", 1, "1331.00"]);
        expect(b.unsignedTotal.minus(b.creditNotesTotal.times(2)).equals(b.signedTotal)).toBe(true);
    });
    it("compras: NC B mayores que FC B dejan el neto sin discriminar negativo, sin crédito y con el puente exacto", () => {
        const p = purchasesPreview(
            [
                purchase(),
                purchase({ code: 6, number: 20, aliquotCount: 0, computableCredit: "0", total: "300.00" }),
                purchase({ code: 8, number: 21, aliquotCount: 0, computableCredit: "0", total: "350.00" }),
            ],
            [pAli()],
        );
        expect(p.rows.map((r) => r.status)).toEqual(["OK", "OK", "OK"]);
        const c = p.reconciliation.importable.CONSOLIDATED;
        expect([money(c.total), money(c.netWithoutVatBreakdown), money(c.computableCredit)]).toEqual(["1160.00", "-50.00", "210.00"]);
        const b = p.reconciliation.signBridge;
        expect([money(b.unsignedTotal), money(b.creditNotesTotal), money(b.signedTotal)]).toEqual(["1860.00", "350.00", "1160.00"]);
        expect(b.unsignedTotal.minus(b.creditNotesTotal.times(2)).equals(b.signedTotal)).toBe(true);
    });
});

describe("TurIVA (Ventas por TURIVA 281 / Compras por TURIVA 340)", () => {
    const tur = sale({ code: 195, number: 11, total: "1210.00", turivaRefund: "210.00", operationCode: " " });
    it("conserva pestaña TURIVA y reintegro Decreto 1043/2016, separado del total", () => {
        const p = salesPreview([tur], [sAli({ code: 195, number: 11 })], ctx({ settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: true } }), true);
        expect(p.turivaFile).toBe(true);
        expect(p.rows[0].status).toBe("OK");
        expect([p.rows[0].model!.lidSection, money(p.rows[0].model!.turivaRefundAmount), money(p.rows[0].model!.voucherTotalAmount)]).toEqual(["TURIVA", "210.00", "1210.00"]);
        const r = p.reconciliation.importable;
        expect([r.TURIVA.count, r.GENERAL.count, money(r.TURIVA.turivaRefund)]).toEqual([1, 0, "210.00"]);
    });
    it("período no incluido en el Régimen TurIVA, clase T en el archivo general o clase A en el de TurIVA: ERROR", () => {
        expect(salesPreview([tur], [sAli({ code: 195, number: 11 })], ctx(), true).rows[0].status).toBe("ERROR");
        const inc = ctx({ settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: true } });
        expect(salesPreview([tur], [sAli({ code: 195, number: 11 })], inc, false).rows[0].messages.join(" ")).toMatch(/van en el archivo de TurIVA/);
        expect(salesPreview([sale()], [sAli()], inc, true).rows[0].messages.join(" ")).toMatch(/sólo admite comprobantes clase T/);
    });
    it("compras TurIVA: 063 (liquidación) queda para revisión", () => {
        const inc = ctx({ category: "PURCHASES", settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: true } });
        const p = purchasesPreview([purchase({ code: 63, turivaRefund: "0" })], [pAli({ code: 63 })], inc, true);
        expect(p.rows[0].status).toBe("REVIEW");
    });
    it("los totales separados suman el consolidado", () => {
        const inc = ctx({ settings: { creditProrationMode: "NONE", globalCoefficient: null, turivaIncluded: true } });
        const p = salesPreview([tur, { ...tur, code: 197, number: 12, total: "121.00", turivaRefund: "21.00" }], [sAli({ code: 195, number: 11 }), sAli({ code: 197, number: 12, net: "100.00", vat: "21.00" })], inc, true);
        const { GENERAL, TURIVA, CONSOLIDATED } = p.reconciliation.importable;
        for (const k of Object.keys(CONSOLIDATED) as (keyof SectionTotals)[]) {
            const c = CONSOLIDATED[k], g = GENERAL[k], t = TURIVA[k];
            if (typeof c === "number") expect(c).toBe((g as number) + (t as number));
            else expect((c as Prisma.Decimal).equals((g as Prisma.Decimal).plus(t as Prisma.Decimal))).toBe(true);
        }
        expect(money(CONSOLIDATED.turivaRefund)).toBe("189.00");
    });
});

describe("solicitud: archivos en base64 y token", () => {
    const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
    const body = { clientId: "c1", category: "SALES", vouchersFile: b64(ansiFile([salesVoucherLine(sale())])), aliquotsFile: b64(ansiFile([salesAliquotLine(sAli())])) };
    it("acepta archivos válidos y exige el token sólo para confirmar", () => {
        expect(parseImportRequest(body, { requireToken: false }).ok).toBe(true);
        expect(parseImportRequest(body, { requireToken: true })).toMatchObject({ ok: false, field: "token" });
        expect(parseImportRequest({ ...body, token: "a".repeat(64) }, { requireToken: true }).ok).toBe(true);
    });
    it("rechaza categoría, base64 inválido, archivo vacío o demasiado grande y acceptPartial no booleano", () => {
        expect(parseImportRequest({ ...body, category: "OTRA" }, { requireToken: false })).toMatchObject({ ok: false, field: "category" });
        expect(parseImportRequest({ ...body, vouchersFile: "no*base64" }, { requireToken: false })).toMatchObject({ ok: false, field: "vouchersFile" });
        expect(parseImportRequest({ ...body, aliquotsFile: "" }, { requireToken: false })).toMatchObject({ ok: false, field: "aliquotsFile" });
        const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x30).toString("base64");
        expect(parseImportRequest({ ...body, vouchersFile: big }, { requireToken: false })).toMatchObject({ ok: false, error: expect.stringMatching(/2 MB/) });
        expect(parseImportRequest({ ...body, acceptPartial: "si" }, { requireToken: false })).toMatchObject({ ok: false, field: "acceptPartial" });
    });
});
