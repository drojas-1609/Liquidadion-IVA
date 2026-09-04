-- Línea base PostgreSQL para Netlify Database.
--
-- Representa el esquema actual de prisma/schema.prisma sin cambios de modelo
-- ni de tipo (Prisma `Float` -> PostgreSQL `DOUBLE PRECISION`; la migración a
-- `Decimal` es una tarea posterior).
--
-- Generado offline (sin conexión a ninguna base) con:
--   npx prisma migrate diff \
--     --from-empty \
--     --to-schema-datamodel prisma/schema.prisma \
--     --script
-- y revisado manualmente antes de incorporarlo.
--
-- Crea: Client, Period, Invoice, TaxRecord, Settings, sus relaciones,
-- claves únicas e índices tal como están definidos hoy.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cuit" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "address" TEXT,
    "defaultIibbRate" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Period" (
    "id" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,

    CONSTRAINT "Period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "pointOfSale" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityCuit" TEXT NOT NULL,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "vatRate" DOUBLE PRECISION NOT NULL,
    "vatAmount" DOUBLE PRECISION NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "category" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRecord" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT,
    "periodId" TEXT NOT NULL,

    CONSTRAINT "TaxRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_cuit_key" ON "Client"("cuit");

-- CreateIndex
CREATE UNIQUE INDEX "Period_month_year_clientId_key" ON "Period"("month", "year", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Settings_key_key" ON "Settings"("key");

-- AddForeignKey
ALTER TABLE "Period" ADD CONSTRAINT "Period_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "Period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "Period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
