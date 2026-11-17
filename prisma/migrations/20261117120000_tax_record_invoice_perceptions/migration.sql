-- Percepciones tomadas de los comprobantes de compra (IVA e IIBB).
-- Columnas nuevas opcionales: no cambia ningún registro existente.
ALTER TABLE "TaxRecord" ADD COLUMN "fromInvoice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TaxRecord" ADD COLUMN "jurisdictionCode" VARCHAR(3);

-- Antes: a lo sumo un registro por comprobante. Ahora: uno por comprobante y
-- tipo (percepción de IVA y percepción de IIBB del mismo comprobante).
DROP INDEX "TaxRecord_invoice_key";
CREATE UNIQUE INDEX "TaxRecord_invoice_type_key" ON "TaxRecord"("invoiceId", "type") WHERE "invoiceId" IS NOT NULL;
