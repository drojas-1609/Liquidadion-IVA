-- Convierte los campos monetarios y de alícuota de DOUBLE PRECISION a NUMERIC
-- exacto. `USING ROUND(...)` redondea de forma defensiva cualquier dato
-- preexistente a la escala destino (evita error de escala y evita truncado
-- impredecible). Con las tablas vacías es un no-op, pero deja la conversión
-- correcta para cualquier entorno con datos.
--
-- No modifica `0_init`. Las consultas de preflight y post-verificación NO van
-- aquí: ver `docs/decimal-migration/verify.sql`.

-- AlterTable
ALTER TABLE "Client"
  ALTER COLUMN "defaultIibbRate" SET DATA TYPE DECIMAL(9,6) USING ROUND("defaultIibbRate"::numeric, 6),
  ALTER COLUMN "defaultIibbRate" SET DEFAULT 3.000000;

-- AlterTable
ALTER TABLE "Invoice"
  ALTER COLUMN "netAmount"   SET DATA TYPE DECIMAL(18,2) USING ROUND("netAmount"::numeric, 2),
  ALTER COLUMN "vatRate"     SET DATA TYPE DECIMAL(9,6)  USING ROUND("vatRate"::numeric, 6),
  ALTER COLUMN "vatAmount"   SET DATA TYPE DECIMAL(18,2) USING ROUND("vatAmount"::numeric, 2),
  ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(18,2) USING ROUND("totalAmount"::numeric, 2);

-- AlterTable
ALTER TABLE "TaxRecord"
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(18,2) USING ROUND("amount"::numeric, 2);
