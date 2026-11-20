import "server-only";
import * as XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import type { LiquidationDTO } from "./serializers";
import { ACTIVITY_RATE_NOTE, LIQUIDATION_RATE_NOTE } from "./legacy-iibb-rate";
import { appendDetailSheets, type DetailInvoice, type DetailTaxRecord } from "./excel-detail";

/**
 * Todos los importes entran como STRING decimal (contrato de la app). La
 * conversión a `Number` de JavaScript ocurre ÚNICAMENTE en `toXlsxNumber`,
 * justo antes de armar el array que recibe `XLSX.utils.aoa_to_sheet`.
 *
 * Antes de convertir se verifica que `|valor| * 100 <= Number.MAX_SAFE_INTEGER`
 * (NUMERIC(18,2) admite valores por encima del límite seguro de JS). Si se
 * excede, la exportación FALLA con un mensaje explícito; nunca se trunca ni se
 * exporta un importe inexacto en silencio.
 */

type LiquidationData = LiquidationDTO & {
    period: string;
    client: string;
    cuit: string;
    /** Comprobantes, retenciones y percepciones del período: hojas de detalle y control. */
    detail?: { invoices: DetailInvoice[]; taxRecords: DetailTaxRecord[] };
};

const MAX_SAFE = new Prisma.Decimal(Number.MAX_SAFE_INTEGER);

/** Convierte un string decimal a `number` sólo si es seguro; si no, lanza. */
export function toXlsxNumber(value: string): number {
    let dec: Prisma.Decimal;
    try {
        dec = new Prisma.Decimal(value);
    } catch {
        throw new Error(`Valor no numérico al exportar a XLSX: "${value}"`);
    }
    if (dec.abs().times(100).greaterThan(MAX_SAFE)) {
        throw new Error(
            `Importe fuera del rango seguro de JavaScript para exportar a XLSX: "${value}". ` +
                `La exportación se aborta para no truncar ni alterar el valor.`,
        );
    }
    return dec.toNumber();
}

export const generateLiquidationExcel = (data: LiquidationData) => {
    const wb = XLSX.utils.book_new();
    const n = toXlsxNumber; // conversión a Number sólo en este paso

    const displayData = [
        ["Liquidación de Impuestos Mensual"],
        ["Cliente:", data.client],
        ["CUIT:", data.cuit],
        ["Periodo:", data.period],
        [],
        ["RESUMEN IVA"],
        ["Concepto", "Importe"],
        ["Total del débito fiscal del período", n(data.iva.debit)],
        ["Crédito fiscal por compras", n(data.iva.creditPurchases)],
        ["Crédito Fiscal por Contribuciones a la Seguridad Social - Anexo I Ley 27.541", n(data.iva.creditSocialSecurityAnnexI)],
        ["Crédito Fiscal por Contribuciones a la Seguridad Social - Art. 91 Ley 27.467", n(data.iva.creditSocialSecurityArt91)],
        ["Total del crédito fiscal del período", n(data.iva.credit)],
        ["Saldo técnico a favor del contribuyente del período anterior", n(data.iva.previousTechnicalBalance)],
        ["Saldo técnico a favor de ARCA", n(data.iva.technicalBalanceArca)],
        ["Saldo técnico a favor del contribuyente", n(data.iva.technicalBalanceInFavor)],
        ["Saldo a favor de libre disponibilidad del período anterior", n(data.iva.previousFreeBalance)],
        ["Retenciones IVA", n(data.iva.withholdings)],
        ["Percepciones IVA", n(data.iva.perceptions)],
        ["Percepciones aduaneras IVA", n(data.iva.customsPerceptions)],
        ["Saldo a Pagar / (A Favor, libre disponibilidad) IVA", n(data.iva.payable)],
        [],
        ["RESUMEN IIBB (estructura de la DDJJ)"],
        ["Concepto", "Importe"],
        ["Base Imponible IIBB", n(data.iibb.base)],
        [`Impuesto Determinado (${data.iibb.rate}%)`, n(data.iibb.tax), data.iibb.byActivity ? ACTIVITY_RATE_NOTE : LIQUIDATION_RATE_NOTE],
        ...(data.iibb.byActivity ?? []).map((l) => [
            `   Actividad ${l.code ?? "sin asignar"} · ${l.description} (base ${l.base} × ${l.rate}%)`,
            n(l.tax),
            l.rateSource === "FALLBACK" ? "Sin alícuota informada: se usó la alícuota de respaldo" : l.rateSource === "EXEMPT" ? "Exenta" : "",
        ]),
        ...(data.iibb.warnings ?? []).map((w) => ["   Advertencia", "", w]),
        ["Saldo a favor de períodos anteriores", n(data.iibb.previousBalance)],
        ["Total de retenciones", n(data.iibb.withholdings), "Retenciones de IIBB y SIRTAC"],
        ["Total de percepciones aduaneras", n(data.iibb.customsPerceptions)],
        ["Total de percepciones", n(data.iibb.perceptions)],
        ["Total de recaudaciones bancarias", n(data.iibb.bankCollections), "SIRCREB"],
        ["Total de pagos a cuenta", n(data.iibb.paymentsOnAccount)],
        ["Otros créditos", n(data.iibb.otherCredits)],
        ["Otros débitos", n(data.iibb.otherDebits)],
        ["Total Deducciones", n(data.iibb.totalDeductions)],
        ["Saldo a Favor de DGR", n(data.iibb.balanceDgr)],
        ["Saldo a Favor del Contribuyente", n(data.iibb.balanceTaxpayer)],
        ["Retenciones/Percepciones IIBB (todas las jurisdicciones)", n(new Prisma.Decimal(data.iibb.retentions).plus(data.iibb.excludedOtherJurisdictions).toFixed(2)),
            "Incluye deducciones de otras jurisdicciones no computadas en esta DDJJ: " + data.iibb.excludedOtherJurisdictions],
    ];

    const ws = XLSX.utils.aoa_to_sheet(displayData);
    ws["!cols"] = [{ wch: 75 }, { wch: 20 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws, "Liquidacion");

    if (data.detail) {
        // Celda (columna B) de cada importe de la hoja «Liquidacion» que cruza «Control».
        const rowOf = (label: string) => {
            const i = displayData.findIndex((row) => row[0] === label || (typeof row[0] === "string" && row[0].startsWith(label)));
            return i < 0 ? undefined : `B${i + 1}`;
        };
        appendDetailSheets(wb, {
            invoices: data.detail.invoices,
            taxRecords: data.detail.taxRecords,
            totals: {
                salesTotal: data.sales.total,
                purchasesTotal: data.purchases.total,
                debit: data.iva.debit,
                creditDirect: data.iva.creditDirect,
                creditProrated: data.iva.creditProrated,
                iibbBase: data.iibb.base,
                ivaWithholdings: data.iva.withholdings,
                ivaPerceptions: new Prisma.Decimal(data.iva.perceptions).plus(data.iva.customsPerceptions).toFixed(2),
                iibbRetentions: new Prisma.Decimal(data.iibb.retentions).plus(data.iibb.excludedOtherJurisdictions).toFixed(2),
            },
        }, {
            debit: rowOf("Total del débito fiscal del período"),
            iibbBase: rowOf("Base Imponible IIBB"),
            ivaWithholdings: rowOf("Retenciones IVA"),
            iibbRetentions: rowOf("Retenciones/Percepciones IIBB"),
        }, n);
    }

    const excelBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer", compression: true });
    return excelBuffer;
};
