import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";


export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { date, type, amount, description, periodId } = body;

        const newTaxRecord = await prisma.taxRecord.create({
            data: {
                date: new Date(date),
                type,
                amount: parseFloat(amount),
                description,
                periodId,
            },
        });

        return NextResponse.json(newTaxRecord);
    } catch (error) {
        return NextResponse.json({ error: "Error creating tax record" }, { status: 500 });
    }
}
