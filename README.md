# Dero Company — Liquidador de IVA e IIBB

Aplicación Next.js (App Router) para liquidación de IVA e IIBB.

- **Frontend:** Next.js desplegado en **Netlify**.
- **Base de datos:** **PostgreSQL alojado en Supabase** (proyecto `tax-liquidator`).
- **ORM:** **Prisma**, con `prisma/schema.prisma` como definición tipada del
  modelo y `prisma/migrations/` como historia de migraciones.

## Stack

- Next.js 16 (App Router, Turbopack)
- React 19
- Prisma 6 (`@prisma/client`) sobre PostgreSQL
- PostgreSQL 17 en Supabase; pooling de conexiones con **Supavisor**

## Requisitos

- Node.js 20+ (probado con Node 24)
- Acceso a una base PostgreSQL (Supabase, o una PostgreSQL local para desarrollo)

## Variables de entorno

Prisma usa **dos** conexiones distintas (ver `datasource db` en
[`prisma/schema.prisma`](prisma/schema.prisma)):

| Nombre         | Uso                                   | Conexión Supabase |
| -------------- | ------------------------------------- | ----------------- |
| `DATABASE_URL` | Runtime de la app (serverless en Netlify) | Pooler **Supavisor** en modo *transaction*, puerto **6543**, con `pgbouncer=true` y `connection_limit` bajo. Es IPv4. |
| `DIRECT_URL`   | Solo `prisma migrate` (crear/aplicar migraciones) | Conexión directa / *session*, puerto **5432**. En Netlify usar el *session pooler* (`…pooler.supabase.com:5432`), IPv4. |

- Las cadenas reales se obtienen en **Supabase → Project Settings → Database →
  Connection string**.
- En **Netlify**, `DATABASE_URL` y `DIRECT_URL` se cargan como variables de
  entorno del sitio (por contexto). **No** se versionan.
- En **local**, copiá `.env.example` a `.env` (ignorado por Git) y completá los
  valores. `.env.example` contiene únicamente valores **ficticios**.
- **Ninguna credencial real vive en el repositorio.**

## Desarrollo local

```bash
npm ci
npx prisma generate
npm run dev
```

Abrí [http://localhost:3000](http://localhost:3000).

| Script          | Acción                                    |
| --------------- | ----------------------------------------- |
| `npm run dev`   | Servidor de desarrollo                    |
| `npm run build` | `prisma generate` + `next build`          |
| `npm start`     | Servidor de producción (tras `build`)     |
| `npm run lint`  | ESLint                                    |

> `npm run build` **no** aplica migraciones. Solo genera el cliente de Prisma
> y compila la aplicación.

## Base de datos y migraciones

### Modelo

El modelo tipado vive en [`prisma/schema.prisma`](prisma/schema.prisma):
`Client`, `Period`, `Invoice`, `TaxRecord`, `Settings`.

### Migraciones — Prisma Migrate

La historia de migraciones vive en `prisma/migrations/` y la gestiona **Prisma
Migrate** (no hay un segundo sistema de migraciones en paralelo).

- `prisma/migrations/migration_lock.toml` → `provider = "postgresql"`.
- Línea base: `prisma/migrations/0_init/migration.sql`. Crea el esquema completo
  vigente: tablas `Client`, `Period`, `Invoice`, `TaxRecord`, `Settings`, sus
  claves primarias, las claves foráneas (`ON UPDATE CASCADE ON DELETE
  RESTRICT`) y los índices únicos (`Client.cuit`, `Period(month, year,
  clientId)`, `Settings.key`).

#### Cómo se generó la línea base

Sin conectarse a ninguna base:

```bash
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
```

`--from-empty` produce el esquema **completo** desde cero: corresponde
**exclusivamente a la línea base**. No debe volver a usarse para cambios
posteriores.

#### Migraciones incrementales (a partir de la Tarea 2)

- Toda migración posterior describe **únicamente la diferencia** respecto del
  esquema ya aplicado (`ALTER TABLE …`, `CREATE INDEX …`, etc.).
- Se generan con `prisma migrate dev` (local) contra una base descartable, se
  revisa el SQL a mano, y se aplican con `prisma migrate deploy`.
- **Nunca** se usa `--from-empty` para una migración incremental.
- `prisma/schema.prisma` es el único modelo tipado; `prisma/migrations/` es la
  única secuencia de migraciones.

### Aplicar las migraciones

```bash
# aplica prisma/migrations/ sobre la base apuntada por DIRECT_URL
npx prisma migrate deploy
```

- `prisma migrate deploy` **no** forma parte del build de Netlify ni de ningún
  script de `package.json`. Se ejecuta de forma manual/controlada. La estrategia
  definitiva de migraciones en el pipeline se define en una tarea posterior.
- Para desarrollo local con una PostgreSQL propia se puede usar
  `npx prisma migrate dev`.

### Historial SQLite (legacy)

El proyecto arrancó como prototipo sobre SQLite. Esa historia de migraciones se
conserva, solo como antecedente histórico, en
[`docs/legacy/sqlite-migrations/`](docs/legacy/sqlite-migrations/). **No debe
ejecutarse contra PostgreSQL.**

## Despliegue

- **Frontend:** Netlify. `main` es la rama Git productiva. Branch Deploys
  desactivado; los Deploy Previews se generan para los pull requests contra
  `main`.
- **Base de datos:** Supabase (`tax-liquidator`). Las migraciones se aplican con
  `prisma migrate deploy` apuntando a `DIRECT_URL`; no se ejecutan
  automáticamente durante el build.
