-- IIBB, base por diferencia: prestadores que facturan varias actividades en un mismo comprobante.
-- Aditiva: dos columnas en ClientIibbProvider (con valor por defecto) y una tabla nueva.
ALTER TABLE "ClientIibbProvider" ADD COLUMN "mode" VARCHAR(12) NOT NULL DEFAULT 'SINGLE';
ALTER TABLE "ClientIibbProvider" ADD COLUMN "rateMap" JSONB;
ALTER TABLE "ClientIibbProvider" ADD CONSTRAINT "ClientIibbProvider_mode_check" CHECK (
  "mode" IN ('SINGLE', 'BY_VAT_RATE', 'MANUAL')
  AND ("rateMap" IS NULL OR ("mode" = 'BY_VAT_RATE' AND jsonb_typeof("rateMap") = 'object'))
);

CREATE TABLE "InvoiceIibbCostSplit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "activityCode" VARCHAR(12) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvoiceIibbCostSplit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InvoiceIibbCostSplit_amount_check" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "InvoiceIibbCostSplit_invoiceId_activityCode_key" ON "InvoiceIibbCostSplit"("invoiceId", "activityCode");
CREATE INDEX "InvoiceIibbCostSplit_organizationId_idx" ON "InvoiceIibbCostSplit"("organizationId");
ALTER TABLE "InvoiceIibbCostSplit" ADD CONSTRAINT "InvoiceIibbCostSplit_invoiceId_organizationId_fkey"
    FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "Invoice"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoiceIibbCostSplit" ENABLE ROW LEVEL SECURITY;
