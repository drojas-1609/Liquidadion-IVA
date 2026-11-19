-- Base de IIBB de las ventas = gravado + neto sin discriminar + no gravado + exento
-- (lib/invoice-model iibbSalesBase; criterio del estudio verificado con la DDJJ
-- F.5680 Santa Cruz 10/2026). Sólo períodos ABIERTOS: los cerrados conservan la
-- base con la que se presentaron.
UPDATE "Invoice" i
SET "grossIncomeTaxBaseAmount" = i."taxedNetAmount" + i."netWithoutVatBreakdownAmount"
    + COALESCE(i."nonTaxedAmount", 0) + COALESCE(i."exemptAmount", 0)
FROM "Period" p
WHERE p."id" = i."periodId"
  AND p."status" = 'OPEN'
  AND i."category" = 'SALES'
  AND i."grossIncomeTaxBaseAmount" IS NOT NULL
  AND i."taxedNetAmount" IS NOT NULL
  AND i."netWithoutVatBreakdownAmount" IS NOT NULL
  AND i."grossIncomeTaxBaseAmount" IS DISTINCT FROM (i."taxedNetAmount" + i."netWithoutVatBreakdownAmount"
    + COALESCE(i."nonTaxedAmount", 0) + COALESCE(i."exemptAmount", 0));
