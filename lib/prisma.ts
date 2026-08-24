import { PrismaClient } from '@prisma/client';
import path from 'path';

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "cuit" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "address" TEXT,
    "defaultIibbRate" REAL NOT NULL DEFAULT 3.0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE IF NOT EXISTS "Period" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "month" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,
    CONSTRAINT "Period_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "pointOfSale" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "entityName" TEXT NOT NULL,
    "entityCuit" TEXT NOT NULL,
    "netAmount" REAL NOT NULL,
    "vatRate" REAL NOT NULL,
    "vatAmount" REAL NOT NULL,
    "totalAmount" REAL NOT NULL,
    "category" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    CONSTRAINT "Invoice_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "Period" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "TaxRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "type" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "description" TEXT,
    "periodId" TEXT NOT NULL,
    CONSTRAINT "TaxRecord_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "Period" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "Client_cuit_key" ON "Client"("cuit");
CREATE UNIQUE INDEX IF NOT EXISTS "Period_month_year_clientId_key" ON "Period"("month", "year", "clientId");
CREATE UNIQUE INDEX IF NOT EXISTS "Settings_key_key" ON "Settings"("key");
`;

let isInitialized = false;

const prismaClientSingleton = () => {
  let url = process.env.DATABASE_URL || 'file:./dev.db';

  if (url.startsWith('file:.')) {
    const isServerless = process.env.NETLIFY || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;
    if (isServerless) {
      const dbPath = path.join('/tmp', 'app.db');
      url = `file:${dbPath}`;
    } else {
      const absolutePath = path.resolve(process.cwd(), url.replace('file:', ''));
      url = `file:${absolutePath}`;
    }
  }

  const client = new PrismaClient({
    datasources: {
      db: {
        url,
      },
    },
  });

  if (!isInitialized) {
    isInitialized = true;
    client.$executeRawUnsafe(INIT_SQL).catch((err) => {
      console.error("Prisma init schema error:", err);
    });
  }

  return client;
};

declare global {
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

const prisma = globalThis.prisma ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma;
