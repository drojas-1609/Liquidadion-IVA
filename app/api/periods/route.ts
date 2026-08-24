import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";


export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { clientId, month, year } = body;

        const newPeriod = await prisma.period.create({
            data: {
                clientId,
                month,
                year,
            },
        });

        return NextResponse.json(newPeriod);
    } catch (error) {
        return NextResponse.json({ error: "Error creating period" }, { status: 500 });
    }
}
