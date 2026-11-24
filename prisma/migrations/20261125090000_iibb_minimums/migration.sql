-- IIBB F2: impuesto mínimo mensual por actividad (ficha y año fiscal).
ALTER TABLE "ClientActivityRate" ADD COLUMN "minimumAmount" DECIMAL(18,2);
ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "ClientActivityRate_minimum_check" CHECK ("minimumAmount" IS NULL OR ("minimumAmount" >= 0 AND "treatment" = 'RATE'));
ALTER TABLE "ClientIibbRateYear" ADD COLUMN "minimumAmount" DECIMAL(18,2);
ALTER TABLE "ClientIibbRateYear" ADD CONSTRAINT "ClientIibbRateYear_minimum_check" CHECK ("minimumAmount" IS NULL OR ("minimumAmount" >= 0 AND "treatment" = 'RATE'));
