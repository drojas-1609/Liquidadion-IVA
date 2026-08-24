import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { generateLiquidationExcel } from "@/lib/excel";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; periodId: string; }> }) {
    const { id, periodId } = await params;

    try {
        const period = await prisma.period.findUnique({
            where: { id: periodId },
            include: {
                invoices: true,
                taxRecords: true,
                client: true,
            },
        });

        if (!period) {
            return new NextResponse("Period not found", { status: 404 });
        }

        // Calculation Logic (Replicated for Report)
        const sales = period.invoices.filter((i: any) => i.category === "SALES");
        const purchases = period.invoices.filter((i: any) => i.category === "PURCHASES");

        const totalSalesNet = sales.reduce((acc: number, curr: any) => acc + curr.netAmount, 0);
        const totalSalesVAT = sales.reduce((acc: number, curr: any) => acc + curr.vatAmount, 0);
        const totalSales = sales.reduce((acc: number, curr: any) => acc + curr.totalAmount, 0);

        const totalPurchasesNet = purchases.reduce((acc: number, curr: any) => acc + curr.netAmount, 0);
        const totalPurchasesVAT = purchases.reduce((acc: number, curr: any) => acc + curr.vatAmount, 0);
        const totalPurchases = purchases.reduce((acc: number, curr: any) => acc + curr.totalAmount, 0);

        const ivaDebit = totalSalesVAT;
        const ivaCredit = totalPurchasesVAT;
        const ivaTechnicalBalance = ivaDebit - ivaCredit;

        const ivaRetentions = period.taxRecords
            .filter((t: any) => t.type.includes("IVA"))
            .reduce((acc: number, curr: any) => acc + curr.amount, 0);

        const ivaPayable = ivaTechnicalBalance - ivaRetentions;

        const iibbRate = period.client.defaultIibbRate || 3.0;
        const iibbTax = totalSalesNet * (iibbRate / 100);

        const iibbRetentions = period.taxRecords
            .filter((t: any) => t.type.includes("IIBB") || t.type === "SIRCREB" || t.type === "SIRTAC")
            .reduce((acc: number, curr: any) => acc + curr.amount, 0);

        const iibbPayable = iibbTax - iibbRetentions;

        const excelBuffer = generateLiquidationExcel({
            period: `${period.month.toString().padStart(2, "0")}/${period.year}`,
            client: period.client.name,
            cuit: period.client.cuit,
            sales: { net: totalSalesNet, vat: totalSalesVAT, total: totalSales },
            purchases: { net: totalPurchasesNet, vat: totalPurchasesVAT, total: totalPurchases },
            iva: { debit: ivaDebit, credit: ivaCredit, balance: ivaTechnicalBalance, retentions: ivaRetentions, payable: ivaPayable },
            iibb: { rate: iibbRate, tax: iibbTax, retentions: iibbRetentions, payable: iibbPayable },
        });

        return new NextResponse(excelBuffer, {
            headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename=Liquidacion_${period.client.name.replace(/\s+/g, "_")}_${period.month}_${period.year}.xlsx`,
            },
        });
    } catch (error) {
        console.error("Error generating Excel:", error);
        return new NextResponse("Internal Server Error", { status: 500 });
    }
}