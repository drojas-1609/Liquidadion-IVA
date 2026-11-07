# DEV — aplicación de `20261107120000_vat_export_close_versions` (06/11/2026)

**Proyecto:** DEV `esyfpakajthdifhnhcew` (tax-liquidator-dev).

**Coordinación.** Antes de abrir la ventana se avisó a las sesiones de #25/#29 y de #32/#33. Ambas confirmaron que no tenían escrituras ni migraciones en curso.

## Método

Se aplicó por el conector de Supabase, que conecta con el rol `postgres`: el mismo dueño del esquema y de todas las tablas.

En una **única transacción** van:
- el `migration.sql` exacto, con `lock_timeout` de 5 s y `statement_timeout` de 60 s;
- su fila en `_prisma_migrations`, con el checksum sha256 del archivo, como la escribe `prisma migrate deploy`.

No se manejó ninguna cadena de conexión ni ningún secreto.

**Ensayo previo en PostgreSQL 17 local:**
1. Base con las 14 migraciones aplicadas con Prisma.
2. El mismo SQL con `psql`.
3. `prisma migrate status`: al día.
4. `migrate diff` contra el esquema: sin diferencias.

## Datos

| Concepto | Valor |
|---|---|
| Checksum del archivo | `e2f768ad2b81ba05e856fed098e48ae5201dee187875d36188875b8692fc5f73` |
| Id de la fila `_prisma_migrations` | `f4f79fd2-b56d-4084-b458-b8b0e5d80176` |
| Preflight | 14 migraciones, huella `5d50c0ed…31739b77`, sin objetos con los nombres nuevos, 0 sesiones activas |
| Postcheck | 15 migraciones sin logs. Huella nueva `3e9cd2c0ad3aad3a0cfb8ee2ca7f1612ebe08eea1ba4ed267acb358d184885fd`; las 14 previas reproducen `5d50c0ed…` |
| Objetos | 4 enums; 7 restricciones validadas; 5 índices únicos parciales; RLS activo, 0 políticas y sin privilegios para anon, authenticated y service_role |
| Datos | Invoice con 60.107 filas y PeriodVatSettings con 1, mismos hashes que en el preflight (sin las columnas nuevas); 0 filas clasificadas; 0 saldos de libre disponibilidad; 0 versiones |

**Huella.** La fórmula es la del runner:

```sql
encode(sha256(convert_to(string_agg(id||':'||migration_name||':'||checksum,'|' ORDER BY migration_name),'UTF8')),'hex')
```

El runner (`scripts/arca/homologation-runner.ts`) ya exige 15 migraciones y esa huella.

## Vuelta atrás (sólo si se decidiera; destruye únicamente lo nuevo)

```sql
BEGIN;
DROP TABLE "PeriodLiquidationVersion";
ALTER TABLE "TaxRecord" DROP CONSTRAINT "TaxRecord_invoiceId_organizationId_fkey", DROP CONSTRAINT "TaxRecord_f2051_detail_check";
DROP INDEX "TaxRecord_invoice_key", "TaxRecord_retention_certificate_key", "TaxRecord_perception_voucher_key", "TaxRecord_customs_perception_key";
ALTER TABLE "TaxRecord" DROP COLUMN "agentCuit", DROP COLUMN "certificateNumber", DROP COLUMN "customsDocument", DROP COLUMN "intermediaryCuit",
  DROP COLUMN "invoiceId", DROP COLUMN "nature", DROP COLUMN "regimeCode", DROP COLUMN "taxCode", DROP COLUMN "voucherNumber", DROP COLUMN "voucherTypeCode";
ALTER TABLE "PeriodVatSettings" DROP CONSTRAINT "PeriodVatSettings_previousFreeBalance_check", DROP COLUMN "previousFreeBalance", DROP COLUMN "previousFreeBalanceReference";
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_export_classification_check", DROP CONSTRAINT "Invoice_activityCode_check",
  DROP COLUMN "activityCode", DROP COLUMN "buyerType", DROP COLUMN "dationInPayment", DROP COLUMN "purchaseCreditConcept", DROP COLUMN "saleOperationType";
DROP TYPE "SaleOperationType", "BuyerType", "PurchaseCreditConcept", "TaxRecordNature";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261107120000_vat_export_close_versions';
COMMIT;
```

Si ya hay datos en las columnas o en la tabla nuevas, la vuelta atrás los borra: exige autorización explícita.

## Migración 16: `20261108120000_invoice_import_deletions` (DEV, 06/11/2026)

**Qué hace.** Es aditiva: crea una tabla nueva y vacía, `InvoiceImportDeletion`. Al eliminar de la app un comprobante importado, ahí queda la huella SHA-256 de su clave de duplicidad, junto con el tipo, el punto de venta y el número. No guarda datos de la contraparte. No modifica filas ni tablas existentes.

**Claves foráneas:**
- `InvoiceImportDeletion_clientId_organizationId_fkey` hacia `Client`, con ON DELETE CASCADE;
- `InvoiceImportDeletion_deletedById_fkey` hacia `Profile`, con ON DELETE SET NULL.

No tiene clave foránea a `Period`, `Invoice` ni `InvoiceVatLine`.

**Coordinación.** Antes de aplicarla avisé a las sesiones de #25 y #32. Las dos confirmaron que no tenían escrituras ni migraciones en curso en DEV, y a #25 le informé las claves foráneas para su bloque de limpieza.

**Aplicación.** Por el conector de Supabase, en una sola transacción con su fila de `_prisma_migrations`:
- id `75c8dbbc-…`;
- checksum `c48dc828bf60a00e…7878cdd2a63`, el sha256 del archivo.

**Postcheck, sólo lectura:**
- 16 migraciones terminadas;
- RLS activa, sin políticas;
- 0 privilegios para `anon`, `authenticated` y `service_role`;
- 0 filas;
- las dos claves foráneas con CASCADE y SET NULL.

**Huella nueva de DEV:** `a50d425bcd80fd8a…ecb708467a5e`. Está fijada en `scripts/arca/homologation-runner.ts`, con las 16 migraciones, y la prueba `arca-runner-precheck-pg` rechaza el esquema anterior de 15.

**Vuelta atrás.** Sólo si la tabla sigue vacía:

```sql
BEGIN;
DROP TABLE "InvoiceImportDeletion";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261108120000_invoice_import_deletions';
COMMIT;
```

Si la tabla ya tiene filas, la vuelta atrás borra esos registros y una nueva importación volvería a cargar en silencio los comprobantes eliminados. Exige autorización explícita.

## Secuencia propuesta para producción (no ejecutada)

1. Merge a main en orden: #33, #32 y esta rama, cada una con su revisión.
2. PROD tiene la migración del rol Operador; antes, aplicar la de ajustes al crédito (`20261106120000`) con su propio kit y postcheck.
3. Preflight de PROD en solo lectura:
   - lista exacta de migraciones y huella;
   - sesiones activas;
   - hashes de Invoice, TaxRecord y PeriodVatSettings.
4. Ventana sin actividad. Aplicar `20261107120000` y `20261108120000` igual que en DEV: cada una en una transacción con su fila de Prisma, o `prisma migrate deploy` con un kit propio.
5. Postcheck: objetos, RLS y privilegios, hashes de datos sin cambios. Actualizar las constantes del runner de PROD si corresponde.
6. Deploy de producción desde main. Smoke con una organización sintética:
   - clasificar;
   - generar el borrador;
   - cerrar y reabrir un período sintético;
   - descargar la versión final.
7. Primera importación real en el Portal IVA, en revisión conjunta: confirmar la decisión del encabezado de los CSV. **Sin presentar** hasta tu confirmación.
