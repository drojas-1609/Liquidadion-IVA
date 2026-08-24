import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";


export async function GET() {
    try {
        const clients = await prisma.client.findMany({
            orderBy: { name: "asc" },
        });
        return NextResponse.json(clients);
    } catch (error) {
        return NextResponse.json({ error: "Error fetching clients" }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { name, cuit, condition, address, defaultIibbRate } = body;

        const newClient = await prisma.client.create({
            data: {
                name,
                cuit,
                condition,
                address,
                defaultIibbRate: defaultIibbRate ? parseFloat(defaultIibbRate) : undefined,
            },
        });

        return NextResponse.json(newClient);
    } catch (error) {
        return NextResponse.json({ error: "Error creating client" }, { status: 500 });
    }
}
