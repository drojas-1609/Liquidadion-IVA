import { parseTaxAmount, raise, validCuit, validIsoDate } from "./common";
import type { RetentionRow } from "./retentions-csv";

const HEADER = [
    "CUIT Agente Ret./Perc.", "Denominación o Razón Social", "Impuesto", "Descripción Impuesto",
    "Rgimen", "Descripción Régimen", "Fec. Ret./Perc.", "Nro. Certificado", "Desc. Operación",
    "Imp. Ret./Perc.", "Nro. Comprobante", "Fec. Comprobante", "Desc. Comprobante", "Fec. Registración DJ Ag.Ret.",
];

export function parseMisRetencionesText(bytes: Uint8Array, kind: "RETENTIONS" | "PERCEPTIONS") {
    if (!bytes.includes(9)) return null;
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        text = new TextDecoder("windows-1252").decode(bytes);
    }
    const [header, ...lines] = text.split(/\r?\n/).filter((line) => line.trim());
    const columns = header?.split("\t").map((field) => field.trim()) ?? [];
    if (columns.length !== 15 || columns[14] !== "" || !HEADER.every((field, i) => field === columns[i])) {
        return { rows: [], fileErrors: ["El encabezado no corresponde a Exportar a Texto de Mis Retenciones."] };
    }
    if (lines.length > 5000) return { rows: [], fileErrors: ["La descarga supera las 5000 filas."] };

    const rows = lines.map((line, index): RetentionRow => {
        const row: RetentionRow = {
            line: index + 2, status: "OK", messages: [], taxCode: null, regimeCode: null,
            agentCuit: null, intermediaryCuit: null, date: null, voucherTypeCode: null,
            voucherNumber: null, certificateNumber: null, amount: null, integerAmount: false,
        };
        const fields = line.split("\t").map((field) => field.trim());
        if (fields.length !== 15 || fields[14] !== "") {
            raise(row, "ERROR", "La fila no coincide con las columnas del archivo.");
            return row;
        }
        const [agent, , tax, , regime, , date, certificate, operation, amount, number, , voucher] = fields;
        const expected = kind === "RETENTIONS" ? "RETENCION" : "PERCEPCION";
        if (operation !== expected) raise(row, "ERROR", "El movimiento no corresponde al tipo de importación.");
        if (tax === "767" || (kind === "RETENTIONS" && tax === "216")) row.taxCode = Number(tax);
        else raise(row, "ERROR", "El impuesto no corresponde a esta importación de IVA.");
        if (validCuit(agent)) row.agentCuit = agent;
        else raise(row, "ERROR", "CUIT del agente inválido.");
        if (/^\d{1,5}$/.test(regime) && Number(regime) > 0) row.regimeCode = Number(regime);
        else raise(row, "ERROR", "Régimen inválido.");
        const iso = date.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$2-$1");
        if (validIsoDate(iso)) row.date = iso;
        else raise(row, "ERROR", "Fecha inválida.");
        if (/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2}$/.test(amount)) {
            row.amount = parseTaxAmount(amount.replaceAll(".", ""))?.value ?? null;
        }
        if (!row.amount) raise(row, "ERROR", "Importe inválido.");
        if (/^[0-9A-Za-z]+(?:-[0-9A-Za-z]+)?$/.test(number) && number.length <= 20) row.voucherNumber = number;
        else raise(row, "ERROR", "Número de comprobante inválido.");
        if (voucher === "FACTURA") row.voucherTypeCode = 1;
        else if (voucher === "ORDEN DE PAGO") row.voucherTypeCode = 6;
        else raise(row, "REVIEW", "La descripción del comprobante requiere revisión.");
        if (kind === "RETENTIONS") {
            if (/^[0-9A-Za-z-]{1,40}$/.test(certificate)) row.certificateNumber = certificate;
            else raise(row, "ERROR", "Número de certificado faltante o inválido.");
        }
        return row;
    });
    return { rows, fileErrors: [] };
}
