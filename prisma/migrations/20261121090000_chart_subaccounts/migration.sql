-- Fase N3: subcuentas del plan de cuentas («C.RR.CC.SS.NN», p. ej. un banco por cuenta corriente).
-- La cuenta de cuatro niveles puede pasar a agrupar subcuentas (no imputable); las subcuentas son siempre imputables.
ALTER TABLE "ChartAccount" DROP CONSTRAINT "ChartAccount_code_check";
ALTER TABLE "ChartAccount" ADD CONSTRAINT "ChartAccount_code_check" CHECK ("code" ~ '^[1-5](\.[0-9]{2}(\.[0-9]{2}\.[0-9]{2}(\.[0-9]{2})?)?)?$');
ALTER TABLE "ChartAccount" DROP CONSTRAINT "ChartAccount_imputable_check";
ALTER TABLE "ChartAccount" ADD CONSTRAINT "ChartAccount_imputable_check" CHECK (
    ("code" ~ '^[1-5]\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$' AND "imputable")
    OR ("code" ~ '^[1-5]\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$')
    OR ("code" ~ '^[1-5](\.[0-9]{2})?$' AND NOT "imputable")
);
