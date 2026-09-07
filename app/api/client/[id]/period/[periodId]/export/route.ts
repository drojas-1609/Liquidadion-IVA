import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { generateLiquidationExcel } from "@/lib/excel";
import { computeLiquidation } from "@/lib/liquidation-calc";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; periodId: string }> }) {
    const { periodId } = await params;

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

        // Cálculo autoritativo único (lib/liquidation-calc), en Decimal.
        const r = computeLiquidation(period);

        const excelBuffer = generateLiquidationExcel({
            period: `${period.month.toString().padStart(2, "0")}/${period.year}`,
            client: period.client.name,
            cuit: period.client.cuit,
            sales: { net: r.sales.net.toFixed(2), vat: r.sales.vat.toFixed(2), total: r.sales.total.toFixed(2) },
            purchases: {
                net: r.purchases.net.toFixed(2),
                vat: r.purchases.vat.toFixed(2),
                total: r.purchases.total.toFixed(2),
            },
            iva: {
                debit: r.iva.debit.toFixed(2),
                credit: r.iva.credit.toFixed(2),
                balance: r.iva.balance.toFixed(2),
                retentions: r.iva.retentions.toFixed(2),
                payable: r.iva.payable.toFixed(2),
            },
            iibb: {
                rate: r.iibb.rate.toString(),
                tax: r.iibb.tax.toFixed(2),
                retentions: r.iibb.retentions.toFixed(2),
                payable: r.iibb.payable.toFixed(2),
            },
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
