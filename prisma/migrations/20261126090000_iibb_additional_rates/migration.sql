-- IIBB: alícuota adicional por actividad que se liquida aparte (p. ej. FFSS de Tierra del Fuego).
-- Aditiva: dos columnas nulas por tabla y un CHECK de consistencia. No modifica datos existentes.
ALTER TABLE "ClientActivityRate" ADD COLUMN "additionalLabel" VARCHAR(10);
ALTER TABLE "ClientActivityRate" ADD COLUMN "additionalRate" DECIMAL(9,6);
ALTER TABLE "ClientActivityRate" ADD CONSTRAINT "ClientActivityRate_additional_check" CHECK (
  ("additionalLabel" IS NULL AND "additionalRate" IS NULL)
  OR ("additionalLabel" ~ '^[A-Z]{2,10}$' AND "additionalRate" > 0 AND "additionalRate" <= 100 AND "treatment" = 'RATE')
);
ALTER TABLE "ClientIibbRateYear" ADD COLUMN "additionalLabel" VARCHAR(10);
ALTER TABLE "ClientIibbRateYear" ADD COLUMN "additionalRate" DECIMAL(9,6);
ALTER TABLE "ClientIibbRateYear" ADD CONSTRAINT "ClientIibbRateYear_additional_check" CHECK (
  ("additionalLabel" IS NULL AND "additionalRate" IS NULL)
  OR ("additionalLabel" ~ '^[A-Z]{2,10}$' AND "additionalRate" > 0 AND "additionalRate" <= 100 AND "treatment" = 'RATE')
);
