# Configuración → Usuarios (primera entrega)

## Modelo
- Rol (OWNER/ADMIN/ACCOUNTANT/VIEWER), alcance de clientes (ALL/SELECTED) y módulos (CLIENTS, IVA, ARCA_PADRON) son ejes independientes, aplicados en el servidor en cada solicitud (`lib/auth/authz.ts`). Fuera de alcance = 404 idéntico a inexistente. Sin módulo = 403.
- Sólo el OWNER gestiona usuarios (`ROLES_USER_MANAGE`). El OWNER no se modifica, desactiva ni asigna; un trigger impide dejar al estudio sin OWNER activo.
- Revocación: cada solicitud relee la Membership; desactivar o cambiar permisos rige en la siguiente solicitud aunque la sesión de Supabase siga abierta.

## Cupo
- Ocupan plaza: Membership ACTIVE (incluido el propietario) + invitación PENDING no vencida (7 días). No ocupan: DISABLED, REVOKED, ACCEPTED, vencidas.
- Concurrencia: `SELECT ... FOR UPDATE` de `Organization` antes de contar + índice único parcial de pendientes por correo. Probado con invitaciones simultáneas en PostgreSQL real.
- `Organization.seatLimit` (default 5). **Provisión por plan (etapa posterior):** el plan comercial escribirá `seatLimit` (p. ej. tabla `OrganizationPlan` + job/admin de plataforma que actualiza el valor dentro de una transacción con el mismo bloqueo). Bajar el cupo por debajo de lo usado no desactiva a nadie: sólo bloquea nuevas invitaciones/reactivaciones.

## Migración `20261104120000_studio_users_permissions`
Aditiva; NO aplicada en DEV/PROD. Membresías existentes quedan ACTIVE/ALL/todos los módulos. RLS sin políticas y REVOKE en tablas nuevas.
**Orden de despliegue:** aplicar la migración ANTES del código (el cliente Prisma nuevo lee `seatLimit`). Al aplicarla en DEV, actualizar `EXPECTED_MIGRATIONS` de `scripts/arca/homologation-runner.ts` en el mismo paso y quitarla de `NOT_IN_DEV` en `scripts/pg-local-regression.sh`.

## Correo (pendiente de configurar, requiere intervención)
- `SUPABASE_SERVICE_ROLE_KEY` en el runtime del servidor (Netlify, sólo DEV/Preview por ahora). Sin ella: `NOT_CONFIGURED` (la invitación queda pendiente).
- Fuera de producción sólo se envía a `USER_INVITE_EMAIL_ALLOWLIST` (admite `*`, p. ej. `drojas+*@derocompany.com.ar`).
- Plantillas Supabase: "Invite user" → `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite`; "Magic Link" → `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink`. RedirectTo = `<origen>/auth/accept-invite` (ya cubierto por la allow-list `/**`).

## Smoke DEV (después de revisar la Preview)
1. Aplicar migración en DEV (autorización aparte) y verificar que el OWNER actual entra y ve `/settings/users`.
2. Configurar service role + allowlist + plantillas en DEV.
3. Invitar dos direcciones de prueba de la allowlist: A = Contable, 1 cliente, sólo IVA; B = Consulta, todos, Clientes+IVA.
4. Activar ambas cuentas desde el correo (definir contraseña).
5. Con A: ver sólo su cliente; abrir por URL otro cliente/período → 404; exportar otro período → 404.
6. Con A logueada, cambiar su alcance y desactivarla desde el OWNER: la siguiente navegación refleja el cambio / "Sin organización".
7. Bajar `seatLimit` al uso actual y verificar que invitar responde "sin plazas".
8. Limpiar datos sintéticos sólo con SQL en DEV y con autorización.

## Dependencias con PR #25 (Libro IVA Digital)
- Conflictos de texto esperables: `lib/auth/audit.ts`, `scripts/pg-local-regression.sh`, `tests/_period-lock-structure.ts`, `tests/period-write-lock.test.ts`, `tests/serialization-audit.test.ts`, página del período.
- Sus rutas usan `requirePeriodAccess` → heredan IVA + alcance sin cambios. Si se quiere un módulo propio (`LIBRO_IVA`), agregarlo al enum (nueva migración) y pasarlo explícito.
- `tests/auth/module-scope-coverage.test.ts` exigirá `module:` en cualquier `requireOrganizationRole` nuevo que no resuelva luego el período.
