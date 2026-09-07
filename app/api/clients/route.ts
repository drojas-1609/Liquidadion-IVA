import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildClientInput } from "@/lib/api-input";
import { serializeClient } from "@/lib/serializers";

export async function GET() {
    try {
        const clients = await prisma.client.findMany({
            orderBy: { name: "asc" },
        });
        return NextResponse.json(clients.map(serializeClient));
    } catch (error) {
        console.error("Error fetching clients:", error);
        return NextResponse.json([], { status: 200 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const parsed = buildClientInput(body);
        if (!parsed.ok) {
            return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: parsed.status });
        }

        const newClient = await prisma.client.create({ data: parsed.data });

        return NextResponse.json(serializeClient(newClient));
    } catch (error) {
        console.error("Error creating client:", error);
        return NextResponse.json({ error: "Error creating client" }, { status: 500 });
    }
}
