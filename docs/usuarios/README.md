# Configuración → Usuarios (primera entrega)

## Modelo
- Rol (OWNER/ADMIN/ACCOUNTANT/VIEWER), alcance de clientes (ALL/SELECTED) y módulos (CLIENTS, IVA, ARCA_PADRON) son ejes independientes, aplicados en el servidor en cada solicitud (`lib/auth/authz.ts`). Fuera de alcance = 404 idéntico a inexistente. Sin módulo = 403.
- Sólo el OWNER gestiona usuarios (`ROLES_USER_MANAGE`). El OWNER no se modifica, desactiva ni asigna; un trigger impide dejar al estudio sin OWNER activo.
- Revocación: cada solicitud relee la Membership; desactivar o cambiar permisos rige en la siguiente solicitud aunque la sesión de Supabase siga abierta.

## Cupo
- Ocupan plaza: Membership ACTIVE (incluido el propietario) + invitación PENDING no vencida (7 días). No ocupan: DISABLED, REVOKED, ACCEPTED, vencidas.
- Concurrencia: `SELECT ... FOR UPDATE` de `Organization` antes de contar + índice único parcial de pendientes por correo. Probado con invitaciones simultáneas en PostgreSQL real.
- `Organization.seatLimit` (default 5). **Provisión por plan (etapa posterior):** el plan comercial escribirá `seatLimit` (p. ej. tabla `OrganizationPlan` + job/admin de plataforma que actualiza el valor dentro de una transacción con el mismo bloqueo). Bajar el cupo por debajo de lo usado no desactiva a nadie: sólo bloquea nuevas invitaciones/reactivaciones.

## Aceptación (`/auth/accept-invite`)
- El GET no consume el token. El POST hace `verifyOtp`, exige **correo confirmado según Auth** (`auth.getUser()`, mismo id que la sesión) y busca la invitación por ese correo (no el del JWT). Si la invitación guardó `auth.users.id`, debe coincidir.
- Vencida, revocada o ya aceptada: no se acepta. Dos vigentes del mismo correo (dos estudios): no se elige; hay que revocar una. Activa en otro estudio: no se acepta.
- Correo ya registrado en Auth: llega un enlace `magiclink` (sin definir contraseña) y se suma el acceso a esa cuenta.

## Data API de Supabase (cierre en la misma migración)
Observado en DEV (solo lectura, 04/11/2026): las tablas de negocio de `public` tenían RLS desactivado y `arwdDxtm` para `anon`/`authenticated`/`service_role` (privilegios por defecto de Supabase). Hoy PostgREST arranca **sin esquemas expuestos** (`db-schemas=pg_pgrst_no_exposed_schemas`) y `pg_graphql` no está instalado: no hay acceso efectivo, pero bastaba con exponer `public` en el panel para que la clave publicable leyera y escribiera todo.
La migración cierra eso en la base: RLS sin políticas en cada tabla de `public`, `REVOKE ALL` a PUBLIC y a los tres roles de la API en tablas, secuencias y funciones, y los privilegios por defecto del rol que migra, incluido el `EXECUTE` implícito de PUBLIC en funciones: tablas, secuencias y funciones futuras creadas por `postgres` tampoco quedan expuestas. **Límite:** las que cree `supabase_admin` (la plataforma) reciben los privilegios por defecto de Supabase; crear objetos solo por migraciones. La app no usa la Data API (todo pasa por Prisma como propietario). Probado en PostgreSQL local (`tests/integration/users-permissions-pg.test.ts`).
Recomendado además: mantener la Data API sin esquemas expuestos en DEV y PROD.

## Migración `20261104120000_studio_users_permissions`
Aditiva; NO aplicada en DEV/PROD. Membresías existentes quedan ACTIVE/ALL/todos los módulos.
**Orden de despliegue:** aplicar la migración ANTES del código (el cliente Prisma nuevo lee `seatLimit`). En DEV se aplica con `~/studio-users-dev-kit` (preflight, un único intento, postcheck, huella). Después: actualizar `EXPECTED_MIGRATIONS`/`FP` de `scripts/arca/homologation-runner.ts` con la huella leída de DEV y quitar la migración de `NOT_IN_DEV` en `scripts/pg-local-regression.sh` (lo hace `85-runner-update.sh` del kit, sin commit).

## Correo
- Destino exacto: el envío exige `USER_INVITE_REDIRECT_URL` igual al `RedirectTo` calculado (p. ej. la URL de la Preview #28). La allow-list de Supabase es una unión con comodines y no alcanza para restringir.
- Guarda de destinatarios en **todos** los entornos: sólo `USER_INVITE_EMAIL_ALLOWLIST` (admite `*` sin cruzar la `@`). No hay excepción por `CONTEXT` (no existe en el runtime de Netlify). Producción queda fuera de esta etapa.
- `SUPABASE_SERVICE_ROLE_KEY` sólo en el servidor (`lib/users/invitation-mailer.ts`, `server-only`). Sin ella: `NOT_CONFIGURED`. Verificado con un build aislado con valor centinela: no aparece en `.next/` y el nombre sólo en un chunk de servidor.
- Configuración exacta para el piloto con dos cuentas: [DEV-PILOTO.md](DEV-PILOTO.md).

## Pruebas
- `scripts/pg-local-regression.sh`: integración en PostgreSQL 17 local (dos usuarias, revocación con sesión abierta, vencimiento, reenvío, correo ya registrado, dos estudios, cupo concurrente con invitaciones y reactivaciones, aceptaciones simultáneas, Data API cerrada) y ensayo de la prueba DEV.
- `tests/dev-smoke/users-dev-smoke.test.ts`: la misma lógica contra DEV en un estudio sintético `syn_users_*`; sólo con habilitación explícita (kit, paso 90).

## Dependencias con PR #25 (Libro IVA Digital)
- Conflictos de texto esperables: `lib/auth/audit.ts`, `scripts/pg-local-regression.sh`, `tests/_period-lock-structure.ts`, `tests/period-write-lock.test.ts`, `tests/serialization-audit.test.ts`, página del período.
- Sus rutas usan `requirePeriodAccess` → heredan IVA + alcance sin cambios. Si se quiere un módulo propio (`LIBRO_IVA`), agregarlo al enum (nueva migración) y pasarlo explícito.
- `tests/auth/module-scope-coverage.test.ts` exigirá `module:` en cualquier `requireOrganizationRole` nuevo que no resuelva luego el período.
