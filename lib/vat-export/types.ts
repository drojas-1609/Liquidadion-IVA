import type { Prisma } from "@prisma/client";

/**
 * Datos de entrada de los exportadores (lógica pura, sin base). Los importes
 * son SIEMPRE positivos y en pesos; el signo contable sale sólo del código del
 * comprobante (lib/invoice-model voucherSign).
 */

export type ExportCategory = "SALES" | "PURCHASES";
export type ExportCreditAllocation = "NOT_APPLICABLE" | "DIRECT_COMPUTABLE" | "DIRECT_NON_COMPUTABLE" | "GLOBAL_PRORATION";

export interface ExportVatLine {
    vatRateCode: number;
    netAmount: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    creditAllocation: ExportCreditAllocation | string;
    computableVatAmount: Prisma.Decimal | null;
}

/** Comprobante modelado (voucherCode no nulo) tal como lo necesitan los archivos. */
export interface ExportInvoice {
    id: string;
    category: ExportCategory | string;
    voucherCode: number | null;
    pointOfSale: number;
    number: number;
    numberTo: number | null;
    /** AAAA-MM-DD. */
    voucherDate: string | null;
    counterpartyDocType: number | null;
    counterpartyDocNumber: string | null;
    counterpartyName: string | null;
    counterpartyVatConditionCode: number | null;
    currencyCode: string | null;
    exchangeRate: Prisma.Decimal | null;
    taxedNetAmount: Prisma.Decimal | null;
    totalVatAmount: Prisma.Decimal | null;
    directComputableVatCreditAmount: Prisma.Decimal | null;
    netWithoutVatBreakdownAmount: Prisma.Decimal | null;
    nonTaxedAmount: Prisma.Decimal | null;
    exemptAmount: Prisma.Decimal | null;
    vatPerceptionAmount: Prisma.Decimal | null;
    nationalPerceptionAmount: Prisma.Decimal | null;
    iibbPerceptionAmount: Prisma.Decimal | null;
    municipalPerceptionAmount: Prisma.Decimal | null;
    internalTaxesAmount: Prisma.Decimal | null;
    otherTaxesAmount: Prisma.Decimal | null;
    voucherTotalAmount: Prisma.Decimal | null;
    turivaRefundAmount: Prisma.Decimal | null;
    lidSection: "GENERAL" | "TURIVA" | string;
    operationCode: string | null;
    activityCode: string | null;
    saleOperationType: "GOODS_SERVICES" | "CAPITAL_GOODS" | string | null;
    buyerType: "RESPONSABLE_INSCRIPTO" | "MONOTRIBUTO" | "CONSUMIDOR_FINAL_EXENTO_NO_ALCANZADO" | string | null;
    purchaseCreditConcept: "GOODS" | "LEASES" | "SERVICES" | "CAPITAL_GOODS" | string | null;
    dationInPayment: boolean;
    vatLines: ExportVatLine[];
}

export interface ExportTaxRecord {
    id: string;
    /** AAAA-MM-DD. */
    date: string;
    type: string;
    amount: Prisma.Decimal;
    nature: "RETENTION" | "PERCEPTION" | "CUSTOMS_PERCEPTION" | string | null;
    taxCode: number | null;
    regimeCode: number | null;
    agentCuit: string | null;
    intermediaryCuit: string | null;
    voucherTypeCode: number | null;
    voucherNumber: string | null;
    certificateNumber: string | null;
    customsDocument: string | null;
    invoiceId: string | null;
}

export interface ExportSettings {
    creditProrationMode: "NONE" | "DIRECT" | "GLOBAL" | "DIRECT_AND_GLOBAL" | string;
    turivaIncluded: boolean;
}

/** Un archivo del paquete. */
export interface ExportFile {
    name: string;
    bytes: Uint8Array;
    /** Registros (líneas de datos) que contiene. */
    records: number;
}

/** Archivo que corresponde al período pero no se genera, con su motivo. */
export interface OmittedFile {
    name: string;
    reason: string;
}
