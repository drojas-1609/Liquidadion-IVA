import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildTaxInput } from "@/lib/api-input";
import { serializeTaxRecord } from "@/lib/serializers";

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const parsed = buildTaxInput(body);
        if (!parsed.ok) {
            return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: parsed.status });
        }

        const newTaxRecord = await prisma.taxRecord.create({ data: parsed.data });

        return NextResponse.json(serializeTaxRecord(newTaxRecord));
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: "Error creating tax record" }, { status: 500 });
    }
}
