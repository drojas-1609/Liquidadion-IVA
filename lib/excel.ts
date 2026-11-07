import "server-only";
import * as XLSX from "xlsx";
import { Prisma } from "@prisma/client";
import type { LiquidationDTO } from "./serializers";
import { LIQUIDATION_RATE_NOTE } from "./legacy-iibb-rate";

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
        ["RESUMEN IIBB"],
        ["Concepto", "Importe"],
        ["Base Imponible IIBB", n(data.iibb.base)],
        [`Impuesto Determinado (${data.iibb.rate}%)`, n(data.iibb.tax), LIQUIDATION_RATE_NOTE],
        ["Retenciones/Percepciones IIBB", n(data.iibb.retentions)],
        ["Saldo a Pagar / (A Favor) IIBB", n(data.iibb.payable)],
    ];

    const ws = XLSX.utils.aoa_to_sheet(displayData);
    ws["!cols"] = [{ wch: 75 }, { wch: 20 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws, "Liquidacion");

    const excelBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    return excelBuffer;
};
