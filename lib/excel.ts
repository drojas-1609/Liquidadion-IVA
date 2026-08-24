import * as XLSX from "xlsx";

interface LiquidationData {
    period: string;
    client: string;
    cuit: string;
    sales: {
        net: number;
        vat: number;
        total: number;
    };
    purchases: {
        net: number;
        vat: number;
        total: number;
    };
    iva: {
        debit: number;
        credit: number;
        balance: number;
        retentions: number;
        payable: number;
    };
    iibb: {
        rate: number;
        tax: number;
        retentions: number;
        payable: number;
    };
}

export const generateLiquidationExcel = (data: LiquidationData) => {
    const wb = XLSX.utils.book_new();

    // Create formatted data for the sheet
    const displayData = [
        ["Liquidación de Impuestos Mensual"],
        ["Cliente:", data.client],
        ["CUIT:", data.cuit],
        ["Periodo:", data.period],
        [],
        ["RESUMEN IVA"],
        ["Concepto", "Importe"],
        ["Débito Fiscal (Ventas)", data.iva.debit],
        ["Crédito Fiscal (Compras)", data.iva.credit],
        ["Saldo Técnico", data.iva.balance],
        ["Retenciones/Percepciones IVA", data.iva.retentions],
        ["Saldo a Pagar / (A Favor) IVA", data.iva.payable],
        [],
        ["RESUMEN IIBB"],
        ["Concepto", "Importe"],
        ["Base Imponible (Ventas Netas)", data.sales.net],
        [`Impuesto Determinado (${data.iibb.rate}%)`, data.iibb.tax],
        ["Retenciones/Percepciones IIBB", data.iibb.retentions],
        ["Saldo a Pagar / (A Favor) IIBB", data.iibb.payable],
    ];

    const ws = XLSX.utils.aoa_to_sheet(displayData);

    // Styling (basic width adjustments)
    const wscols = [{ wch: 40 }, { wch: 20 }];
    ws["!cols"] = wscols;

    XLSX.utils.book_append_sheet(wb, ws, "Liquidacion");

    // Write to buffer
    const excelBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    return excelBuffer;
};
