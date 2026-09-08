import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
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

// Tarea 3A (temporal, hasta 3B): `Client.organizationId` pasó a ser
// obligatorio. El alta de cliente necesita la organización del usuario
// autenticado, que recién se resuelve en la Tarea 3B (capa de autorización).
// Hasta entonces esta operación queda deshabilitada de forma explícita
// (fail closed):
//   - responde 501 SIEMPRE;
//   - NO lee el body de la request => cualquier `organizationId` u otro campo
//     enviado por el cliente se ignora por completo;
//   - NO ejecuta ninguna escritura (no toca Prisma).
export async function POST() {
    return NextResponse.json(
        {
            error:
                "El alta de clientes estará disponible al completar la autenticación y autorización (Tarea 3B).",
        },
        { status: 501, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
}
