BEGIN;
SET LOCAL lock_timeout = '5s';

-- Deducciones de IIBB informadas por el fisco (lib/iibb-import): columnas nuevas,
-- todas opcionales. No cambia ningún registro existente.
ALTER TABLE "TaxRecord"
    ADD COLUMN "importSource"   VARCHAR(40),
    ADD COLUMN "importIdentity" VARCHAR(160),
    ADD COLUMN "agentName"      VARCHAR(200),
    ADD COLUMN "baseAmount"     DECIMAL(18,2),
    ADD COLUMN "voucherKind"    VARCHAR(1),
    ADD COLUMN "voucherLetter"  VARCHAR(1),
    ADD COLUMN "pointOfSale"    VARCHAR(5),
    ADD COLUMN "cbu"            VARCHAR(22),
    ADD COLUMN "bankExtra"      VARCHAR(6);

ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_iibb_deduction_check" CHECK (
    ("voucherKind" IS NULL OR "voucherKind" IN ('F', 'R', 'C', 'D', 'X'))
    AND ("voucherLetter" IS NULL OR "voucherLetter" IN ('A', 'B', 'C', 'M', 'T'))
    AND ("cbu" IS NULL OR "cbu" ~ '^[0-9]{22}$')
    AND ("baseAmount" IS NULL OR "baseAmount" >= 0)
    AND ("importIdentity" IS NULL OR ("importSource" IS NOT NULL AND "jurisdictionCode" IS NOT NULL))
) NOT VALID;
ALTER TABLE "TaxRecord" VALIDATE CONSTRAINT "TaxRecord_iibb_deduction_check";

-- Una deducción informada se registra una sola vez por período y jurisdicción.
CREATE UNIQUE INDEX "TaxRecord_iibb_import_key" ON "TaxRecord"("periodId", "jurisdictionCode", "importIdentity")
    WHERE "importIdentity" IS NOT NULL;
COMMIT;
