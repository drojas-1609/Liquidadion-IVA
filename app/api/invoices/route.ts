import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";


export async function POST(request: Request) {
    try {
        const body = await request.json();
        const {
            date,
            type,
            pointOfSale,
            number,
            entityName,
            entityCuit,
            netAmount,
            vatRate,
            vatAmount,
            totalAmount,
            category,
            periodId,
        } = body;

        const newInvoice = await prisma.invoice.create({
            data: {
                date: new Date(date),
                type,
                pointOfSale: parseInt(pointOfSale),
                number: parseInt(number),
                entityName,
                entityCuit,
                netAmount: parseFloat(netAmount),
                vatRate: parseFloat(vatRate),
                vatAmount: parseFloat(vatAmount),
                totalAmount: parseFloat(totalAmount),
                category,
                periodId,
            },
        });

        return NextResponse.json(newInvoice);
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: "Error creating invoice" }, { status: 500 });
    }
}
