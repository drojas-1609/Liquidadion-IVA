import { Prisma } from "@prisma/client";
import { voucherType } from "../invoice-model";

/**
 * Archivos de importación del F.5680 «SANTA CRUZ DIU ISIB» (ARCA, Mis
 * Aplicaciones Web). Función pura. Fuente del diseño: manual «Mis Aplicaciones
 * Web — F.5680» (ARCA), apartados «Percepciones - Importación» y «Retenciones -
 * Importación»; los códigos de letra y tipo se leyeron de los combos del
 * formulario el 18/11/2026 (letra 1=A 2=B 3=C 4=E 5=M; tipo 1=Factura 2=Recibo
 * 3=Nota de crédito 4=Nota de débito 5=Otros). El archivo de percepciones así
 * armado se importó sin errores en la DDJJ 10/2026 (OOSHEN, 37 registros).
 *
 *  - Percepciones (53): fecha dd/mm/aaaa (10) · CUIT agente (11) · letra (1) ·
 *    tipo (1) · número «PPPP-NNNNNNNN» a la izquierda (15) · importe (15, coma
 *    decimal, ceros a la izquierda; nota de crédito con «-» al inicio).
 *  - Retenciones (51): fecha (10) · CUIT agente (11) · constancia (15) · importe (15).
 *  - Recaudaciones bancarias (43): período aaaamm (6) · CBU (22) · importe (15).
 *    Diseño observado en la descarga de ASIP (sin muestra de importación aceptada).
 * Fin de línea CRLF. Un registro que no se puede armar sin suponer datos va a
 * `problems` y no se escribe.
 */

export type F5680Kind = "percepciones" | "retenciones" | "bancarias";

export interface F5680Record {
    id: string;
    type: string;
    date: Date;
    amount: Prisma.Decimal;
    agentCuit: string | null;
    voucherNumber: string | null;
    pointOfSale: string | null;
    voucherKind: string | null;
    voucherLetter: string | null;
    certificateNumber: string | null;
    cbu: string | null;
    /** Compra vinculada (percepción tomada del comprobante o conciliada). */
    invoice: { voucherCode: number | null; pointOfSale: number; number: number } | null;
}

export interface F5680Result { lines: string[]; problems: { id: string; reason: string }[]; total: Prisma.Decimal }

const LETTER_CODE: Record<string, string> = { A: "1", B: "2", C: "3", E: "4", M: "5" };
const KIND_CODE: Record<string, string> = { F: "1", R: "2", C: "3", D: "4" };
const KIND_OF_VOUCHER: Record<string, string> = { INVOICE: "F", CREDIT_NOTE: "C", DEBIT_NOTE: "D" };

const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

/** Importe de 15 con coma decimal; negativo con el signo adelante («-00000000525,62»). */
export function f5680Amount(v: Prisma.Decimal): string | null {
    const abs = v.abs().toFixed(2).replace(".", ",");
    const out = v.isNegative() ? "-" + abs.padStart(14, "0") : abs.padStart(15, "0");
    return out.length === 15 ? out : null;
}

export const F5680_TYPES: Record<F5680Kind, readonly string[]> = {
    percepciones: ["PERCEPCION IIBB"],
    retenciones: ["RETENCION IIBB", "SIRTAC"],
    bancarias: ["SIRCREB"],
};

export function buildF5680(kind: F5680Kind, records: readonly F5680Record[]): F5680Result {
    const lines: string[] = [];
    const problems: F5680Result["problems"] = [];
    let total = new Prisma.Decimal(0);
    const fail = (id: string, reason: string) => problems.push({ id, reason });
    for (const r of [...records].sort((a, b) => a.date.getTime() - b.date.getTime() || (a.agentCuit ?? "").localeCompare(b.agentCuit ?? ""))) {
        if (!F5680_TYPES[kind].includes(r.type)) continue;
        const amount = f5680Amount(r.amount);
        if (!amount) { fail(r.id, "importe fuera del ancho del campo"); continue; }
        if (kind === "bancarias") {
            if (!r.cbu || !/^\d{22}$/.test(r.cbu)) { fail(r.id, "falta el CBU (22 dígitos)"); continue; }
            lines.push(`${r.date.getUTCFullYear()}${String(r.date.getUTCMonth() + 1).padStart(2, "0")}${r.cbu}${amount}`);
            total = total.plus(r.amount);
            continue;
        }
        if (!r.agentCuit || !/^\d{11}$/.test(r.agentCuit)) { fail(r.id, "falta el CUIT del agente"); continue; }
        if (kind === "retenciones") {
            const cert = (r.certificateNumber ?? "").replace(/\D/g, "");
            if (cert === "" || cert.length > 15) { fail(r.id, "falta el número de constancia"); continue; }
            lines.push(`${ddmmyyyy(r.date)}${r.agentCuit}${cert.padStart(15, "0")}${amount}`);
            total = total.plus(r.amount);
            continue;
        }
        // Percepciones: la compra vinculada manda (número completo y tipo oficial).
        let letter: string | null = null, vkind: string | null = null, pos: string | null = null, num: string | null = null;
        if (r.invoice?.voucherCode != null) {
            const vt = voucherType(r.invoice.voucherCode);
            letter = vt.letter;
            vkind = KIND_OF_VOUCHER[vt.kind] ?? null;
            pos = String(r.invoice.pointOfSale);
            num = String(r.invoice.number);
        } else {
            letter = r.voucherLetter;
            vkind = r.voucherKind;
            pos = r.pointOfSale;
            num = r.voucherNumber;
        }
        const posD = (pos ?? "").replace(/\D/g, ""), numD = (num ?? "").replace(/\D/g, "");
        if (!letter || !LETTER_CODE[letter]) { fail(r.id, `letra del comprobante sin código en el F.5680 (${letter ?? "sin dato"})`); continue; }
        if (!vkind || !KIND_CODE[vkind]) { fail(r.id, "tipo de comprobante sin código en el F.5680"); continue; }
        if (posD === "" || numD === "") { fail(r.id, "falta el número de comprobante (conciliá la percepción con su compra)"); continue; }
        if (posD.replace(/^0+/, "").length > 4 || numD.replace(/^0+/, "").length > 8) { fail(r.id, "el número de comprobante no entra en el campo (PPPP-NNNNNNNN)"); continue; }
        if (r.amount.isNegative() !== (vkind === "C")) { fail(r.id, "el signo no coincide con el tipo de comprobante"); continue; }
        const number = `${posD.slice(-4).padStart(4, "0")}-${numD.slice(-8).padStart(8, "0")}`;
        lines.push(`${ddmmyyyy(r.date)}${r.agentCuit}${LETTER_CODE[letter]}${KIND_CODE[vkind]}${number.padEnd(15, " ")}${amount}`);
        total = total.plus(r.amount);
    }
    return { lines, problems, total };
}
