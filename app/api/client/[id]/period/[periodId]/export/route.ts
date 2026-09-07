import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { generateLiquidationExcel } from "@/lib/excel";
import { computeLiquidation } from "@/lib/liquidation-calc";
import { serializeLiquidation } from "@/lib/serializers";

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

        // Cálculo autoritativo único (Decimal) + serialización explícita a string.
        const dto = serializeLiquidation(computeLiquidation(period));

        const excelBuffer = generateLiquidationExcel({
            ...dto,
            period: `${period.month.toString().padStart(2, "0")}/${period.year}`,
            client: period.client.name,
            cuit: period.client.cuit,
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
