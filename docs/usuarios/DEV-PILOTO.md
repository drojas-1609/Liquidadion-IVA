# Usuarios del estudio · piloto DEV con dos cuentas de prueba

**Alcance:** DEV (`esyfpakajthdifhnhcew`) y la Deploy Preview del PR #28: `https://deploy-preview-28--liquidadoriva.netlify.app`. Producción queda fuera.

**Orden:** migración DEV con `~/studio-users-dev-kit` (10 → 50 → 70 → 80 → 90 → 85) · commit del runner · push · Preview · esta configuración · invitaciones.

Requieren autorización explícita: la migración, los datos sintéticos, la carga de secretos y los envíos.

## 0. Hechos verificados (04/11/2026)

- **Rol de la app en DEV:** `postgres`. En las últimas 24 h, todos los pools de Supavisor (modo transacción, que es el runtime) se abrieron como `user: "postgres"`. En Supabase ese rol no es superusuario, tiene `BYPASSRLS`, es dueño de `public` y es miembro de `anon`, `authenticated`, `service_role` y `pg_read_all_data`. Los valores de `DATABASE_URL` y `DIRECT_URL` en Netlify son secretos de solo escritura (se leen enmascarados).
- **Compatibilidad, en PostgreSQL local con ese mismo modelo de roles y el esquema migrado:**

  | Versión | Resultado |
  |---|---|
  | `main` | 34/34 |
  | PR #25 (importación) | 46/46 |
  | PR #28 | 50/50 + smoke |

  `main` y el #25 siguen funcionando después de la migración.
- **Objetos futuros:** una tabla, secuencia o función creada por `postgres` (el rol que migra) queda sin privilegios para `anon`, `authenticated` y `service_role`. Las tablas que cree `supabase_admin` (la plataforma) sí los reciben, por los privilegios por defecto de Supabase, que la migración no puede cambiar. Regla: crear tablas **solo por migraciones** y mantener la Data API sin esquemas expuestos. El `api_exposure` del kit lo detecta.
- **Netlify (sitio `liquidadoriva`):**
  - La cuenta **no tiene** alcances granulares de variables (`env_var_scopes`: 403, ver `docs/arca/PREVIEW.md`). Netlify los limita a los planes Pro y Enterprise. **No se puede dejar una variable solo para Functions**: queda con los alcances por defecto (builds, functions, runtime).
  - Sí se puede marcar **`is_secret`** (`DATABASE_URL` ya lo está): queda de solo escritura, no admite el alcance *post processing* y el *secret scanning* hace fallar el build si el valor aparece en lo que se publica.
  - Sí se puede asignar un **valor por rama**, que "will be used for deploy permalinks, Deploy Previews, and branch deploys for the specified branch". En el build aislado, con un valor centinela, la clave no aparece en `.next/`.
- **Supabase Auth:** la lista de redirecciones es una **unión** de patrones. Agregar la URL exacta no restringe mientras exista `https://deploy-preview-*--liquidadoriva.netlify.app/**`, que usan la recuperación y el callback de todas las Previews. La restricción exacta se hace **en la app**: el envío exige que el destino sea `USER_INVITE_REDIRECT_URL`; si falta o difiere, devuelve `NOT_CONFIGURED`.

## 1. Variables de Netlify (sin cargar todavía)

Contexto: **valor por rama `codex/usuarios-permisos-estudio`** (aplica a la Deploy Preview #28). Ningún otro contexto: ni Production, ni Deploy Previews en general, ni `dev`.

| Variable | Valor | `is_secret` |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | clave secreta de **DEV** (`sb_secret_…` o `service_role`) | **sí** |
| `USER_INVITE_EMAIL_ALLOWLIST` | `<cuenta-A>,<cuenta-B>` (direcciones exactas) | no |
| `USER_INVITE_REDIRECT_URL` | `https://deploy-preview-28--liquidadoriva.netlify.app/auth/accept-invite` | no |

Después de cargarlas hace falta un **nuevo deploy** de la Preview. Comprobar luego en los metadatos que existen solo con el contexto `branch:codex/usuarios-permisos-estudio`.

## 2. Supabase DEV · Authentication

- **Redirect URLs:** agregar la exacta `https://deploy-preview-28--liquidadoriva.netlify.app/auth/accept-invite`. El comodín de Previews ya la cubre; la entrada exacta documenta la intención. No quitar el comodín: lo usan las otras Previews.
- **Email Templates:**
  - *Invite user*: `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite">Activar acceso</a>`
  - *Magic Link*: `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink">Activar acceso</a>`

  La app no usa Magic Link para otra cosa.
- **Providers → Email:** *Confirm email* activado; *Email OTP Expiration* en `86400` (máximo; el enlace vence antes que la invitación de 7 días); *Allow new users to sign up* desactivado.
- **SMTP:** el integrado **solo entrega a miembros del equipo** de la organización de Supabase y con un límite bajo por hora. Si las cuentas A y B no son miembros, el envío real falla (`FAILED`) y se usa el §4.

## 3. Prueba con dos cuentas bajo tu control

Desde la Preview #28, como OWNER de DEV, en Configuración → Usuarios:
- **A** (`<cuenta-A>`): Contable · un cliente asignado · solo *Liquidación de IVA*.
- **B** (`<cuenta-B>`): Consulta · todos los clientes · *Fichas de clientes* + *Liquidación de IVA*.

Esperado al invitar:
- `SENT` si el correo integrado entrega.
- `FAILED` si no entrega: la invitación queda pendiente; seguir con el §4.
- `BLOCKED_RECIPIENT` si falta la allowlist.
- `NOT_CONFIGURED` si falta la clave o `USER_INVITE_REDIRECT_URL`.

Comprobaciones:
1. A abre su enlace, define la contraseña (≥ 12 caracteres) y entra. Ve solo su cliente y su historial de períodos, abre el período y exporta. Otro cliente o período por URL, y su exportación, dan 404.
2. Con la sesión de A abierta, el OWNER le cambia el cliente: la siguiente navegación lo refleja. Si la desactiva: "Sin organización".
3. B ve todos los clientes y no puede cargar.
4. Reenviar antes de un minuto: rechazado. Revocar: el enlace ya no da acceso.
5. Con el cupo al uso actual, invitar responde "sin plazas".

## 4. Si el correo integrado bloquea: enlaces generados por el servidor

`~/studio-users-dev-kit/96-invite-link.mjs` (requiere autorización, porque usa la clave secreta de DEV en tu terminal):
- Pide la clave en un prompt oculto. Comprueba contra DEV que sea una clave admin válida de ese proyecto y se niega con PROD.
- Acepta solo las direcciones que le pasás como argumento (A y B).
- Llama a `auth.admin.generateLink`: tipo `invite` para una cuenta nueva y `magiclink` si ya existe, con `redirectTo` = la URL exacta de la Preview. **No envía correos.**
- Muestra el enlace `…/auth/accept-invite?token_hash=…&type=…` **solo en la terminal**, sin guardarlo. Es de un solo uso y vence según *Email OTP Expiration*.

Requisito: la invitación tiene que existir pendiente en la app (se creó en el §3, aunque el envío diera `FAILED`). La aceptación la ubica por el correo confirmado. Abrir el enlace en una **ventana privada** con la cuenta correspondiente y seguir las comprobaciones del §3.

El envío real queda como **verificación aparte**, cuando haya SMTP propio o las cuentas sean miembros del equipo.

## 5. Reservado para la integración #25 + #28

La importación (Libro IVA Digital y Portal IVA) vive en el PR #25, que sigue separado. Con ambos integrados, la prueba debe cubrir:
- una usuaria **Contable con módulo IVA y un cliente asignado** importa en un período de ese cliente (vista previa y confirmación) y ve el historial de confirmaciones;
- la misma usuaria recibe **404** en la vista previa, la confirmación y la consulta de operación para un período de un cliente **fuera de su alcance**;
- una usuaria **sin módulo IVA** recibe 403;
- **VIEWER** no importa (403).

Las rutas del #25 usan `requirePeriodAccess` y heredan módulo y alcance. Hay que comprobarlo en la integración: `tests/auth/module-scope-coverage.test.ts` lo exige.

## 6. Después

- Datos sintéticos del paso 90: `99-cleanup-synthetic.sql`, solo en DEV y con autorización.
- Cuentas de Auth creadas por las invitaciones o por `generateLink`: quedan en DEV hasta decidir su baja.
- Variables por rama: borrarlas al terminar el piloto y redeployar.
