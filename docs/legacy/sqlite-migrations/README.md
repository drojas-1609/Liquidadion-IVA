# Migraciones legacy (prototipo SQLite)

Este directorio conserva la historia de migraciones de Prisma que se usó
mientras el proyecto corría sobre **SQLite**. Se mueve aquí como antecedente
histórico y **no forma parte de ninguna secuencia activa de migraciones**.

## Contenido

- `20251205211458_add_iibb_rate/migration.sql` — baseline del esquema sobre
  SQLite (crea `Client`, `Period`, `Invoice`, `TaxRecord`, `Settings` con
  tipos y sintaxis propios de SQLite: `TEXT PRIMARY KEY`, `DATETIME`, `REAL`,
  `DEFAULT CURRENT_TIMESTAMP`, claves foráneas inline).
- `migration_lock.toml` — lock file de Prisma que fijaba `provider = "sqlite"`.

## Estado

- Corresponde al **prototipo SQLite**, previo a la migración a PostgreSQL.
- **No debe ejecutarse contra PostgreSQL**: la sintaxis y los tipos no son
  compatibles.
- Fue **reemplazada por la línea base Prisma para PostgreSQL**, en
  `prisma/migrations/0_init/migration.sql` (base alojada en Supabase).
- Se conserva **únicamente como referencia histórica**. No la borres ni la
  reactives; si necesitás el detalle del esquema original, este es el registro.

## Por qué se movió

Prisma trata cualquier carpeta bajo `prisma/migrations/` como parte de la
secuencia activa. Estos archivos son de SQLite y no deben mezclarse con la
secuencia PostgreSQL. Moverlos fuera de `prisma/migrations/` evita que las
herramientas de Prisma los interpreten como migraciones PostgreSQL válidas,
sin perder el historial (que además queda en el historial de Git).
