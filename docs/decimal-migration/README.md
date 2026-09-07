# Migración `20260907213357_float_to_decimal`

Convierte los campos `DOUBLE PRECISION` a `NUMERIC` exacto (Tarea 2).

| Columna | Tipo destino |
|---|---|
| `Client.defaultIibbRate` | `NUMERIC(9,6)`, `DEFAULT 3.000000` |
| `Invoice.netAmount` | `NUMERIC(18,2)` |
| `Invoice.vatRate` | `NUMERIC(9,6)` |
| `Invoice.vatAmount` | `NUMERIC(18,2)` |
| `Invoice.totalAmount` | `NUMERIC(18,2)` |
| `TaxRecord.amount` | `NUMERIC(18,2)` |

## Estado

**NO aplicada.** Queda pendiente de revisión y autorización humana. No se corrió
`prisma migrate deploy` ni `prisma db push` contra ninguna base.

## Contenido

- `prisma/migrations/20260907213357_float_to_decimal/migration.sql` — **solo el
  DDL de conversión**. Usa `USING ROUND(col::numeric, escala)` como redondeo
  defensivo de datos preexistentes (con las tablas vacías es un no-op).
- `docs/decimal-migration/verify.sql` — consultas de **preflight** y
  **post-verificación**, solo lectura, para correr a mano. No forman parte de
  `migration.sql` ni se ejecutan automáticamente.

## Procedimiento propuesto (cuando se autorice)

1. Correr las consultas de *preflight* de `verify.sql` contra la base destino
   (dev/preview) — confirmar 0 filas o, si hubiera datos, que ninguna pierde
   precisión al redondear.
2. `npx prisma migrate deploy` (usa `DIRECT_URL`).
3. Correr las consultas de *post-verificación* de `verify.sql`.
4. Confirmar `_prisma_migrations` con `0_init` + `20260907213357_float_to_decimal`,
   ambas `finished`, sin `rolled_back_at`.

## Rollback

Recrear la base de desarrollo/preview desde cero (no tiene datos reales) y
reaplicar `0_init`. No hay downgrade automático de `NUMERIC` a `DOUBLE
PRECISION` incluido a propósito: si se necesitara, sería otra migración
incremental explícita.
