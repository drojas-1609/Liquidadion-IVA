/**
 * Genera archivos SINTÉTICOS del Libro IVA Digital (par de ventas y par de
 * compras) para el smoke en DEV o pruebas manuales. Ningún dato es real: CUIT
 * ficticios con dígito verificador válido, nombres «SINTETICO».
 *
 * Uso (fuera del repositorio):
 *   ./node_modules/.bin/vite-node --config vitest.config.ts scripts/libro-iva-import/generate-synthetic.ts -- \
 *     --out /ruta/fuera/del/repo --period 202610 --sales 20 --purchases 15 [--with-issues]
 *
 * --with-issues agrega, en cada libro, una fila con CUIT inválido (Error) y una
 * con total que no cierra (Revisar). Siempre incluye una nota de crédito A y, en
 * ventas, dos FC B a consumidores con DNI.
 * Escribe:
 *  - LIBRO_IVA_DIGITAL_{VENTAS,COMPRAS}_{CBTE,ALICUOTAS}_SINTETICO_<periodo>.txt
 *  - comprobantes_periodo_<periodo>_{ventas,compras}_SINTETICO (montos expresados en pesos).csv
 *    y el mismo CSV dentro de un .zip, como la descarga de Portal IVA: notas de
 *    crédito en negativo y, en las dos FC B a consumidores, denominación VACÍA
 *    (en el TXT la tienen). Sin las filas de --with-issues.
 *  - RESUMEN con los totales esperados. Nunca sobrescribe.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
    ansiFile, nthCuit, portalCsv, zipOne, type SynthPortalRow, purchaseAliquotLine, purchaseVoucherLine, salesAliquotLine, salesVoucherLine,
    type SynthAliquot, type SynthVoucher,
} from "../../tests/helpers/libro-iva-synth";

function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
    if (fallback === undefined) throw new Error(`falta --${name}`);
    return fallback;
}
const out = resolve(arg("out"));
const repo = resolve(__dirname, "../..");
if (!relative(repo, out).startsWith("..")) throw new Error("--out debe estar FUERA del repositorio (los archivos generados no van a Git)");
const period = arg("period", "202610");
if (!/^\d{4}(0[1-9]|1[0-2])$/.test(period)) throw new Error("--period debe ser AAAAMM");
const nSales = Number(arg("sales", "20")), nPurchases = Number(arg("purchases", "15"));
const withIssues = process.argv.includes("--with-issues");

const cents = (x: number) => (Math.round(x * 100) / 100).toFixed(2);
const DOCS = Array.from({ length: 200 }, (_, k) => nthCuit(2070000000, k));
const SELLERS = Array.from({ length: 200 }, (_, k) => nthCuit(3071000000, k));

type Row = { v: SynthVoucher; a: SynthAliquot[]; consumer?: boolean; issue?: boolean };
function rows(category: "SALES" | "PURCHASES", n: number): Row[] {
    const list: Row[] = [];
    const docs = category === "SALES" ? DOCS : SELLERS;
    for (let i = 1; i <= n; i++) {
        const net21 = 1000 + i * 10, net105 = i % 3 === 0 ? 500 : 0;
        const vat21 = net21 * 0.21, vat105 = net105 * 0.105;
        const doc = docs[i % docs.length];
        const lines: SynthAliquot[] = [{ code: 1, pos: 2, number: i, doc, net: cents(net21), rate: 5, vat: cents(vat21) }];
        if (net105 > 0) lines.push({ code: 1, pos: 2, number: i, doc, net: cents(net105), rate: 4, vat: cents(vat105) });
        list.push({
            v: {
                date: `${period}${String(1 + (i % 28)).padStart(2, "0")}`, code: 1, pos: 2, number: i, doc,
                name: `${category === "SALES" ? "CLIENTE" : "PROVEEDOR"} SINTETICO ${i}`,
                total: cents(net21 + vat21 + net105 + vat105), aliquotCount: lines.length, computableCredit: cents(vat21 + vat105),
            },
            a: lines,
        });
    }
    // Una nota de crédito A que resta (n + 1).
    const nc = n + 1, doc = docs[0];
    list.push({ v: { date: `${period}15`, code: 3, pos: 2, number: nc, doc, name: "NOTA DE CREDITO SINTETICA", total: "121.00", aliquotCount: 1, computableCredit: "21.00" },
        a: [{ code: 3, pos: 2, number: nc, doc, net: "100.00", rate: 5, vat: "21.00" }] });
    if (category === "SALES") {
        // Dos FC B a consumidores identificados con DNI (en la descarga de Portal IVA, sin denominación).
        for (const [k, dni, net] of [[1, "30111222", 100], [2, "30111223", 200]] as const) {
            const num = 900 + k, vat = net * 0.21;
            list.push({ consumer: true, v: { date: `${period}${String(18 + k)}`, code: 6, pos: 3, number: num, docType: 96, doc: dni, name: `CONSUMIDOR SINTETICO ${k}`, total: cents(net + vat), aliquotCount: 1 },
                a: [{ code: 6, pos: 3, number: num, net: cents(net), rate: 5, vat: cents(vat) }] });
        }
    }
    if (withIssues) {
        const bad = docs[1].slice(0, 10) + String((Number(docs[1][10]) + 1) % 10);
        list.push({ issue: true, v: { date: `${period}16`, code: 1, pos: 2, number: n + 2, doc: bad, name: "CUIT INVALIDO SINTETICO", total: "121.00", aliquotCount: 1, computableCredit: "21.00" },
            a: [{ code: 1, pos: 2, number: n + 2, doc: bad, net: "100.00", rate: 5, vat: "21.00" }] });
        list.push({ issue: true, v: { date: `${period}17`, code: 1, pos: 2, number: n + 3, doc: docs[2], name: "TOTAL QUE NO CIERRA SINTETICO", total: "125.00", aliquotCount: 1, computableCredit: "21.00" },
            a: [{ code: 1, pos: 2, number: n + 3, doc: docs[2], net: "100.00", rate: 5, vat: "21.00" }] });
    }
    return list;
}

function write(name: string, bytes: Uint8Array) {
    const p = join(out, name);
    if (existsSync(p)) throw new Error(`ya existe ${p}: no se sobrescribe`);
    writeFileSync(p, bytes, { flag: "wx" });
}

const summary: string[] = [`Libro IVA Digital SINTÉTICO · período ${period} · ${withIssues ? "con" : "sin"} filas de error/revisión`];
for (const [category, n, tag] of [["SALES", nSales, "VENTAS"], ["PURCHASES", nPurchases, "COMPRAS"]] as const) {
    const list = rows(category, n);
    const vLine = category === "SALES" ? (v: SynthVoucher) => salesVoucherLine(v) : (v: SynthVoucher) => purchaseVoucherLine(v);
    const aLine = category === "SALES" ? salesAliquotLine : purchaseAliquotLine;
    write(`LIBRO_IVA_DIGITAL_${tag}_CBTE_SINTETICO_${period}.txt`, ansiFile(list.map((r) => vLine(r.v))));
    write(`LIBRO_IVA_DIGITAL_${tag}_ALICUOTAS_SINTETICO_${period}.txt`, ansiFile(list.flatMap((r) => r.a.map(aLine))));
    const ok = list.filter((r) => !r.issue);
    const sign = (r: Row) => (r.v.code === 3 ? -1 : 1);
    const vatOf = (rs: Row[]) => rs.reduce((s, r) => s + sign(r) * r.a.reduce((x, l) => x + Number(l.vat), 0), 0);
    const totalOf = (rs: Row[]) => rs.reduce((s, r) => s + sign(r) * Number(r.v.total), 0);
    summary.push(`${tag} TXT: ${list.length} comprobantes (${ok.length} se importan${withIssues ? ", 1 error y 1 para revisar" : ""}, incluye 1 NC A${category === "SALES" ? " y 2 FC B a consumidores" : ""}) · IVA con signo ${cents(vatOf(ok))} · total con signo ${cents(totalOf(ok))}`);

    // Descarga de Portal IVA: mismos comprobantes válidos, NC en negativo, consumidores sin denominación.
    const neg = (x: string, r: Row) => (r.v.code === 3 ? "-" + x : x);
    const portalRows: SynthPortalRow[] = ok.map((r) => {
        const rates: Record<string, [string, string]> = {};
        for (const l of r.a) rates[l.rate === 5 ? "21" : "10,5"] = [neg(l.net, r), neg(l.vat, r)];
        return {
            date: `${r.v.date.slice(0, 4)}-${r.v.date.slice(4, 6)}-${r.v.date.slice(6, 8)}`, code: r.v.code, pos: r.v.pos, number: r.v.number,
            docType: r.v.docType, doc: r.v.doc, name: r.consumer ? "" : r.v.name, total: neg(r.v.total, r),
            computableCredit: category === "PURCHASES" ? neg(r.v.computableCredit ?? "0", r) : undefined, rates,
        };
    });
    const csv = portalCsv(category, portalRows);
    const base = `comprobantes_periodo_${period}_${tag.toLowerCase()}_SINTETICO`;
    write(`${base} (montos expresados en pesos).csv`, csv);
    write(`${base}.zip`, zipOne(`${base} (montos expresados en pesos).csv`, csv));
    const portalOk = ok.filter((r) => !r.consumer);
    summary.push(`${tag} Portal IVA: ${ok.length} comprobantes (${portalOk.length} se importan${category === "SALES" ? ", 2 para revisar por denominación vacía" : ""}) · IVA con signo de lo importable ${cents(vatOf(portalOk))}${category === "SALES" ? ` · IVA para revisar ${cents(vatOf(ok.filter((r) => r.consumer)))}` : ""}`);
}
write(`RESUMEN_SINTETICO_${period}.txt`, new TextEncoder().encode(summary.join("\n") + "\n"));
console.log(summary.join("\n"));
