import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { voucherSign } from "../invoice-model";
import type { LiquidationResult } from "../liquidation-calc";
import { invoiceIssues, perceptionControl, taxRecordIssues, type ExportIssue } from "./classification";
import { writeF2051Files, type F2051Result } from "./f2051-csv";
import { writeIvaSimpleFiles, type IvaSimpleResult } from "./iva-simple-csv";
import { writeLidFiles } from "./lid-writer";
import { ExportFormatError } from "./text";
import type { ExportFile, ExportInvoice, ExportSettings, ExportTaxRecord, OmittedFile } from "./types";
import { VAT_EXPORT_ENGINE_VERSION } from "./version";
import { writeZip } from "./zip";

/**
 * Paquete de presentación de IVA de un período (ZIP), generado SIEMPRE desde
 * los datos del sistema (nunca devuelve los archivos importados):
 *  - archivos para ARCA (Libro IVA Digital, apertura de IVA Simple, F.2051);
 *  - RESUMEN.txt: identificación, determinación del motor, conciliación de
 *    los archivos contra el motor, archivos incluidos (con huella) y omitidos;
 *  - CONCEPTOS_A_CARGAR_EN_ARCA.txt: lo que se completa a mano en el Portal IVA;
 *  - LEEME.txt: orden de importación.
 * Un BORRADOR se identifica en el nombre del ZIP, de cada archivo de texto y en
 * su contenido. La versión FINAL sólo se genera en el cierre (sin bloqueos) y
 * se descarga tal como se guardó.
 */

export type PackageMode = "DRAFT" | "FINAL";

export interface PackageIdentity {
    clientName: string;
    /** CUIT del cliente (contribuyente informante) con guiones o sin ellos. */
    clientCuit: string;
    month: number;
    year: number;
}

export interface PackageVatAdjustment {
    regime: string;
    contributionsAmount: Prisma.Decimal;
    computableAmount: Prisma.Decimal;
    reference: string | null;
}

export interface PackageInput {
    mode: PackageMode;
    identity: PackageIdentity;
    /** Versión cerrada (FINAL) o null en borrador. */
    version: number | null;
    generatedAt: Date;
    contentHash: string;
    settings: ExportSettings & {
        previousTechnicalBalanceReference: string | null;
        previousFreeBalanceReference: string | null;
    };
    adjustments: PackageVatAdjustment[];
    liquidation: LiquidationResult;
    invoices: ExportInvoice[];
    taxRecords: ExportTaxRecord[];
}

export interface PackageFileInfo {
    name: string;
    records: number;
    bytes: number;
    sha256: string;
}

export interface PackageResult {
    zip: Uint8Array;
    fileName: string;
    files: PackageFileInfo[];
    omitted: OmittedFile[];
    issues: ExportIssue[];
    reconciliation: ReconciliationLine[];
}

export interface ReconciliationLine {
    label: string;
    engine: string;
    files: string;
    ok: boolean;
    note?: string;
}

const ZERO = new Prisma.Decimal(0);
const money = (d: Prisma.Decimal) => {
    const [i, f] = d.abs().toFixed(2).split(".");
    return `${d.isNegative() ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${f}`;
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const utf8 = (s: string) => new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s.replaceAll("\n", "\r\n"), "utf8")]));

/** Todos los controles del período (sin generar archivos). */
export function periodExportIssues(invoices: ExportInvoice[], taxRecords: ExportTaxRecord[], settings: ExportSettings): ExportIssue[] {
    return [
        ...invoices.flatMap((i) => invoiceIssues(i, settings)),
        ...taxRecords.flatMap((t) => taxRecordIssues(t)),
        ...perceptionControl(invoices, taxRecords),
    ];
}

export function hasExportBlockers(issues: ExportIssue[]): boolean {
    return issues.some((i) => i.level === "EXPORT" || i.level === "LIQUIDATION");
}

function cuitDigits(c: string): string {
    return c.replace(/\D/g, "");
}

export function packageFileName(identity: PackageIdentity, mode: PackageMode, version: number | null): string {
    const per = `${identity.year}${String(identity.month).padStart(2, "0")}`;
    return mode === "DRAFT" ? `BORRADOR_IVA_${cuitDigits(identity.clientCuit)}_${per}.zip` : `IVA_${cuitDigits(identity.clientCuit)}_${per}_v${version}.zip`;
}

function signedVat(invoices: ExportInvoice[], category: string): Prisma.Decimal {
    return invoices
        .filter((i) => i.category === category && i.voucherCode !== null)
        .reduce((s, i) => s.plus((i.totalVatAmount ?? ZERO).times(voucherSign(i.voucherCode!))), ZERO);
}

export function buildPackage(input: PackageInput): PackageResult {
    const { mode, identity, liquidation: liq } = input;
    const issues = periodExportIssues(input.invoices, input.taxRecords, input.settings);
    if (mode === "FINAL" && hasExportBlockers(issues)) throw new ExportFormatError("la versión final no se genera con bloqueos de exportación pendientes");
    const draftTag = mode === "DRAFT" ? "BORRADOR — NO PRESENTAR. " : "";

    const files: ExportFile[] = [];
    const omitted: OmittedFile[] = [];
    const attempt = <T,>(label: string, names: string[], fn: () => T): T | null => {
        try {
            return fn();
        } catch (e) {
            if (!(e instanceof ExportFormatError)) throw e;
            for (const n of names) omitted.push({ name: n, reason: `${label}: hay datos pendientes (${e.message}); ver los controles` });
            return null;
        }
    };

    const lid = attempt("Libro IVA Digital", ["LIBRO_IVA_DIGITAL_*.txt"], () => writeLidFiles(input.invoices, input.settings, { cuit: identity.clientCuit, name: identity.clientName }));
    if (lid) {
        files.push(...lid.files);
        omitted.push(...lid.omitted);
    }
    const simple: IvaSimpleResult | null = attempt("Apertura de IVA Simple", ["IVA_SIMPLE_*.csv"], () => writeIvaSimpleFiles(input.invoices));
    if (simple) {
        files.push(...simple.files);
        omitted.push(...simple.omitted);
    }
    const f2051: F2051Result | null = attempt("Retenciones y percepciones del F.2051", ["F2051_*.csv"], () => writeF2051Files(input.taxRecords));
    if (f2051) {
        files.push(...f2051.files);
        omitted.push(...f2051.omitted);
    }

    // ── Conciliación de los archivos contra el motor ──────────────────────
    const rec: ReconciliationLine[] = [];
    const line = (label: string, engine: Prisma.Decimal, fromFiles: Prisma.Decimal | null, note?: string) =>
        rec.push({ label, engine: money(engine), files: fromFiles === null ? "no generado" : money(fromFiles), ok: fromFiles !== null && engine.equals(fromFiles), note });
    line("Débito fiscal (motor) vs. alícuotas de ventas del Libro IVA Digital", liq.iva.debit, lid ? signedVat(input.invoices, "SALES") : null);
    line(
        "Débito fiscal (motor) vs. apertura: débito − restitución",
        liq.iva.debit,
        simple ? simple.totals.debitVat.minus(simple.totals.debitRestitutionVat) : null,
    );
    line(
        "Crédito fiscal por compras (motor) vs. apertura: computable − restitución",
        liq.iva.creditPurchases,
        simple ? simple.totals.creditComputable.minus(simple.totals.creditRestitutionVat) : null,
        "las notas de crédito recibidas restituyen el crédito facturado",
    );
    line(
        "Retenciones y percepciones (motor) vs. archivos del F.2051",
        liq.iva.retentions,
        f2051 ? f2051.totals.retentions.plus(f2051.totals.perceptions).plus(f2051.totals.customs) : null,
    );

    const fileInfo: PackageFileInfo[] = files.map((f) => ({ name: f.name, records: f.records, bytes: f.bytes.length, sha256: sha(f.bytes) }));
    const mm = String(identity.month).padStart(2, "0");
    const head = [
        `${draftTag}Dero Company Gestión — Paquete de presentación de IVA`,
        `Cliente: ${identity.clientName}`,
        `CUIT: ${identity.clientCuit}`,
        `Período: ${mm}/${identity.year}`,
        mode === "DRAFT" ? "Estado: BORRADOR (período abierto; puede cambiar)" : `Estado: liquidación cerrada, versión ${input.version}`,
        `Generado: ${input.generatedAt.toISOString()} (UTC)`,
        `Versión del motor y exportadores: ${VAT_EXPORT_ENGINE_VERSION}`,
        `Huella del contenido del período: ${input.contentHash}`,
        "",
    ];

    const det = liq.iva;
    const resumen = [
        ...head,
        "DETERMINACIÓN DEL IMPUESTO (motor de la aplicación)",
        `  Total del débito fiscal: ${money(det.debit)}`,
        `  Crédito fiscal por compras: ${money(det.creditPurchases)}`,
        `  Crédito Fiscal Contrib. Seg. Soc. – Anexo I Ley 27.541 (computable): ${money(det.creditSocialSecurityAnnexI)}`,
        `  Crédito Fiscal Contrib. Seg. Soc. – Art. 91 Ley 27.467 (aplicado): ${money(det.creditSocialSecurityArt91)}`,
        `  Total del crédito fiscal: ${money(det.credit)}`,
        `  Saldo técnico a favor del contribuyente del período anterior: ${money(det.previousTechnicalBalance)}`,
        `  Saldo técnico a favor de ARCA: ${money(det.technicalBalanceArca)}`,
        `  Saldo técnico a favor del contribuyente: ${money(det.technicalBalanceInFavor)}`,
        `  Saldo de libre disponibilidad del período anterior: ${money(det.previousFreeBalance)}`,
        `  Retenciones: ${money(det.withholdings)} · Percepciones: ${money(det.perceptions)} · Percepciones aduaneras: ${money(det.customsPerceptions)}`,
        `  Saldo de impuesto a favor de ARCA: ${money(det.balanceToPay)}`,
        `  Saldo de libre disponibilidad a favor del contribuyente: ${money(det.freeBalanceInFavor)}`,
        "",
        "CONCILIACIÓN DE LOS ARCHIVOS CONTRA EL MOTOR",
        ...rec.map((r) => `  [${r.ok ? "OK" : "REVISAR"}] ${r.label}: motor ${r.engine} · archivos ${r.files}${r.note ? ` (${r.note})` : ""}`),
        "",
        "ARCHIVOS INCLUIDOS",
        ...fileInfo.map((f) => `  ${f.name}: ${f.records} registros, ${f.bytes} bytes, sha256 ${f.sha256}`),
        "",
        "ARCHIVOS NO INCLUIDOS",
        ...(omitted.length ? omitted.map((o) => `  ${o.name}: ${o.reason}`) : ["  (ninguno)"]),
        "",
        "CONTROLES",
        `  Bloquean la exportación: ${issues.filter((i) => i.level === "EXPORT").length}`,
        `  Advertencias: ${issues.filter((i) => i.level === "WARNING").length}`,
        ...issues.filter((i) => i.level !== "INFO").slice(0, 200).map((i) => `  - [${i.level === "EXPORT" ? "BLOQUEA" : "ADVERTENCIA"}] ${i.message}${i.invoiceId ? ` (comprobante ${i.invoiceId})` : ""}${i.taxRecordId ? ` (retención/percepción ${i.taxRecordId})` : ""}`),
        "",
    ].join("\n");

    const annexI = input.adjustments.find((a) => a.regime === "LEY_27541_ANEXO_I");
    const art91 = input.adjustments.find((a) => a.regime === "LEY_27467_ART_91");
    const manual = [
        ...head,
        "CONCEPTOS A COMPLETAR EN EL PORTAL IVA (no viajan en los archivos)",
        "",
        "Ajustes al crédito fiscal → Crédito Fiscal Contrib. Seg. Soc.:",
        annexI
            ? `  Anexo I Ley 27.541: crédito fiscal ${money(annexI.contributionsAmount)} · computable ${money(annexI.computableAmount)}${annexI.reference ? ` (ref. ${annexI.reference})` : ""}`
            : "  Anexo I Ley 27.541: sin importe cargado",
        art91
            ? `  Art. 91 Ley 27.467: crédito fiscal ${money(art91.contributionsAmount)} · computable ${money(art91.computableAmount)} (se aplica hasta el débito: ${money(det.creditSocialSecurityArt91)})${art91.reference ? ` (ref. ${art91.reference})` : ""}`
            : "  Art. 91 Ley 27.467: sin importe cargado",
        "",
        "Determinación del impuesto:",
        `  Saldo técnico a favor del contribuyente del período anterior: ${money(det.previousTechnicalBalance)}${input.settings.previousTechnicalBalanceReference ? ` (ref. ${input.settings.previousTechnicalBalanceReference})` : ""}`,
        `  Saldo de libre disponibilidad del período anterior (neto de usos): ${money(det.previousFreeBalance)}${input.settings.previousFreeBalanceReference ? ` (ref. ${input.settings.previousFreeBalanceReference})` : ""}`,
        "  Retenciones, percepciones y percepciones aduaneras: importar los CSV F2051_* o validar contra las informadas por SIRE/SICORE (no duplicar).",
        "",
        ...(simple && !simple.totals.exportsTotal.isZero()
            ? ["Exportaciones (fuera de la apertura de débito fiscal):", `  Total de comprobantes de exportación: ${money(simple.totals.exportsTotal)}`, ""]
            : []),
        ...(input.settings.creditProrationMode === "GLOBAL" || input.settings.creditProrationMode === "DIRECT_AND_GLOBAL"
            ? [
                "Libro Compras → CF Computable Global (prorrateo):",
                `  Crédito computable con asignación directa: ${money(det.creditDirect)}`,
                `  Crédito computable determinado por prorrateo: ${money(det.creditProrated)}`,
                `  Crédito computable global: ${money(det.creditDirect.plus(det.creditProrated))}`,
                `  Crédito no computable global: ${money(det.globalProrationVat.minus(det.creditProrated))}`,
                "  Crédito computable a restituir: revisar en ARCA (la aplicación no lo determina).",
                "",
            ]
            : []),
        "No previstos por la aplicación (cargar en ARCA si corresponden): pagos a cuenta, crédito fiscal por otros",
        "conceptos (POS, Ley 27.618), ajuste anual del prorrateo, ajustes al débito fiscal por perfeccionamiento del",
        "hecho imponible, débito fiscal por otros conceptos, restituciones de bienes usados.",
        "",
    ].join("\n");

    const leeme = [
        ...head,
        "ORDEN DE IMPORTACIÓN EN EL PORTAL IVA",
        "1. Libro IVA → Ventas: importar LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt con LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS.txt",
        "   («Los Importes están expresados en Pesos Argentinos»). Si hay TurIVA: pestaña Ventas por TURIVA con los *_TURIVA_*.",
        "2. Libro IVA → Compras: importar LIBRO_IVA_DIGITAL_COMPRAS_CBTE.txt con LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS.txt",
        "   (y la pestaña TURIVA si corresponde).",
        "3. Ajustes y otros conceptos → Apertura de otros conceptos: importar cada IVA_SIMPLE_*.csv en su bloque",
        "   (débito fiscal, restitución de débito, crédito fiscal, restitución de crédito).",
        "4. Ajustes al crédito fiscal y determinación: completar los valores de CONCEPTOS_A_CARGAR_EN_ARCA.txt.",
        "5. Retenciones y percepciones: importar F2051_*.csv o validar las precargadas, sin duplicar.",
        "6. Verificar que el saldo del Portal IVA coincida con RESUMEN.txt antes de presentar.",
        "",
        "Esta aplicación no presenta declaraciones ni sube archivos a ARCA.",
        "",
    ].join("\n");

    const entries = [
        ...files.map((f) => ({ name: f.name, data: f.bytes })),
        { name: mode === "DRAFT" ? "BORRADOR_RESUMEN.txt" : "RESUMEN.txt", data: utf8(resumen) },
        { name: mode === "DRAFT" ? "BORRADOR_CONCEPTOS_A_CARGAR_EN_ARCA.txt" : "CONCEPTOS_A_CARGAR_EN_ARCA.txt", data: utf8(manual) },
        { name: mode === "DRAFT" ? "BORRADOR_LEEME.txt" : "LEEME.txt", data: utf8(leeme) },
    ];
    return {
        zip: writeZip(entries, input.generatedAt),
        fileName: packageFileName(identity, mode, input.version),
        files: fileInfo,
        omitted,
        issues,
        reconciliation: rec,
    };
}
