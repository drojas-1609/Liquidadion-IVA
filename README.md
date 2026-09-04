# Dero Company — Liquidador de IVA e IIBB

Aplicación Next.js (App Router) para liquidación de IVA e IIBB. La persistencia
usa **PostgreSQL administrado por Netlify Database**, con Prisma como ORM y
`prisma/schema.prisma` como definición tipada del modelo.

## Stack

- Next.js 16 (App Router, Turbopack)
- React 19
- Prisma 6 (`@prisma/client`) sobre PostgreSQL
- Netlify Database (PostgreSQL administrado) + su sistema nativo de migraciones

## Requisitos

- Node.js 20+ (probado con Node 24)
- Una base PostgreSQL accesible para desarrollo local (ver más abajo)

## Variables de entorno

| Nombre         | Descripción                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| `DATABASE_URL` | Cadena de conexión PostgreSQL que consume Prisma (`datasource db`).       |

- En **Netlify**, `DATABASE_URL` la inyecta **Netlify Database** de forma
  automática y **por contexto** (Production, Deploy Previews, Preview Server &
  Agent Runners). No se define manualmente en el repo.
- En **local**, copiá `.env.example` a `.env` y completá `DATABASE_URL` con tu
  propia base PostgreSQL. `.env` está ignorado por Git.
- `.env.example` contiene únicamente valores ficticios.

## Desarrollo local

```bash
npm ci
npx prisma generate
npm run dev
```

Abrí [http://localhost:3000](http://localhost:3000).

Scripts disponibles:

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

### Migraciones activas — Netlify Database

Las migraciones PostgreSQL que se aplican en el ciclo de despliegue viven en:

```
netlify/database/migrations/<timestamp>_<descripcion>/migration.sql
```

Están escritas como **SQL PostgreSQL plano** y las aplica el **sistema nativo
de migraciones de Netlify Database**, no Prisma Migrate. La línea base actual es
`netlify/database/migrations/20260903222920_init_postgres/migration.sql` y crea
el esquema completo vigente (tablas, relaciones, claves únicas e índices).

Flujo esperado en un **Deploy Preview** (pull request contra `main`):

1. Netlify crea una **rama de base aislada** para ese PR (no se toca la rama
   productiva de base, `production`).
2. Netlify Database aplica las migraciones de `netlify/database/migrations/`
   sobre esa rama aislada.
3. Se construye la aplicación y se publica una URL de preview.

Para **generar** una nueva línea base o migración a partir del schema, sin
conectarse a ninguna base:

```bash
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > netlify/database/migrations/<timestamp>_<descripcion>/migration.sql
```

Revisá el SQL generado a mano antes de incorporarlo.

> **Importante:** no se usan Prisma Migrate y Netlify Database en paralelo para
> aplicar la misma migración. `prisma migrate deploy` / `prisma migrate dev`
> **no** forman parte del build ni de ningún script del proyecto, y no deben
> ejecutarse contra Netlify.

### Aplicar el esquema en una base local

Apuntá `DATABASE_URL` a tu PostgreSQL local y aplicá el SQL de la línea base
directamente, por ejemplo:

```bash
psql "$DATABASE_URL" -f netlify/database/migrations/20260903222920_init_postgres/migration.sql
```

### Historial SQLite (legacy)

El proyecto arrancó como prototipo sobre SQLite. Esa historia de migraciones se
conserva, solo como antecedente histórico, en
[`docs/legacy/sqlite-migrations/`](docs/legacy/sqlite-migrations/). **No debe
ejecutarse contra PostgreSQL.**

## Despliegue

El despliegue es en Netlify. `main` es la rama Git productiva; `production` es
la rama de base productiva. Branch Deploys está desactivado; los Deploy
Previews se generan para los pull requests contra `main`.
