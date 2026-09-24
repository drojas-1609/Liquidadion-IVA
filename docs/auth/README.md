# Autenticación y organización — base (Tarea 3A)

Esta base **no** protege todavía las rutas de negocio. Ver "Qué sigue inseguro".

## Migración `20260908021123_org_auth_base`

**Estado: NO aplicada.** No se corrió `prisma migrate deploy` / `db push` /
`migrate dev` en ninguna base. Queda pendiente de autorización aparte para
aplicarla a **dev** y, más adelante, a **producción** (protocolo Tarea 2).

- `prisma/migrations/20260908021123_org_auth_base/migration.sql` — DDL puro
  generado con:
  ```
  npx prisma migrate diff \
    --from-schema-datamodel <schema en origin/main> \
    --to-schema-datamodel prisma/schema.prisma --script
  ```
  y revisado a mano.
- Crea `Profile`, `Organization`, `Membership`, enum `Role`, `OrgSetting`.
- `Client`: `DROP INDEX "Client_cuit_key"` → `CREATE UNIQUE INDEX
  "Client_organizationId_cuit_key"`; `ADD COLUMN "organizationId" TEXT NOT NULL`
  (seguro: `Client` tiene 0 filas); `+ createdById/updatedById`.
- `Period` / `Invoice` / `TaxRecord`: `+ createdById/updatedById/createdAt/updatedAt`
  (0 filas → `NOT NULL` sin backfill).
- **No** toca `auth.users`, **no** crea triggers, **no** crea FK cross-schema.
- **No** modifica `0_init` ni `20260907213357_float_to_decimal`.

### Reproducibilidad desde cero

La migración se generó como diff entre el datamodel de `origin/main` (= estado
acumulado de `0_init` + `20260907213357_float_to_decimal`) y el datamodel de
3A. Por construcción, aplicar en una PostgreSQL **limpia**:

```
0_init  →  20260907213357_float_to_decimal  →  20260908021123_org_auth_base
```

reproduce exactamente `prisma/schema.prisma`. Todo el DDL es aditivo (crear
tablas/enum/columnas/índices/FK) más un `DROP INDEX` de un índice creado por
`0_init`. No hay dependencias del esquema `auth`, así que aplica en una base
shadow **sin** `auth`.

La verificación con shadow real (`prisma migrate diff --from-migrations
prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url
<postgres limpio>` → salida **vacía**) se ejecuta en la fase de aplicación a dev
(no autorizada en la Etapa A actual).

### Preflight / post-verificación

`docs/auth/verify.sql` — solo lectura, no se ejecuta sola.

## Autenticación (SSR)

- Paquetes: `@supabase/ssr` + `@supabase/supabase-js` (versiones exactas en
  `package.json`).
- **Autoridad de identidad en el servidor: `supabase.auth.getClaims()`.**
  Verificación local de la firma del JWT (WebCrypto + JWKS) porque el proyecto
  **dev** usa claves de firma **asimétricas** (EC/ES256, verificado vía el
  endpoint público `/.well-known/jwks.json`). `getUser()` queda como fallback
  documentado si algún entorno usara HS256 legacy.
- **Prohibido `getSession()` para decisiones de seguridad.**
- `proxy.ts` (Next.js 16 — `middleware` está deprecado) es **gate grueso**:
  exige *estar autenticado*, **no** autoriza por recurso. Refresca el token y
  aplica los headers anti-caché que entrega el adapter de cookies.
- `/update-password` está **excluida** del `proxy.ts` (para que el enlace de
  recuperación pueda llegar), pero **valida por sí misma** una sesión de
  recuperación válida antes de permitir el cambio.
- Sin signup público. Sin endpoint web de bootstrap. `logout` solo por `POST`.

### Cookies

Nombre `sb-<project_ref>-auth-token` (namespaced por proyecto → sin cruce
dev/prod). `Secure` + `SameSite=Lax`. El flujo oficial de `@supabase/ssr`
requiere que el cliente de navegador lea las cookies, por lo que **no** son
`HttpOnly`. Mitigaciones: TTL corto + rotación de refresh, headers anti-caché
aplicados en `proxy.ts`, y CSP completa (Tarea 3B).

### Callback

`app/auth/callback/route.ts` soporta **ambos** flujos y usa el que llegue:
`?code=` → `exchangeCodeForSession(code)`; `?token_hash=&type=` →
`verifyOtp({ token_hash, type })`. Sin ningún parámetro válido → 400. Solo
redirige a rutas **internas** (`next` saneado). La alineación final de las
plantillas de correo de Supabase y la prueba end-to-end de recuperación
**quedan pendientes** (requieren acceso a Supabase; no autorizado en Etapa A).

## Origen confiable (`lib/auth/origin.ts`)

`getTrustedOrigin()` (prioridad):
1. `CONTEXT === 'deploy-preview'` → `DEPLOY_PRIME_URL`, validado: HTTPS **y**
   hostname que matchea exactamente `^[a-z0-9-]+--liquidadoriva\.netlify\.app$`.
2. Producción (`CONTEXT === 'production'` o `NODE_ENV === 'production'`) →
   `AUTH_PRODUCTION_ORIGIN` (si está) validada contra el dominio esperado; si no,
   `URL` de Netlify validada como HTTPS de host único.
3. Local (`NODE_ENV !== 'production'`) → `http://localhost:3000`.
4. La request entrante (`x-forwarded-proto` + `x-forwarded-host` / `host`) se usa
   **solo como fallback** y **solo si** su origin matchea la allow-list estricta
   (localhost o el patrón de previews del propio sitio).
5. Nunca se acepta una URL absoluta de redirect del cliente.
6. `next` debe ser un path interno: empieza con `/`, no `//`, sin `\`, sin
   esquema. Cualquier otra cosa → `/`.

**Allow-list de Redirect URLs en Supabase** (a configurar en el dashboard, por
proyecto — **no** hecho en Etapa A):
- dev: `http://localhost:3000/**`, `https://deploy-preview-*--liquidadoriva.netlify.app/**`,
  `https://*--liquidadoriva.netlify.app/**`.
- prod: `https://<dominio-produccion>/**` (sin comodín).

## Integridad `Profile` ↔ `auth.users`

En 3A **no** hay FK ni trigger sobre `auth` (para no romper la reproducción de
la migración en bases shadow sin ese esquema). La integridad se mantiene por:
- el bootstrap y la aplicación solo crean `Profile` para un `auth.users` que ya
  existe;
- `scripts/check-orphan-profiles.ts` (solo lectura) detecta `Profile` sin
  `auth.users` correspondiente.

El trigger `AFTER DELETE ON auth.users` y/o la FK real quedan para una tarea
posterior específica (**`3A-bis: integridad auth`**), junto con la estrategia de
shadow DB con esquema `auth`.

## `Profile.email`

Copia de conveniencia. **No** es identidad ni clave de autorización (esa es
`Profile.id` = `auth.users.id`, UUID). Sincronización prevista (se implementa en
3B, dentro del login): en cada login exitoso, `upsert` de `Profile` con el
`email` tomado del **claim verificado**. Alternativas futuras: Auth Hook /
webhook `on user.updated`, o reconciliación periódica.

## Bootstrap del primer OWNER

`scripts/bootstrap-owner.ts` — **solo modo `link`**, ejecución local única.
**No ejecutado en Etapa A.** Nunca crea usuarios en Supabase Auth, nunca
recibe ni setea contraseñas; el `service_role` se lee del entorno en runtime
(el script vive en `scripts/`, fuera del bundle de Next) y solo se usa para
**leer** el usuario y comparar el correo.

Prerrequisito: el usuario ya existe en Supabase Auth (creado a mano desde el
dashboard). Luego, localmente:

```
BOOTSTRAP_OWNER=1 SUPABASE_SERVICE_ROLE_KEY=<clave> \
node scripts/bootstrap-owner.ts \
  --project-ref <ref> --user-id <uuid-de-auth.users> --email <correo> \
  [--org-name "Dero Company"]
```

Guardas (todas deben cumplirse): `BOOTSTRAP_OWNER=1`; `--project-ref` igual a
la ref de `NEXT_PUBLIC_SUPABASE_URL`; `--user-id` UUID; el usuario de Auth
existe y su correo coincide con `--email`; `Membership.count() === 0`; no hay
un `Profile` con ese id. Crea `Organization` + `Profile` + `Membership(OWNER)`
en una transacción. Una segunda ejecución aborta (`Membership.count() > 0`).

### Verificación de huérfanos

```
node scripts/check-orphan-profiles.ts
```

Solo lectura. Sale con código 1 si hay `Profile` sin `auth.users` (apto para
CI). Ver también `docs/auth/verify.sql` (consulta 12).

## SheetJS (`xlsx`)

Se conserva **solo para exportación** (D6). `xlsx@0.18.5` tiene advisories sin
fix en npm; hoy la app solo **escribe** xlsx (exposición baja). **Debe
sustituirse o aislarse** antes de incorporar el importador ARCA, que parseará
archivos no confiables.

## Qué sigue inseguro al terminar 3A (se resuelve en 3B)

- `/api/**` y `/client/**` **no** aplican autorización por recurso: un usuario
  autenticado (cualquiera con login) puede leer/escribir datos de cualquier
  organización. Los IDOR del diagnóstico siguen vigentes.
- La matriz de autorización (roles) existe en el modelo pero **no se evalúa**.
- `createdById`/`updatedById` no se pueblan todavía.
- `POST /api/clients` está deshabilitado (501) hasta 3B.
- Sin RLS, sin `AuditLog`, sin CSP completa, sin gestión de miembros.

**La aplicación sigue NO APTA para datos reales.**
