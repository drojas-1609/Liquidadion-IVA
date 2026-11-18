BEGIN;
SET LOCAL lock_timeout = '5s';

-- La percepción de IIBB tomada de un comprobante de compra también se vincula a
-- él (lib/invoice-perceptions). Antes sólo la percepción de IVA podía tener
-- invoiceId. Misma restricción, con esa única ampliación; no cambia registros.
ALTER TABLE "TaxRecord" DROP CONSTRAINT "TaxRecord_f2051_detail_check";
ALTER TABLE "TaxRecord" ADD CONSTRAINT "TaxRecord_f2051_detail_check" CHECK (
    ("agentCuit" IS NULL OR "agentCuit" ~ '^[0-9]{11}$')
    AND ("intermediaryCuit" IS NULL OR "intermediaryCuit" ~ '^[0-9]{11}$')
    AND ("regimeCode" IS NULL OR "regimeCode" > 0)
    AND ("taxCode" IS NULL OR "taxCode" IN (767, 216))
    AND ("nature" IS NULL OR "type" IN ('RETENCION IVA', 'PERCEPCION IVA'))
    AND ("nature" IS DISTINCT FROM 'RETENTION' OR "type" = 'RETENCION IVA')
    AND ("nature" IS NULL OR "nature" = 'RETENTION' OR "type" = 'PERCEPCION IVA')
    AND ("invoiceId" IS NULL OR "nature" = 'PERCEPTION' OR "type" = 'PERCEPCION IIBB')
) NOT VALID;
ALTER TABLE "TaxRecord" VALIDATE CONSTRAINT "TaxRecord_f2051_detail_check";
COMMIT;
