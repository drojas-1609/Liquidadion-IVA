import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildInvoiceInput } from "@/lib/api-input";
import { serializeInvoice } from "@/lib/serializers";

export async function POST(request: Request) {
    try {
        const body = await request.json();

        const parsed = buildInvoiceInput(body);
        if (!parsed.ok) {
            return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: parsed.status });
        }

        // vatAmount y totalAmount se recalculan en el servidor (buildInvoiceInput);
        // cualquier valor enviado por el cliente para esos campos se ignora.
        const newInvoice = await prisma.invoice.create({ data: parsed.data });

        return NextResponse.json(serializeInvoice(newInvoice));
    } catch (error) {
        console.error(error);
        return NextResponse.json({ error: "Error creating invoice" }, { status: 500 });
    }
}
