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
- **Netlify (sitio `liquidadoriva`), metadatos leídos el 04/11/2026:**
  - La cuenta `drojas-s83-g` está en el plan **Pro** (`env_var_scopes`, `env_var_secrets` y `enhanced_secret_scanning` incluidos). Las `ARCA_*` ya tienen alcance **solo `functions`**. El 403 de `docs/arca/PREVIEW.md` es anterior al cambio de plan.
  - El alcance se fija por variable y el contexto por valor: se puede combinar `scopes: ["functions"]` + `is_secret` + un único valor `branch:codex/usuarios-permisos-estudio`. Netlify exige que los secretos tengan contextos y alcances explícitos y no admite *post processing*. El *secret scanning* hace fallar el build si el valor aparece en lo publicado.
  - **A qué se aplica el valor por rama:** a todo deploy "initiated from" esa rama. Eso incluye cada Deploy Preview del PR #28 (de cualquier commit), sus *deploy permalinks* (`<id>--liquidadoriva.netlify.app`, el mismo deploy con otra URL) y los branch deploys de la rama. Estos últimos **hoy no existen**, porque `allowed_branches = ["main"]`; si alguien los habilitara para esta rama, también recibirían la clave. No llega a Production ni a las Previews de otras ramas. Fuera de Netlify (`netlify dev --context branch:…`) los secretos se leen enmascarados.
  - La app limita el **envío** a `USER_INVITE_REDIRECT_URL`. Desde un permalink, la request trae otro host y el envío queda en `NOT_CONFIGURED`, aunque la clave esté disponible en esas funciones.
- **Supabase Auth:** la lista de redirecciones es una **unión** de patrones. Agregar la URL exacta no restringe mientras exista `https://deploy-preview-*--liquidadoriva.netlify.app/**`, que usan la recuperación y el callback de todas las Previews. La restricción exacta se hace **en la app**: el envío exige que el destino sea `USER_INVITE_REDIRECT_URL`; si falta o difiere, devuelve `NOT_CONFIGURED`.

## 1. Variables de Netlify (pendiente; no cargar todavía)

Cada variable con **alcance solo `functions`** y **un único valor** en el contexto `branch:codex/usuarios-permisos-estudio`. Ningún otro contexto: ni Production, ni Deploy Previews generales, ni `dev`.

| Variable | Valor | `is_secret` |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | clave secreta de **DEV** (`sb_secret_…` o `service_role`) | **sí** |
| `USER_INVITE_EMAIL_ALLOWLIST` | `<cuenta-A>,<cuenta-B>` (direcciones exactas) | no |
| `USER_INVITE_REDIRECT_URL` | `https://deploy-preview-28--liquidadoriva.netlify.app/auth/accept-invite` | no |

Cargarlas solo si se acepta que la clave quede disponible en **todos** los deploys iniciados desde la rama (Previews y sus permalinks). Mantener deshabilitados los branch deploys de esa rama. Después de la carga hace falta un nuevo deploy; releer los metadatos (`scopes` y `values[].context`) sin valores. Para el ensayo del §4 **no hace falta** ninguna de estas variables.

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

## 4. Ensayo con enlaces generados en terminal (sin secretos en Netlify y sin correo)

Recomendado para el piloto con dos cuentas bajo tu control, mientras la clave no esté cargada en Netlify. La clave de DEV se usa **solo en tu terminal**, durante la ejecución, y nunca llega a Netlify. El enlace va directo a la página de la Preview y no pasa por la redirección de Supabase, así que tampoco hace falta tocar Auth (salvo *Email OTP Expiration*, que define cuánto dura el enlace).

Requisitos: migración DEV aplicada y verificada; push hecho y Preview #28 compilada; dos direcciones **distintas** de la del OWNER, bajo tu control. Ningún secreto en Netlify.

1. En la Preview, como OWNER: Configuración → Usuarios → invitar a A (Contable · un cliente · solo IVA) y a B (Consulta · todos · Clientes + IVA). Sin allowlist ni clave, la respuesta es `BLOCKED_RECIPIENT` o `NOT_CONFIGURED`. La invitación **queda pendiente** y ocupa plaza.
2. En una terminal limpia:
   ```sh
   cd ~/studio-users-dev-kit
   env -i PATH="$PATH" HOME="$HOME" TERM="$TERM" USERS_DEV_LINK=yes-esyfpakajthdifhnhcew node 96-invite-link.mjs <cuenta-A> <cuenta-B>
   ```
   Pide la clave en un prompt oculto. Comprueba que sea admin de DEV y se niega con PROD. Para una cuenta nueva genera un enlace `type=invite` (definirá contraseña); para una ya confirmada, `type=magiclink`. Muestra los enlaces solo en la terminal. Si una cuenta todavía no existía, `generateLink` la crea sin confirmar.
3. Abrir el enlace de A en una ventana privada → «Activar acceso» → contraseña → entra. Seguir las comprobaciones del §3. Repetir con B en otra ventana privada.
4. Casos negativos:
   - **reabrir el mismo enlace:** "no es válido o ya fue usado";
   - **revocar antes de abrir:** generar el enlace, revocar en la app y abrir: "No encontramos una invitación vigente". La cuenta de Auth queda creada pero sin acceso.
   - **vencimiento:** la invitación vencida no se acepta; Reenviar la renueva.
5. El envío real por correo queda como verificación aparte: con las variables del §1 y SMTP propio, o con cuentas que sean miembros del equipo de Supabase.

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
