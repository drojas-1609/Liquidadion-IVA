import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { parseMisComprobantes } from "@/lib/libro-iva-import/mis-comprobantes-csv";
import { buildImportPreview } from "@/lib/libro-iva-import/build";
import { parsePerceptionsCsv } from "@/lib/tax-import/perceptions-csv";
import { buildPerceptionsPreview } from "@/lib/tax-import/service";
import { cuit } from "./helpers/libro-iva-synth";

/**
 * Lectores de las descargas de ARCA con muestras SINTÉTICAS que reproducen la
 * FORMA observada el 06/11/2026 (encabezados, separadores, codificación,
 * signos), nunca sus datos. Los encabezados se escriben acá a mano, de forma
 * independiente de las constantes del lector.
 */

const CLIENT = cuit("2070000003"), SELLER = cuit("3071111111"), BUYER = cuit("3070000001"), AGENT = cuit("3070000000");
const H_EMITIDOS = '"Fecha de Emisión";"Tipo de Comprobante";"Punto de Venta";"Número Desde";"Número Hasta";"Cód. Autorización";"Tipo Doc. Receptor";"Nro. Doc. Receptor";"Denominación Receptor";"Tipo Cambio";"Moneda";"Imp. Neto Gravado IVA 0%";"IVA 2,5%";"Imp. Neto Gravado IVA 2,5%";"IVA 5%";"Imp. Neto Gravado IVA 5%";"IVA 10,5%";"Imp. Neto Gravado IVA 10,5%";"IVA 21%";"Imp. Neto Gravado IVA 21%";"IVA 27%";"Imp. Neto Gravado IVA 27%";"Imp. Neto Gravado Total";"Imp. Neto No Gravado";"Imp. Op. Exentas";"Otros Tributos";"Total IVA";"Imp. Total"';
const H_RECIBIDOS = '"Fecha de Emisión";"Tipo de Comprobante";"Punto de Venta";"Número Desde";"Número Hasta";"Cód. Autorización";"Tipo Doc. Emisor";"Nro. Doc. Emisor";"Denominación Emisor";"Tipo Doc. Receptor";"Nro. Doc. Receptor";"Tipo Cambio";"Moneda";"Imp. Neto Gravado IVA 0%";"IVA 2,5%";"Imp. Neto Gravado IVA 2,5%";"IVA 5%";"Imp. Neto Gravado IVA 5%";"IVA 10,5%";"Imp. Neto Gravado IVA 10,5%";"IVA 21%";"Imp. Neto Gravado IVA 21%";"IVA 27%";"Imp. Neto Gravado IVA 27%";"Imp. Neto Gravado Total";"Imp. Neto No Gravado";"Imp. Op. Exentas";"Otros Tributos";"Total IVA";"Imp. Total"';
const rates = (r: { r21?: [string, string]; r105?: [string, string]; n0?: string }) =>
    [r.n0 ?? "", "", "", "", "", r.r105?.[1] ?? "", r.r105?.[0] ?? "", r.r21?.[1] ?? "", r.r21?.[0] ?? "", "", ""];
const emitido = (date: string, code: number, nro: number, total: string, r: Parameters<typeof rates>[0], extra: { name?: string; exempt?: string; netTotal: string; vat: string; otros?: string } ) =>
    [date, code, 4, nro, nro, "71234567890123", 80, BUYER, extra.name ?? "COMPRADOR SINTETICO SA", "1,00", "$", ...rates(r), extra.netTotal, "0,00", extra.exempt ?? "0,00", extra.otros ?? "0,00", extra.vat, total].join(";");
const recibido = (date: string, code: number, nro: number, total: string, r: Parameters<typeof rates>[0], extra: { receptor?: string; netTotal: string; vat: string; otros?: string }) =>
    [date, code, 7, nro, nro, "71234567890123", 80, SELLER, "PROVEEDOR SINTETICO SRL", 80, extra.receptor ?? CLIENT, "1,00", "$", ...rates(r), extra.netTotal, "0,00", "0,00", extra.otros ?? "0,00", extra.vat, total].join(";");
const utf8 = (lines: string[]) => new TextEncoder().encode(lines.join("\n") + "\n");
const CTX = { period: { month: 10, year: 2027 }, settings: { creditProrationMode: "NONE" as const, globalCoefficient: null, turivaIncluded: false }, existingKeys: new Set<string>(), source: "MIS_COMPROBANTES" as const };

/** ZIP de una entrada con deflate (forma de la descarga), armado en la prueba. */
function zipOne(name: string, data: Uint8Array): Uint8Array {
    const crc = (() => { let c = 0xffffffff; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; })();
    const comp = deflateRawSync(data); const nm = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nm.length, 28); cen.writeUInt32LE(0, 42);
    const cdOff = 30 + nm.length + comp.length; const cdLen = 46 + nm.length;
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdLen, 12); end.writeUInt32LE(cdOff, 16);
    return new Uint8Array(Buffer.concat([local, nm, comp, cen, nm, end]));
}

describe("Mis Comprobantes: lector de la consulta exportada como CSV", () => {
    const emitidos = utf8([
        H_EMITIDOS,
        emitido("2027-10-05", 1, 11, "2315,00", { r21: ["1000,00", "210,00"], r105: ["1000,00", "105,00"] }, { netTotal: "2000,00", vat: "315,00" }),
        emitido("2027-10-20", 3, 2, "121,00", { r21: ["100,00", "21,00"] }, { netTotal: "100,00", vat: "21,00" }),
        emitido("2027-10-22", 6, 30, "300,00", {}, { name: "", exempt: "300,00", netTotal: "0,00", vat: "0,00" }),
    ]);

    it("ventas: NC con importes POSITIVOS restan por el código (sin doble inversión); denominación vacía queda para revisar", () => {
        const p = parseMisComprobantes(zipOne("comprobantes_consulta_csv_emitidos_1_20700000033_20271106-1630 (montos expresados en pesos).csv", emitidos), "SALES", CLIENT);
        expect(p.fileErrors).toEqual([]);
        expect(p.innerName).toMatch(/emitidos/);
        const pv = buildImportPreview({ ...CTX, category: "SALES" }, p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.rowNotes });
        expect(pv.rows.map((r) => r.status)).toEqual(["OK", "OK", "REVIEW"]);
        expect(pv.rows[2].messages[0]).toMatch(/Mis Comprobantes no informa la denominación/);
        expect(pv.reconciliation.importable.CONSOLIDATED.vat.toFixed(2)).toBe("294.00");
        expect(pv.rows[0].model!.vatLines.map((l) => [l.vatRateCode, l.netAmount.toFixed(2), l.vatAmount.toFixed(2)])).toEqual([["4", "1000.00", "105.00"], ["5", "1000.00", "210.00"]].map(([c, n, v]) => [Number(c), n, v]));
        expect(pv.rows[0].model!.currencyCode).toBe("PES");
    });

    it("compras: el receptor debe ser el cliente; «Otros Tributos» queda como nota (no son percepciones computables)", () => {
        const recibidos = utf8([
            H_RECIBIDOS,
            recibido("2027-10-03", 1, 31, "1240,00", { r21: ["1000,00", "210,00"] }, { netTotal: "1000,00", vat: "210,00", otros: "30,00" }),
            recibido("2027-10-04", 1, 32, "121,00", { r21: ["100,00", "21,00"] }, { netTotal: "100,00", vat: "21,00", receptor: cuit("2033333333") }),
        ]);
        const p = parseMisComprobantes(recibidos, "PURCHASES", CLIENT);
        expect(p.vouchers.issues.map((i) => i.message)).toEqual(["el receptor del comprobante no es el cliente del período: la consulta es de otro contribuyente"]);
        expect(p.rowNotes.get(2)?.[0]).toMatch(/Otros Tributos/);
        const pv = buildImportPreview({ ...CTX, category: "PURCHASES" }, p.vouchers, p.aliquots, { fileErrors: p.fileErrors, rowNotes: p.rowNotes });
        expect(pv.rows.find((r) => r.line === 2)!.status).toBe("OK");
        const m = pv.rows.find((r) => r.line === 2)!.model!;
        expect([m.otherTaxesAmount.toFixed(2), m.vatPerceptionAmount.toFixed(2), m.directComputableVatCreditAmount.toFixed(2)]).toEqual(["30.00", "0.00", "210.00"]);
        expect(pv.rows.find((r) => r.line === 3)!.status).toBe("ERROR");
    });

    it("sin crédito computable en la consulta: con prorrateo queda para revisar (nunca se asume)", () => {
        const recibidos = utf8([H_RECIBIDOS, recibido("2027-10-03", 1, 31, "1210,00", { r21: ["1000,00", "210,00"] }, { netTotal: "1000,00", vat: "210,00" })]);
        const p = parseMisComprobantes(recibidos, "PURCHASES", CLIENT);
        const pv = buildImportPreview({ ...CTX, category: "PURCHASES", settings: { ...CTX.settings, creditProrationMode: "DIRECT" } }, p.vouchers, p.aliquots, {});
        expect(pv.rows[0].status).toBe("REVIEW");
        expect(pv.rows[0].messages.join()).toMatch(/no informa el crédito fiscal computable/);
    });

    it("encabezado: el otro libro se detecta; un encabezado distinto se rechaza; no-UTF-8 se rechaza", () => {
        expect(parseMisComprobantes(emitidos, "PURCHASES", CLIENT).fileErrors[0]).toMatch(/emitidos \(ventas\): elegí el libro correcto/);
        expect(parseMisComprobantes(utf8([H_EMITIDOS.replace("Moneda", "Divisa")]), "SALES", CLIENT).fileErrors[0]).toMatch(/encabezado no coincide/);
        expect(parseMisComprobantes(new Uint8Array([0xff, 0xfe, 0x41]), "SALES", CLIENT).fileErrors[0]).toMatch(/UTF-8/);
    });
});

describe("Percepciones de IVA: descarga de ARCA (forma observada, 8 campos, sin encabezado)", () => {
    const line = (o: Partial<{ regime: string; f2: string; agent: string; inter: string; date: string; type: string; nro: string; amount: string }> = {}) =>
        [o.regime ?? "493", o.f2 ?? "0", o.agent ?? AGENT, o.inter ?? "", o.date ?? "2027-10-15", o.type ?? "1", o.nro ?? "0007000000012345", o.amount ?? "1234.56"].join(";");
    const file = (lines: string[]) => new TextEncoder().encode(lines.join("\n") + "\n");

    it("lee la forma observada (punto decimal) y también la coma del diseño publicado", () => {
        const p = parsePerceptionsCsv(file([line(), line({ nro: "0007000000012346", amount: "10,50" })]));
        expect(p.fileErrors).toEqual([]);
        expect(p.rows.map((r) => [r.status, r.regimeCode, r.agentCuit, r.date, r.voucherTypeCode, r.voucherNumber, r.amount?.toFixed(2)])).toEqual([
            ["OK", 493, AGENT, "2027-10-15", 1, "0007000000012345", "1234.56"],
            ["OK", 493, AGENT, "2027-10-15", 1, "0007000000012346", "10.50"],
        ]);
    });

    it("no se infiere el campo 2 ni se aceptan datos inválidos", () => {
        const p = parsePerceptionsCsv(file([line({ f2: "1" }), line({ agent: AGENT.slice(0, 10) + String((Number(AGENT[10]) + 1) % 10) }), line({ amount: "1.234,56" }), line({ date: "2027-02-30" }), "493;0;" + AGENT + ";;2027-10-15;1;1"]));
        expect(p.rows.map((r) => r.status)).toEqual(["REVIEW", "ERROR", "ERROR", "ERROR", "ERROR"]);
        expect(p.rows[0].messages[0]).toMatch(/segundo campo/);
        expect(parsePerceptionsCsv(file(["Regimen;Cero;Cuit"])).fileErrors[0]).toMatch(/encabezado/);
    });

    it("vista previa: fecha fuera del período a revisar, ya registradas omitidas, repetidas en el archivo con error", () => {
        const f = file([line(), line({ date: "2027-09-30", nro: "0007000000000002" }), line({ nro: "0007000000000003" }), line({ nro: "0007000000000003" })]);
        const existing = new Set([`493|${AGENT}|1|0007000000012345`]);
        const pv = buildPerceptionsPreview(f, { month: 10, year: 2027 }, existing, "per");
        expect(pv.rows.map((r) => r.status)).toEqual(["DUPLICATE", "REVIEW", "OK", "ERROR"]);
        expect(pv.counts).toEqual({ OK: 1, DUPLICATE: 1, REVIEW: 1, ERROR: 1 });
        expect(pv.importableTotal).toBe("1234.56");
        // El token cambia si cambia el estado (otra carga en el medio).
        expect(buildPerceptionsPreview(f, { month: 10, year: 2027 }, new Set(), "per").token).not.toBe(pv.token);
    });
});
