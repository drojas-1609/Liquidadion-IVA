import "server-only";
import { Prisma } from "@prisma/client";
import { D, ZERO, sum } from "../decimal";
import {
    computeLineVat,
    computeVoucherTotal,
    directComputableOf,
    purchaseHasNoVatBreakdown,
    voucherSign,
    voucherDisplayLabel,
    TURIVA_NOT_INCLUDED_MESSAGE,
    type InvoiceModelData,
    type LidSection,
    type PeriodVatSettingsLike,
    type VatLineData,
    type VoucherAmounts,
} from "../invoice-model";
import { checkVoucherDate, type InvoiceWarning } from "../invoice-rules";
import { DOCUMENT_TYPES, VAT_RATES, VOUCHER_TYPES, CURRENCY_PESOS } from "../arca/catalogs";
import { normalizeImportedDocNumber } from "../arca/document-rules";
import { VOUCHER_INT_MAX } from "../api-input";
import type { LidCategory, ParsedFile, ParsedRecord } from "./format";

/**
 * Vista previa de una importación del Libro IVA Digital: vincula comprobantes y
 * alícuotas, arma el modelo contable de cada fila con las reglas de las
 * Especificaciones (revisión 30/07/2025) y concilia totales. Función pura: la
 * base sólo aporta el período, su configuración de IVA y las claves de
 * comprobantes ya cargados (duplicidad).
 *
 * Estados por fila (sólo OK se importa):
 *  - ERROR:     el registro contradice el diseño oficial o una regla vigente;
 *  - REVIEW:    falta un dato o es ambiguo; no se importa hasta revisarlo;
 *  - DUPLICATE: ya cargado para el cliente (misma clave que la carga manual);
 *  - OK.
 */

export type RowStatus = "OK" | "DUPLICATE" | "REVIEW" | "ERROR";
const RANK: Record<RowStatus, number> = { OK: 0, DUPLICATE: 1, REVIEW: 2, ERROR: 3 };

export interface ImportRow {
    line: number;
    aliquotLines: number[];
    status: RowStatus;
    /** Motivos de ERROR/REVIEW/DUPLICATE, en lenguaje de operador. */
    messages: string[];
    warnings: InvoiceWarning[];
    /** Notas informativas del lector (no cambian el estado de la fila). */
    notes: string[];
    voucherCode: number | null;
    pointOfSale: number | null;
    number: number | null;
    date: string | null;
    docType: number | null;
    docNumber: string | null;
    name: string | null;
    section: LidSection | null;
    /** Clave de duplicidad (sin datos personales en el texto expuesto: sólo para comparar). */
    key: string | null;
    /** AAAA-MM-DD en que se eliminó de la app un importado con esta clave (null si no). */
    deletedOn: string | null;
    /** Modelo listo para escribir; sólo filas sin ERROR. */
    model: InvoiceModelData | null;
    /** Total informado en el archivo (campo "Importe total de la operación"). */
    informedTotal: Prisma.Decimal | null;
}

export interface SectionTotals {
    count: number;
    taxedNet: Prisma.Decimal;
    vat: Prisma.Decimal;
    netWithoutVatBreakdown: Prisma.Decimal;
    nonTaxed: Prisma.Decimal;
    exempt: Prisma.Decimal;
    vatPerception: Prisma.Decimal;
    nationalPerception: Prisma.Decimal;
    iibbPerception: Prisma.Decimal;
    municipalPerception: Prisma.Decimal;
    internalTaxes: Prisma.Decimal;
    otherTaxes: Prisma.Decimal;
    total: Prisma.Decimal;
    turivaRefund: Prisma.Decimal;
    computableCredit: Prisma.Decimal;
}

export interface ImportPreview {
    category: LidCategory;
    turivaFile: boolean;
    rows: ImportRow[];
    /** Problemas que impiden confirmar (pareja de archivos inconsistente). */
    fileErrors: string[];
    reconciliation: {
        files: { voucherRecords: number; voucherIssues: number; aliquotRecords: number; aliquotIssues: number; orphanAliquots: number };
        /** Sumas tal como figuran en los archivos (sin signo contable). */
        informed: { voucherTotal: Prisma.Decimal; aliquotNet: Prisma.Decimal; aliquotVat: Prisma.Decimal };
        statusCounts: Record<RowStatus, number>;
        /** Filas OK, con signo contable (notas de crédito restan). */
        importable: { GENERAL: SectionTotals; TURIVA: SectionTotals; CONSOLIDATED: SectionTotals };
        /** Filas OK por alícuota, con signo. */
        byRate: Record<string, { net: Prisma.Decimal; vat: Prisma.Decimal }>;
        /**
         * Por tipo de comprobante: total del archivo SIN signo (todas las filas
         * leídas) y total que se importa CON signo (filas OK). Explica la
         * diferencia entre ambos totales.
         */
        byVoucherType: VoucherTypeTotals[];
        /**
         * Puente entre el total sin signo y el total con signo de lo que se
         * importa: signedTotal = unsignedTotal − 2 × creditNotesTotal, porque
         * una nota de crédito suma en el total del archivo y resta en el contable.
         */
        signBridge: { unsignedTotal: Prisma.Decimal; creditNotesTotal: Prisma.Decimal; creditNotesCount: number; signedTotal: Prisma.Decimal };
        /**
         * Lo que NO se importa, con signo contable: filas para revisar y ya
         * cargadas (con su modelo calculado) y filas con error (sólo cantidad y
         * total del archivo, porque no tienen modelo confiable).
         */
        notImported: {
            REVIEW: SectionTotals;
            DUPLICATE: SectionTotals;
            ERROR: { count: number; informedTotal: Prisma.Decimal };
            /** Filas para revisar sin modelo calculable (p. ej. código no admitido). */
            reviewWithoutModel: number;
        };
    };
}

export interface VoucherTypeTotals {
    voucherCode: number;
    label: string;
    /** +1 suma (facturas y notas de débito) · −1 resta (notas de crédito). */
    sign: 1 | -1;
    rows: number;
    importableRows: number;
    /** Total informado en el archivo, sin signo, de todas las filas leídas de este tipo. */
    informedTotal: Prisma.Decimal;
    /** Total con signo de las filas que se importan. */
    signedTotal: Prisma.Decimal;
}

export interface PreviewContext {
    category: LidCategory;
    period: { month: number; year: number };
    settings: PeriodVatSettingsLike;
    /** Claves de comprobantes ya cargados para el cliente (todas sus categorías/períodos). */
    existingKeys: ReadonlySet<string>;
    /** Claves ya cargadas que se modificaron en la app después de importarlas (sólo para el mensaje). */
    editedKeys?: ReadonlySet<string>;
    /** Importados eliminados de la app: fecha de eliminación por clave (lib/invoice-import-deletion). */
    deletedLookup?: (key: string) => { deletedOn: string } | undefined;
    /** Confirmación expresa de volver a importar los eliminados (si no, quedan para revisar). */
    reimportDeleted?: boolean;
    /**
     * Origen de los registros: el par TXT del Libro IVA Digital (por defecto) o
     * la descarga de comprobantes del período de Portal IVA (portal-csv.ts), que
     * trae las notas de crédito en negativo y no informa código de operación ni
     * reintegro TurIVA.
     */
    source?: ImportSource;
}

export type ImportSource = "LID_TXT" | "PORTAL_CSV" | "MIS_COMPROBANTES";

/** Descargas de ARCA sin código de operación ni reintegro TurIVA (no son el TXT del Libro IVA Digital). */
function downloadLabel(source: ImportSource | undefined): string | null {
    return source === "PORTAL_CSV" ? "la descarga de Portal IVA" : source === "MIS_COMPROBANTES" ? "la consulta de Mis Comprobantes" : null;
}

export interface PreviewExtras {
    /** Errores de archivo detectados por el lector (encabezado, ZIP). */
    fileErrors?: string[];
    /** Notas informativas por línea del archivo (no cambian el estado). */
    rowNotes?: ReadonlyMap<number, string[]>;
}

/** Códigos de operación (Libro IVA Digital, Tablas del Sistema). */
export const OPERATION_CODES: ReadonlySet<string> = new Set(["A", "C", "D", "E", "N", "T", "X", "Z"]);
const VAT_TOLERANCE = D("0.01");

/** Clave de duplicidad: misma composición que duplicateVoucherWhere (lib/invoice-rules). */
export function voucherKey(k: {
    category: LidCategory;
    voucherCode: number;
    pointOfSale: number;
    number: number;
    counterpartyDocType: number | null;
    counterpartyDocNumber: string | null;
}): string {
    const base = `${k.category}|${k.voucherCode}|${k.pointOfSale}|${k.number}`;
    return k.category === "PURCHASES" ? `${base}|${k.counterpartyDocType}|${k.counterpartyDocNumber}` : base;
}

function str(v: unknown): string {
    return typeof v === "string" ? v : "";
}
function dec(v: unknown): Prisma.Decimal {
    return v instanceof Prisma.Decimal ? v : ZERO;
}
/** Número sin ceros a la izquierda ("0" si es todo ceros). */
function stripZeros(raw: string): string {
    const t = raw.trim().replace(/^0+(?=.)/, "");
    return t === "" ? "0" : t;
}
function safeInt(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null;
    const n = BigInt(raw);
    return n >= BigInt(1) && n <= BigInt(VOUCHER_INT_MAX) ? Number(n) : null;
}

function emptyTotals(): SectionTotals {
    return {
        count: 0, taxedNet: ZERO, vat: ZERO, netWithoutVatBreakdown: ZERO, nonTaxed: ZERO, exempt: ZERO, vatPerception: ZERO,
        nationalPerception: ZERO, iibbPerception: ZERO, municipalPerception: ZERO, internalTaxes: ZERO, otherTaxes: ZERO,
        total: ZERO, turivaRefund: ZERO, computableCredit: ZERO,
    };
}

function addModel(t: SectionTotals, m: InvoiceModelData): SectionTotals {
    const s = voucherSign(m.voucherCode);
    const signed = (x: Prisma.Decimal) => x.times(s);
    return {
        count: t.count + 1,
        taxedNet: t.taxedNet.plus(signed(m.taxedNetAmount)),
        vat: t.vat.plus(signed(m.totalVatAmount)),
        netWithoutVatBreakdown: t.netWithoutVatBreakdown.plus(signed(m.netWithoutVatBreakdownAmount)),
        nonTaxed: t.nonTaxed.plus(signed(m.nonTaxedAmount)),
        exempt: t.exempt.plus(signed(m.exemptAmount)),
        vatPerception: t.vatPerception.plus(signed(m.vatPerceptionAmount)),
        nationalPerception: t.nationalPerception.plus(signed(m.nationalPerceptionAmount)),
        iibbPerception: t.iibbPerception.plus(signed(m.iibbPerceptionAmount)),
        municipalPerception: t.municipalPerception.plus(signed(m.municipalPerceptionAmount)),
        internalTaxes: t.internalTaxes.plus(signed(m.internalTaxesAmount)),
        otherTaxes: t.otherTaxes.plus(signed(m.otherTaxesAmount)),
        total: t.total.plus(signed(m.voucherTotalAmount)),
        turivaRefund: t.turivaRefund.plus(signed(m.turivaRefundAmount)),
        computableCredit: t.computableCredit.plus(signed(m.directComputableVatCreditAmount)),
    };
}

function aliquotKey(category: LidCategory, r: ParsedRecord): string {
    const v = r.values;
    const base = `${Number(str(v.voucherCode))}|${Number(str(v.pointOfSale))}|${stripZeros(str(v.number))}`;
    return category === "PURCHASES" ? `${base}|${Number(str(v.docType))}|${stripZeros(str(v.docNumber))}` : base;
}

interface RowDraft {
    row: ImportRow;
    raise(status: RowStatus, message: string): void;
}
function draft(line: number): RowDraft {
    const row: ImportRow = {
        line, aliquotLines: [], status: "OK", messages: [], warnings: [], notes: [], voucherCode: null, pointOfSale: null, number: null,
        date: null, docType: null, docNumber: null, name: null, section: null, key: null, deletedOn: null, model: null, informedTotal: null,
    };
    return {
        row,
        raise(status, message) {
            row.messages.push(message);
            if (RANK[status] > RANK[row.status]) row.status = status;
        },
    };
}

/** Modelo de una fila con sus alícuotas ya vinculadas. */
function buildRow(ctx: PreviewContext, turivaFile: boolean, rec: ParsedRecord, aliquots: ParsedRecord[], d: RowDraft): void {
    const v = rec.values;
    const { category } = ctx;
    const row = d.row;
    row.aliquotLines = aliquots.map((a) => a.line);

    // Identificación.
    const voucherCode = Number(str(v.voucherCode));
    row.voucherCode = voucherCode;
    const vt = VOUCHER_TYPES.find((t) => t.code === voucherCode);
    const pointOfSale = Number(str(v.pointOfSale));
    row.pointOfSale = pointOfSale;
    const number = safeInt(str(v.number));
    row.number = number;
    const dateRaw = str(v.date);
    const dateIso = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
    row.date = dateIso;
    row.name = str(v.name).trim();
    row.informedTotal = dec(v.total);

    if (!vt) d.raise("REVIEW", `tipo de comprobante ${String(voucherCode).padStart(3, "0")} no admitido todavía por la importación`);
    if (!(pointOfSale >= 1 && pointOfSale <= 99999)) d.raise("ERROR", "punto de venta inválido (debe ser mayor que 0)");
    if (number === null) d.raise("ERROR", `número de comprobante inválido (entre 1 y ${VOUCHER_INT_MAX})`);
    if (category === "SALES") {
        const numberTo = BigInt(str(v.numberTo) || "0");
        if (number !== null && numberTo !== BigInt(number)) {
            if (numberTo < BigInt(number)) d.raise("ERROR", "el número 'hasta' es menor que el número de comprobante");
            else d.raise("REVIEW", "rango de comprobantes agrupado (número 'hasta' distinto): no se importa en esta etapa");
        }
    }
    if (row.name === "") {
        // La descarga de Portal IVA deja vacía la denominación de algunos consumidores
        // identificados (p. ej. con DNI): falta un dato, no es un registro inválido.
        if (downloadLabel(ctx.source)) d.raise("REVIEW", `${downloadLabel(ctx.source)} no informa la denominación de la contraparte: completarla antes de importar`);
        else d.raise("ERROR", "apellido y nombre o denominación vacío");
    }

    // Documento de la contraparte (formato técnico; la condición fiscal no viene en el libro).
    const docType = Number(str(v.docType));
    row.docType = docType;
    if (!DOCUMENT_TYPES.some((t) => t.code === docType)) {
        d.raise("REVIEW", `tipo de documento ${docType} fuera del catálogo admitido`);
    } else {
        const doc = normalizeImportedDocNumber(docType, stripZeros(str(v.docNumber)));
        if (!doc.ok) d.raise("ERROR", `documento de la contraparte: ${doc.error}`);
        else row.docNumber = doc.value;
    }

    // Fecha frente al período (misma regla que la carga manual).
    const date = new Date(`${dateIso}T00:00:00.000Z`);
    const dateCheck = checkVoucherDate(category, date, ctx.period);
    if (!dateCheck.ok) d.raise("ERROR", dateCheck.error);
    else row.warnings = dateCheck.warnings;

    // Pestaña: TurIVA sólo 195–197 y sólo en el archivo de TurIVA.
    const section: LidSection = turivaFile ? "TURIVA" : "GENERAL";
    row.section = section;
    // portal: importes CON signo (notas de crédito en negativo). download: descargas sin código de operación ni TurIVA.
    const portal = ctx.source === "PORTAL_CSV";
    const download = downloadLabel(ctx.source);
    if (vt && download) {
        if (vt.letter === "T") d.raise("REVIEW", `${download} no informa el reintegro TurIVA: importar este comprobante con el TXT de TurIVA`);
    } else if (vt) {
        if (vt.letter === "T" && !turivaFile) d.raise("ERROR", "los comprobantes clase T (195–197) van en el archivo de TurIVA");
        if (vt.letter !== "T" && turivaFile) d.raise("ERROR", "el archivo de TurIVA sólo admite comprobantes clase T (195–197)");
    }
    if (section === "TURIVA" && ctx.settings.turivaIncluded !== true) d.raise("ERROR", TURIVA_NOT_INCLUDED_MESSAGE);

    // Moneda: los importes del modelo están en pesos.
    const currency = str(v.currency).trim();
    const rate = dec(v.exchangeRate);
    if (currency !== CURRENCY_PESOS) d.raise("REVIEW", `moneda ${currency || "vacía"}: confirmar que los importes estén en pesos`);
    else if (!rate.equals(1)) d.raise("REVIEW", "moneda PES con tipo de cambio distinto de 1");

    // Código de operación.
    const opRaw = str(v.operationCode);
    const operationCode = opRaw === " " || opRaw === "0" ? null : opRaw;
    if (operationCode !== null && !OPERATION_CODES.has(operationCode)) d.raise("ERROR", `código de operación '${operationCode}' fuera de la tabla oficial`);

    // Compras: despacho e intermediarios no se modelan en esta etapa.
    if (category === "PURCHASES") {
        const dispatch = str(v.customsDispatch).trim();
        if (dispatch !== "" && !/^0+$/.test(dispatch)) d.raise("REVIEW", "despacho de importación informado: las importaciones se cargan en otra etapa");
        if (!/^0+$/.test(str(v.brokerCuit)) || !dec(v.commissionVat).isZero()) d.raise("REVIEW", "emisor/corredor o IVA comisión informados: no se modelan en esta etapa");
    }

    // Importes de cabecera.
    const header = {
        nonTaxed: dec(v.nonTaxed), exempt: dec(v.exempt), vatPerception: dec(v.vatPerception), nationalPerception: dec(v.nationalPerception),
        iibbPerception: dec(v.iibbPerception), municipalPerception: dec(v.municipalPerception), internalTaxes: dec(v.internalTaxes),
        otherTaxes: dec(v.otherTaxes), total: dec(v.total), turivaRefund: dec(v.turivaRefund), computableCredit: dec(v.computableCredit),
    };
    if (portal) {
        // La descarga trae las notas de crédito en negativo: el signo de cada
        // importe debe coincidir con el del código (nunca se invierte dos veces).
        const expectNegative = vt ? voucherSign(vt.code) === -1 : false;
        const signed = [...Object.values(header), ...aliquots.flatMap((a) => [dec(a.values.net), dec(a.values.vat)])].filter((x) => !x.isZero());
        if (signed.some((x) => x.isNegative() !== expectNegative)) {
            d.raise("REVIEW", expectNegative
                ? "nota de crédito con importes positivos en la descarga (se esperan negativos): revisar el signo"
                : "importe negativo en un comprobante que no es nota de crédito: revisar el signo");
        }
    } else if (Object.values(header).some((x) => x.isNegative())) d.raise("REVIEW", "importe negativo informado en el comprobante: revisar el signo");

    // Alícuotas.
    const declaredCount = Number(str(v.aliquotCount));
    if (declaredCount !== aliquots.length) {
        d.raise("ERROR", `cantidad de alícuotas declarada ${declaredCount} y encontradas ${aliquots.length} en el archivo de alícuotas`);
    }
    const noBreakdown = vt ? purchaseHasNoVatBreakdown(category, vt.code) : false;
    if (noBreakdown && aliquots.length > 0) d.raise("REVIEW", "comprobante B o C de compras con alícuotas: no discrimina IVA");
    if (vt && aliquots.length === 0 && !noBreakdown) {
        if (category === "SALES" && vt.letter === "C") {
            // Venta C sin IVA: el neto va sin discriminación.
        } else if (category === "SALES" && vt.letter === "B") {
            d.raise("REVIEW", "venta B sin detalle de alícuotas: no se puede determinar el débito fiscal");
        } else if (download && (!header.exempt.isZero() || !header.nonTaxed.isZero())) {
            // Comprobante sólo exento / no gravado: la descarga no trae línea de alícuota 0 % ni código de operación.
            d.row.notes.push(`operación exenta o no gravada: ${download} no informa el código de operación`);
        } else {
            d.raise("ERROR", "el comprobante discrimina IVA y no tiene alícuotas");
        }
    }

    const allocation = category === "PURCHASES" ? "DIRECT_COMPUTABLE" : "NOT_APPLICABLE";
    const rateCodes = aliquots.map((a) => Number(str(a.values.rateCode)));
    if (new Set(rateCodes).size !== rateCodes.length) d.raise("REVIEW", "la misma alícuota aparece más de una vez en el comprobante: unificar antes de importar");
    const lines: VatLineData[] = [];
    for (const a of aliquots) {
        const code = Number(str(a.values.rateCode));
        const net = dec(a.values.net);
        const vat = dec(a.values.vat);
        if (!VAT_RATES.some((r) => r.code === code)) {
            d.raise("ERROR", `alícuota ${String(code).padStart(4, "0")} fuera de la tabla oficial (línea ${a.line} de alícuotas)`);
            continue;
        }
        if (!portal && (net.isNegative() || vat.isNegative())) d.raise("REVIEW", `importe negativo en la alícuota (línea ${a.line})`);
        if (vat.abs().greaterThan(net.abs()) && operationCode !== "C") d.raise("ERROR", `el impuesto liquidado supera al neto gravado (línea ${a.line} de alícuotas)`);
        const computed = computeLineVat(net.abs(), code);
        if (computed.minus(vat.abs()).abs().greaterThan(VAT_TOLERANCE)) {
            d.raise("REVIEW", `IVA informado ${vat.abs().toFixed(2)} y calculado ${computed.toFixed(2)} difieren en más de 0,01 (línea ${a.line} de alícuotas)`);
        }
        if (code === 3 && operationCode === null) {
            d.raise("REVIEW", download ? `neto gravado al 0 %: ${download} no informa el código de operación` : `alícuota 0% sin código de operación (línea ${a.line} de alícuotas)`);
        }
        lines.push({
            vatRateCode: code,
            netAmount: net.abs(),
            vatAmount: vat.abs(),
            creditAllocation: allocation,
            computableVatAmount: category === "PURCHASES" ? vat.abs() : null,
            computableOverridden: false,
        });
    }

    const taxedNet = sum(lines.map((l) => l.netAmount));
    const totalVat = sum(lines.map((l) => l.vatAmount));
    const others = sum([header.nonTaxed, header.exempt, header.vatPerception, header.nationalPerception, header.iibbPerception,
        header.municipalPerception, header.internalTaxes, header.otherTaxes].map((x) => x.abs()));
    let netWithoutBreakdown = ZERO;
    if (aliquots.length === 0 && (noBreakdown || (category === "SALES" && vt?.letter === "C"))) {
        netWithoutBreakdown = header.total.abs().minus(others);
        if (netWithoutBreakdown.isNegative()) d.raise("ERROR", "el total es menor que la suma de los conceptos informados");
    }

    // Crédito fiscal computable (compras), según la modalidad de prorrateo del período.
    let reportedCredit: Prisma.Decimal | null = null;
    if (category === "PURCHASES") {
        reportedCredit = header.computableCredit.abs();
        const mode = ctx.settings.creditProrationMode;
        if (ctx.source === "MIS_COMPROBANTES" && mode !== "NONE") {
            // La consulta no informa el crédito computable: sólo sin prorrateo es igual al IVA (Especificaciones, campo 21).
            d.raise("REVIEW", "la consulta de Mis Comprobantes no informa el crédito fiscal computable y el período tiene prorrateo: cargarlo por otra vía");
        } else if (mode === "GLOBAL" || mode === "DIRECT_AND_GLOBAL") {
            d.raise("REVIEW", "período con prorrateo global: la asignación del crédito por línea no se puede determinar desde el archivo");
        } else if (reportedCredit.greaterThan(totalVat)) {
            d.raise("ERROR", "el crédito fiscal computable informado supera al IVA liquidado");
        } else if (!reportedCredit.equals(totalVat)) {
            if (mode === "NONE") {
                d.raise("REVIEW", "crédito fiscal computable distinto del IVA liquidado en un período sin prorrateo");
            } else if (lines.length === 1) {
                lines[0] = { ...lines[0], computableVatAmount: reportedCredit, computableOverridden: true };
            } else {
                d.raise("REVIEW", "crédito computable parcial con varias alícuotas: asignar por línea manualmente");
            }
        }
    }

    const amounts: VoucherAmounts = {
        taxedNetAmount: taxedNet,
        totalVatAmount: totalVat,
        netWithoutVatBreakdownAmount: netWithoutBreakdown.isNegative() ? ZERO : netWithoutBreakdown,
        nonTaxedAmount: header.nonTaxed.abs(),
        exemptAmount: header.exempt.abs(),
        vatPerceptionAmount: header.vatPerception.abs(),
        nationalPerceptionAmount: header.nationalPerception.abs(),
        iibbPerceptionAmount: header.iibbPerception.abs(),
        municipalPerceptionAmount: header.municipalPerception.abs(),
        internalTaxesAmount: header.internalTaxes.abs(),
        otherTaxesAmount: header.otherTaxes.abs(),
    };
    const computedTotal = computeVoucherTotal(amounts);
    if (!computedTotal.equals(header.total.abs())) {
        d.raise("REVIEW", `el total informado ${header.total.abs().toFixed(2)} no coincide con la suma de sus componentes ${computedTotal.toFixed(2)} (diferencia ${header.total.abs().minus(computedTotal).toFixed(2)})`);
    }

    if (vt && number !== null && row.docNumber !== null) {
        row.key = voucherKey({ category, voucherCode, pointOfSale, number, counterpartyDocType: docType, counterpartyDocNumber: row.docNumber });
    }
    if (row.status === "ERROR" || !vt || number === null || row.docNumber === null) return;

    row.model = {
        ...amounts,
        category,
        voucherCode,
        pointOfSale,
        number,
        voucherDate: date,
        counterpartyDocType: docType,
        counterpartyDocNumber: row.docNumber,
        counterpartyName: row.name,
        currencyCode: CURRENCY_PESOS,
        exchangeRate: D(1),
        directComputableVatCreditAmount: directComputableOf(lines),
        reportedComputableVatCreditAmount: reportedCredit,
        grossIncomeTaxBaseAmount: category === "SALES" ? amounts.taxedNetAmount.plus(amounts.netWithoutVatBreakdownAmount) : null,
        voucherTotalAmount: computedTotal,
        turivaRefundAmount: header.turivaRefund.abs(),
        lidSection: section,
        operationCode,
        vatLines: lines,
    };
}

export function buildImportPreview(ctx: PreviewContext, vouchers: ParsedFile, aliquots: ParsedFile, extras: PreviewExtras = {}): ImportPreview {
    const fileErrors: string[] = [...(extras.fileErrors ?? [])];
    if (vouchers.kind !== "VOUCHERS" || aliquots.kind !== "ALIQUOTS" || vouchers.category !== ctx.category || aliquots.category !== ctx.category) {
        throw new Error("buildImportPreview: archivos o categoría inconsistentes");
    }
    for (const i of aliquots.issues) fileErrors.push(`alícuotas, línea ${i.line}: ${i.message}`);
    if (vouchers.records.length === 0 && vouchers.issues.length === 0) fileErrors.push("el archivo de comprobantes está vacío");

    // Alícuotas agrupadas por comprobante, en el orden del archivo. En el par de
    // TXT se vinculan por la clave del comprobante; en las descargas de un solo
    // archivo (Portal IVA, Mis Comprobantes) cada alícuota sale de SU línea, así
    // que se vinculan por línea: un comprobante repetido en el archivo no le
    // suma sus alícuotas a la primera aparición.
    const byLine = downloadLabel(ctx.source) !== null;
    const linkKey = (r: ParsedRecord) => (byLine ? `L${r.line}` : aliquotKey(ctx.category, r));
    const byKey = new Map<string, ParsedRecord[]>();
    for (const a of aliquots.records) {
        const k = linkKey(a);
        byKey.set(k, [...(byKey.get(k) ?? []), a]);
    }

    const rows: ImportRow[] = [];
    // Líneas ilegibles del archivo de comprobantes: fila con ERROR (no se puede vincular).
    for (const i of vouchers.issues) {
        const d = draft(i.line);
        d.raise("ERROR", i.message + (i.field ? ` (campo ${i.field})` : ""));
        rows.push(d.row);
    }
    const seen = new Set<string>();
    for (const rec of vouchers.records) {
        const d = draft(rec.line);
        const k = aliquotKey(ctx.category, rec);
        const lk = linkKey(rec);
        const mine = byKey.get(lk) ?? [];
        // TXT: la primera aparición de la clave toma sus alícuotas; una repetición
        // no. Descargas: cada fila toma las de su línea.
        const taken = !byLine && seen.has(k) ? [] : mine;
        if (byLine || !seen.has(k)) byKey.delete(lk);
        buildRow(ctx, vouchers.turiva, rec, taken, d);
        d.row.notes.push(...(extras.rowNotes?.get(rec.line) ?? []));
        if (seen.has(k)) d.raise("ERROR", "comprobante repetido en el archivo");
        seen.add(k);
        rows.push(d.row);
    }
    const orphanAliquots = [...byKey.values()].reduce((n, list) => n + list.length, 0);
    if (orphanAliquots > 0) {
        const linesList = [...byKey.values()].flat().map((a) => a.line).slice(0, 10).join(", ");
        fileErrors.push(`${orphanAliquots} alícuota(s) sin comprobante en el archivo de comprobantes (líneas ${linesList}${orphanAliquots > 10 ? ", …" : ""}): verificar que ambos archivos sean del mismo período y libro`);
    }

    // Duplicidad contra lo ya cargado. Un comprobante que ya existe para el
    // cliente queda «ya cargado» aunque además tenga motivos de revisión (p. ej.
    // denominación vacía en la descarga de Portal IVA, ya completada por otra
    // carga): no queda pendiente ni suma en «lo que queda afuera para revisar».
    // Los motivos de revisión se conservan como detalle. Un ERROR sigue siendo ERROR.
    for (const r of rows) {
        if (r.status !== "ERROR" && r.key !== null && ctx.existingKeys.has(r.key)) {
            // Nunca se sobrescribe lo cargado: tampoco las correcciones hechas en la app.
            r.messages.unshift(ctx.editedKeys?.has(r.key)
                ? "ya cargado para este cliente y modificado en la app después de importarlo: se omite (la importación no sobrescribe los cambios)"
                : "ya cargado para este cliente: se omite");
            r.status = "DUPLICATE";
            continue;
        }
        // Importado y después eliminado de la app: no se vuelve a cargar en silencio.
        const deleted = r.status !== "ERROR" && r.key !== null ? ctx.deletedLookup?.(r.key) : undefined;
        if (deleted) {
            r.deletedOn = deleted.deletedOn;
            if (ctx.reimportDeleted) {
                r.notes.push(`se había eliminado de la app el ${deleted.deletedOn}: se vuelve a importar por confirmación expresa`);
            } else {
                r.messages.push(`se eliminó de la app el ${deleted.deletedOn}: no se vuelve a importar salvo que marques «Volver a importar los comprobantes eliminados»`);
                if (RANK.REVIEW > RANK[r.status]) r.status = "REVIEW";
            }
        }
    }
    rows.sort((a, b) => a.line - b.line);

    let general = emptyTotals(), turiva = emptyTotals(), consolidated = emptyTotals();
    const byRate: Record<string, { net: Prisma.Decimal; vat: Prisma.Decimal }> = {};
    for (const r of rows) {
        if (r.status !== "OK" || !r.model) continue;
        if (r.model.lidSection === "TURIVA") turiva = addModel(turiva, r.model);
        else general = addModel(general, r.model);
        consolidated = addModel(consolidated, r.model);
        const s = voucherSign(r.model.voucherCode);
        for (const l of r.model.vatLines) {
            const k = String(l.vatRateCode).padStart(4, "0");
            const cur = byRate[k] ?? { net: ZERO, vat: ZERO };
            byRate[k] = { net: cur.net.plus(l.netAmount.times(s)), vat: cur.vat.plus(l.vatAmount.times(s)) };
        }
    }
    const statusCounts: Record<RowStatus, number> = { OK: 0, DUPLICATE: 0, REVIEW: 0, ERROR: 0 };
    for (const r of rows) statusCounts[r.status]++;

    let reviewTotals = emptyTotals(), duplicateTotals = emptyTotals(), reviewWithoutModel = 0;
    const errorTotals = { count: 0, informedTotal: ZERO };
    for (const r of rows) {
        if (r.status === "REVIEW") {
            if (r.model) reviewTotals = addModel(reviewTotals, r.model);
            else reviewWithoutModel++;
        } else if (r.status === "DUPLICATE" && r.model) duplicateTotals = addModel(duplicateTotals, r.model);
        else if (r.status === "ERROR") {
            errorTotals.count++;
            errorTotals.informedTotal = errorTotals.informedTotal.plus((r.informedTotal ?? ZERO).abs());
        }
    }

    const byType = new Map<number, VoucherTypeTotals>();
    let creditNotesTotal = ZERO, creditNotesCount = 0, unsignedTotal = ZERO;
    for (const r of rows) {
        const vt = r.voucherCode === null ? undefined : VOUCHER_TYPES.find((t) => t.code === r.voucherCode);
        if (!vt) continue;
        const s = voucherSign(vt.code);
        const cur = byType.get(vt.code) ?? { voucherCode: vt.code, label: voucherDisplayLabel(vt.code), sign: s, rows: 0, importableRows: 0, informedTotal: ZERO, signedTotal: ZERO };
        cur.rows++;
        cur.informedTotal = cur.informedTotal.plus((r.informedTotal ?? ZERO).abs());
        if (r.status === "OK" && r.model) {
            cur.importableRows++;
            cur.signedTotal = cur.signedTotal.plus(r.model.voucherTotalAmount.times(s));
            unsignedTotal = unsignedTotal.plus(r.model.voucherTotalAmount);
            if (s === -1) {
                creditNotesTotal = creditNotesTotal.plus(r.model.voucherTotalAmount);
                creditNotesCount++;
            }
        }
        byType.set(vt.code, cur);
    }

    return {
        category: ctx.category,
        turivaFile: vouchers.turiva,
        rows,
        fileErrors,
        reconciliation: {
            files: {
                voucherRecords: vouchers.records.length, voucherIssues: vouchers.issues.length,
                aliquotRecords: aliquots.records.length, aliquotIssues: aliquots.issues.length, orphanAliquots,
            },
            informed: {
                voucherTotal: sum(vouchers.records.map((r) => dec(r.values.total).abs())),
                aliquotNet: sum(aliquots.records.map((r) => dec(r.values.net).abs())),
                aliquotVat: sum(aliquots.records.map((r) => dec(r.values.vat).abs())),
            },
            statusCounts,
            importable: { GENERAL: general, TURIVA: turiva, CONSOLIDATED: consolidated },
            byRate,
            byVoucherType: [...byType.values()].sort((a, b) => a.voucherCode - b.voucherCode),
            signBridge: { unsignedTotal, creditNotesTotal, creditNotesCount, signedTotal: consolidated.total },
            notImported: { REVIEW: reviewTotals, DUPLICATE: duplicateTotals, ERROR: errorTotals, reviewWithoutModel },
        },
    };
}
