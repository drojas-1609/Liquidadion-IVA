# Usuarios del estudio · piloto DEV con dos cuentas de prueba

**Alcance:** DEV (`esyfpakajthdifhnhcew`) y Deploy Preview del PR #28. Producción queda fuera.
**Orden:** 1) migración DEV con `~/studio-users-dev-kit` (pasos 10→50→70→80) · 2) prueba sintética (90) · 3) huella al runner (85) · 4) esta configuración · 5) envíos a las dos cuentas.
Los pasos 1, 4 y 5 son la migración remota, la carga de secretos y los envíos: cada uno requiere autorización explícita.

## 1. Variables de Netlify (sitio `liquidadoriva`)

Sólo en los contextos **Deploy Previews** (y Branch deploys, si se usan), **nunca** en Production. Alcance: *Functions* (runtime). Ninguna lleva `NEXT_PUBLIC_`.

| Variable | Valor | Secreta | Notas |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | clave `service_role` (o `sb_secret_…`) del proyecto **DEV** | Sí (marcar *Contains secret values*) | La lee sólo `lib/users/invitation-mailer.ts`. Sin ella, la invitación queda `NOT_CONFIGURED`. |
| `USER_INVITE_EMAIL_ALLOWLIST` | `<cuenta-A>,<cuenta-B>` (las dos direcciones exactas, separadas por coma) | No | Sin lista no se envía a nadie, en ningún entorno. Preferir direcciones exactas a comodines. |

Comprobar que en esos mismos contextos `NEXT_PUBLIC_SUPABASE_URL` = `https://esyfpakajthdifhnhcew.supabase.co` y `DATABASE_URL`/`DIRECT_URL` apuntan a DEV. La clave service_role de DEV **no** debe estar en Production ni en archivos del repositorio.

## 2. Supabase DEV · Authentication

**URL Configuration → Redirect URLs** (deben estar; el enlace del correo usa `RedirectTo`):
- `https://deploy-preview-*--liquidadoriva.netlify.app/**` (cubre `https://deploy-preview-28--liquidadoriva.netlify.app/auth/accept-invite`)
- `http://localhost:3000/**` (sólo si se prueba en local)

Si el `RedirectTo` no está en la lista, Supabase usa el *Site URL* y el enlace queda roto.

**Email Templates** (reemplazar sólo el enlace; el resto del texto es libre):
- *Invite user*: `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite">Activar acceso</a>`
- *Magic Link*: `<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink">Activar acceso</a>`

La app no usa Magic Link para otro fin (sólo `invitation-mailer`), así que cambiar esa plantilla no afecta el inicio de sesión. No tocar *Reset password*.

**Providers → Email**:
- *Confirm email*: activado.
- *Email OTP Expiration*: el enlace vence a esta cantidad de segundos (por defecto 3600; máximo 86400), **aunque la invitación dure 7 días**. Sugerido para el piloto: `86400`. Si el enlace venció, el OWNER usa **Reenviar**.
- *Allow new users to sign up*: recomendado **desactivado** (las cuentas nacen sólo por invitación; `inviteUserByEmail` funciona igual).

**SMTP** (requisito de entrega): sin SMTP propio, Supabase **sólo envía a direcciones que son miembros del equipo** de la organización de Supabase (un alias `+` no cuenta) y con un límite bajo por hora. Elegir una:
- las dos cuentas de prueba son miembros del equipo de la organización `udiqvmrclbiasxaswbuk`; o
- se configura SMTP propio en DEV (Authentication → Emails → SMTP; límite inicial 30 mensajes/h).

## 3. Envío y comprobaciones con las dos cuentas

Desde la Preview del PR #28, con el OWNER de DEV, en Configuración → Usuarios:
- **A** (`<cuenta-A>`): Contable · Clientes seleccionados (1 cliente) · sólo *Liquidación de IVA*.
- **B** (`<cuenta-B>`): Consulta · Todos los clientes · *Fichas de clientes* + *Liquidación de IVA*.

Esperado: la respuesta dice `SENT` (si dice `BLOCKED_RECIPIENT`, revisar la allowlist; `NOT_CONFIGURED`, la clave; `FAILED`, SMTP/plantilla/redirect).
1. A abre el enlace, define contraseña (≥ 12) y entra: ve sólo su cliente. Otro cliente o período por URL → 404; exportación ajena → 404.
2. Con la sesión de A abierta, el OWNER le cambia el cliente: la siguiente navegación de A lo refleja. El OWNER desactiva a A: la siguiente navegación muestra "Sin organización".
3. B: ve todos los clientes, no puede cargar (sólo lectura).
4. Reenviar antes de un minuto → rechazado; revocar → el enlace ya no da acceso ("No encontramos una invitación vigente").
5. `seatLimit` al uso actual → invitar responde "sin plazas".

## 4. Después

- Datos sintéticos de la prueba 90: `99-cleanup-synthetic.sql` del kit, sólo en DEV y con autorización.
- Cuentas de Auth creadas por las invitaciones: se quedan en DEV hasta decidir su baja (aparte).
