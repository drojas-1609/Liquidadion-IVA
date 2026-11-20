-- Fase N4: categoría CONSTANCIAS (constancia de inscripción de ARCA) en los respaldos de Drive.
ALTER TABLE "DocumentBackup" DROP CONSTRAINT "DocumentBackup_category_check";
ALTER TABLE "DocumentBackup" ADD CONSTRAINT "DocumentBackup_category_check" CHECK ("category" IN ('IVA_VENTAS', 'IVA_COMPRAS', 'IVA_RET_PERC', 'IVA_DDJJ', 'IIBB_RET_PERC', 'IIBB_DDJJ', 'BANCOS', 'SUELDOS', 'CONTABILIDAD', 'CONSTANCIAS'));
