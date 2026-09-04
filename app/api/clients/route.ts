import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
    try {
        const clients = await prisma.client.findMany({
            orderBy: { name: "asc" },
        });
        return NextResponse.json(clients);
    } catch (error) {
        console.error("Error fetching clients:", error);
        return NextResponse.json([], { status: 200 });
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
                defaultIibbRate: defaultIibbRate ? parseFloat(defaultIibbRate) : 3.0,
            },
        });

        return NextResponse.json(newClient);
    } catch (error) {
        console.error("Error creating client:", error);
        return NextResponse.json({ error: "Error creating client" }, { status: 500 });
    }
}
