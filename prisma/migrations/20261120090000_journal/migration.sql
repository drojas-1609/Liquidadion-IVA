-- Fase C2b: libro diario (asientos automáticos de IVA, IIBB y pagos de impuestos).
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "periodId" TEXT,
    "sourceKey" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "updatedById" UUID,
    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JournalEntry_number_check" CHECK ("number" > 0),
    CONSTRAINT "JournalEntry_kind_check" CHECK ("kind" IN ('VAT_POSITION', 'IIBB_POSITION', 'TAX_PAYMENT'))
);

CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "debit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "memo" VARCHAR(200),
    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JournalLine_amounts_check" CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0) <> ("credit" > 0)))
);

CREATE UNIQUE INDEX "JournalEntry_clientId_number_key" ON "JournalEntry"("clientId", "number");
CREATE UNIQUE INDEX "JournalEntry_clientId_sourceKey_key" ON "JournalEntry"("clientId", "sourceKey");
CREATE INDEX "JournalEntry_clientId_organizationId_date_idx" ON "JournalEntry"("clientId", "organizationId", "date");
CREATE INDEX "JournalEntry_organizationId_idx" ON "JournalEntry"("organizationId");
CREATE UNIQUE INDEX "JournalLine_entryId_position_key" ON "JournalLine"("entryId", "position");
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");
CREATE INDEX "JournalLine_organizationId_idx" ON "JournalLine"("organizationId");

ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_clientId_organizationId_fkey"
    FOREIGN KEY ("clientId", "organizationId") REFERENCES "Client"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey"
    FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "ChartAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "JournalEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JournalLine" ENABLE ROW LEVEL SECURITY;
