import { NextResponse } from "next/server";
import prisma, { ensureDb } from "@/lib/prisma";

export async function POST() {
  try {
    await ensureDb();

    // Check if Robinson S.A. already exists
    let client = await prisma.client.findFirst({
      where: { cuit: "30-71123456-8" },
    });

    if (!client) {
      client = await prisma.client.create({
        data: {
          name: "ROBINSON S.A.",
          cuit: "30-71123456-8",
          condition: "Responsable Inscripto",
          address: "Av. Corrientes 1234, CABA",
          defaultIibbRate: 3.0,
        },
      });
    }

    // Check or create period 11/2025
    let period = await prisma.period.findFirst({
      where: { clientId: client.id, month: 11, year: 2025 },
    });

    if (!period) {
      period = await prisma.period.create({
        data: {
          clientId: client.id,
          month: 11,
          year: 2025,
        },
      });

      // Sample Sales
      await prisma.invoice.createMany({
        data: [
          {
            date: new Date("2025-11-05"),
            type: "FC A",
            pointOfSale: 1,
            number: 1001,
            entityName: "Cliente Ejemplo SRL",
            entityCuit: "30-99999999-1",
            netAmount: 1500000.0,
            vatRate: 21.0,
            vatAmount: 315000.0,
            totalAmount: 1815000.0,
            category: "SALES",
            periodId: period.id,
          },
        ],
      });

      // Sample Purchases
      await prisma.invoice.createMany({
        data: [
          {
            date: new Date("2025-11-10"),
            type: "FC A",
            pointOfSale: 2,
            number: 5432,
            entityName: "Proveedor Insumos SA",
            entityCuit: "30-88888888-2",
            netAmount: 800000.0,
            vatRate: 21.0,
            vatAmount: 168000.0,
            totalAmount: 968000.0,
            category: "PURCHASES",
            periodId: period.id,
          },
        ],
      });

      // Sample Withholdings
      await prisma.taxRecord.createMany({
        data: [
          {
            date: new Date("2025-11-15"),
            type: "RETENCION IVA",
            amount: 25000.0,
            description: "Retención IVA Banco Galicia",
            periodId: period.id,
          },
          {
            date: new Date("2025-11-20"),
            type: "SIRCREB",
            amount: 15000.0,
            description: "Retención SIRCREB CABA",
            periodId: period.id,
          },
        ],
      });
    }

    return NextResponse.json({ success: true, client });
  } catch (error) {
    console.error("Error seeding demo client:", error);
    return NextResponse.json({ error: "Error seeding data" }, { status: 500 });
  }
}
