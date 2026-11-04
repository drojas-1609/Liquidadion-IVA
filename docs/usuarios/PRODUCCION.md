# Usuarios del estudio · procedimiento de producción (PR #28)

**Estado:** preparado y ensayado **sólo offline**. Nada se ejecutó contra PROD (`bqqruaikbqculvmtirvy`).

Requieren autorización explícita y por separado:
- cada escritura en PROD (migración);
- la carga de secretos en Netlify y en Supabase;
- el merge;
- los envíos de correo.

Dos pasos, en este orden. No se pasa al 2 sin el 1 cerrado.

| Paso | Qué | Resultado esperado |
|---|---|---|
| **1** | Migración de PROD con preflight, respaldo, ensayo y postcheck. La app **publicada** (`main`) sigue funcionando sobre el esquema migrado. Después, merge y verificación del código nuevo | 12 migraciones en PROD; app vieja y nueva funcionando; Data API cerrada |
| **2** | Correo (SMTP + plantillas + redirección + variables) y piloto de punta a punta con **una sola dirección** que controla el titular. Recién después, el equipo | Invitación real recibida, aceptada, con permisos verificados y desactivación efectiva |

## 0. Hechos de partida

- **PROD tiene 11 migraciones**: las 10 previas más `20261102120000_arca_production_controls`, aplicada el 03/11/2026 con `~/arca-production-controls-prod-kit` (corrida `runs/20261103T032821Z-migrate`, Prisma 0, postcheck OK). Huella `b43caa99dfb9cbd36cbc0ea7cd7204ba34fe0c3dd94fc7c87a70a6aeb6fa9cee`. `docs/arca/PRODUCCION.md` todavía dice "PROD sin aplicar": quedó desactualizado.
- **Roles de PROD, según esa corrida:** `postgres` no es superusuario, tiene `BYPASSRLS` y es dueño de todo `public`. Los privilegios por defecto de Supabase conceden a `anon`, `authenticated` y `service_role`, y ninguna tabla de negocio tiene RLS. Es la **misma exposición latente** que había en DEV; esta migración la cierra.
- **App publicada:** `https://liquidadoriva.netlify.app`, sin dominio propio. Commit `e8ba002` (= `main`, deploy `6aeab75c…`). Ninguna variable de invitaciones cargada.
- **Kit:** `~/studio-users-prod-kit`, fijado al HEAD del PR y sellado con `SHA256SUMS`.
  - `./selftest.sh`: 29/29.
  - `local/e2e-rehearsal.sh`: **E2E COMPLETO OK**. Arma un PROD sintético con el modelo de roles de Supabase y los ids reales de `_prisma_migrations` de PROD, de modo que la huella es la de PROD y no se usa ningún atajo. Corre 10 → 20 → 30 → 35 → 50 hasta el pedido de URL, más negativos.

## 1. Migración de PROD

**Ventana:** unos 45 min sin uso de la app en PROD. Cualquier escritura entre el respaldo y el 50 obliga a repetir 20 → 30. Antes de empezar, anotar en el acta el último respaldo administrado de Supabase (Database → Backups, diario o PITR) con fecha y hora.

En una terminal limpia:

```sh
cd ~/studio-users-prod-kit
CLEAN=(env -i PATH="$PATH" HOME="$HOME" TERM="$TERM")
```

| # | Comando | Escribe en PROD | Qué verifica |
|---|---|---|---|
| 10 | `"${CLEAN[@]}" USERS_PROD_PREFLIGHT=yes-bqqruaikbqculvmtirvy ./10-preflight.sh` | no | identidad PROD; las 11 migraciones con checksum; huella `b43caa99…`; estructura **exacta** de `public` (= `reference/expected-pre.json`, la misma de DEV antes de migrar); actividad 0; línea base de conteo y md5 por tabla |
| 20 | `… USERS_PROD_BACKUP=yes-bqqruaikbqculvmtirvy ./20-backup.sh runs/<ts>-preflight` | no | `pg_dump -Fc --schema=public` en solo lectura, con preflight antes y después (PROD estable durante el volcado); manifiesto con sha256 y TOC |
| 30 | `… USERS_PROD_REHEARSE=yes-local ./30-rehearse-local.sh runs/<ts>-backup` | no (local) | restaura la copia en PostgreSQL 17 local; la copia pasa el preflight de PROD y reproduce la línea base; aplica la migración con el mismo Prisma; postcheck exacto sobre datos reales |
| 35 | `… USERS_PROD_COMPAT=yes-local ./35-compat-published.sh` | no (local) | toma el **commit publicado** en Netlify y corre **sus** pruebas de integración sobre el esquema migrado, con el modelo de roles de Supabase y conectado como `postgres`. Además corre las del PR |
| 50 | `… USERS_PROD_MIGRATE=yes-bqqruaikbqculvmtirvy ./50-migrate-prod.sh runs/<ts>-backup runs/<ts>-rehearsal runs/<ts>-compat` | **sí** | exige respaldo de 4 h como máximo, ensayo OK del mismo sha256 y 35 OK con el commit que se publica **en ese momento**. Preflight idéntico al respaldo, frase `APLICAR-PROD-bqqruaikbqculvmtirvy-20261104120000_studio_users_permissions`, marcador, un único `prisma migrate deploy` y postcheck |
| 70 | `… USERS_PROD_POSTCHECK=yes-bqqruaikbqculvmtirvy ./70-postcheck.sh runs/<ts>-migrate` | no | repetible: 12 migraciones; las 11 previas reproducen `b43caa99…`; estructura = `reference/expected-post.json`; `api_exposure = []`; datos previos idénticos |
| 75 | `… USERS_PROD_APPCHECK=yes-bqqruaikbqculvmtirvy ./75-app-check.sh runs/<ts>-compat` | no | el commit publicado no cambió; `/login` 200; `/` redirige sin sesión; `/api/clients` sin sesión 401 (comprobado hoy contra producción: 200, 303 y 401). Imprime el control manual del OWNER |
| 95 | `… USERS_PROD_PROBE=yes-bqqruaikbqculvmtirvy ./95-data-api-probe.sh` | no | con la clave **publicable** de PROD y `limit=0`: ninguna tabla responde 200 |

Si falla un 50, no se reintenta: `61-diagnose.sh` da el veredicto. La migración es aditiva y la app vieja no la necesita, así que no hace falta revertir el esquema para volver atrás el código.

**Volcado:** `runs/<ts>-backup/public.dump` tiene datos reales. Queda con permisos 0400 y no se copia ni se sube. Se borra a mano al cerrar la etapa, con constancia en el acta.

**Después de migrar:**
1. Merge del PR #28 (autorización aparte). Netlify publica el código nuevo.
2. Repetir el control manual del OWNER y abrir Configuración → Usuarios: tiene que mostrar "1 de 5" (o el uso real) y el OWNER protegido.
3. Cupo: `Organization.seatLimit` vale 5. Si el equipo necesita más plazas, cambiarlo es una escritura de PROD aparte, que no está en este procedimiento.
4. El runner de ARCA verifica sólo el historial de DEV; PROD no lo cambia.

## 2. Correo y piloto con una dirección

### 2.1 Supabase PROD · Authentication (sin secretos en el repo)

- **SMTP propio, obligatorio.** El integrado sólo entrega a miembros del equipo de Supabase y con un límite bajo por hora. Hace falta un proveedor con el dominio remitente verificado (SPF y DKIM). La clave SMTP se carga en el panel y no pasa por el repo ni por el chat.
- **URL Configuration:**
  - *Site URL*: `https://liquidadoriva.netlify.app`.
  - *Redirect URLs*: agregar la exacta `https://liquidadoriva.netlify.app/auth/accept-invite`. No usar comodines en PROD.
- **Email Templates:** las mismas de DEV.
  - *Invite user*: `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=invite`.
  - *Magic Link*: `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=magiclink`.
- **Providers → Email:** *Confirm email* activado; *Email OTP Expiration* `86400`; *Allow new users to sign up* **desactivado**.

### 2.2 Netlify · alcance exacto de las variables

Plan Pro, con alcances y secretos disponibles. Para las tres variables:
- **alcance solo `functions`**;
- **un único valor en el contexto `production`**;
- **sin valor** en Deploy Previews, Branch deploys, `dev` ni ramas.

| Variable | Valor | `is_secret` |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | clave secreta de **PROD** (`sb_secret_…` o `service_role`) | **sí** |
| `USER_INVITE_REDIRECT_URL` | `https://liquidadoriva.netlify.app/auth/accept-invite` | no |
| `USER_INVITE_EMAIL_ALLOWLIST` | piloto: **una** dirección exacta | no |

**A qué deploys llega el contexto `production`:** los deploys de `main` (el publicado y sus *permalinks*). No llega a ninguna Deploy Preview ni a otra rama. Se aplica desde el **siguiente** deploy de producción: hay que redeployar `main` después de cargarla. Un rollback a un deploy anterior corre con el entorno de ese deploy.

**Garantías y límites:**
- El secreto es de solo escritura: la API devuelve el valor enmascarado.
- El *secret scanning* hace fallar el build si el valor aparece en lo publicado. En el build aislado, con un valor centinela, no aparece en `.next/`.
- El envío sólo sale si el destino del enlace es exactamente `USER_INVITE_REDIRECT_URL`. Desde un permalink, la request trae otro host y el envío queda en `NOT_CONFIGURED`, aunque la clave esté disponible en esas funciones.

### 2.3 URL de activación

`https://liquidadoriva.netlify.app/auth/accept-invite?token_hash=…&type=invite|magiclink`

- **Pública:** fuera del control de sesión.
- **Sin efecto en el GET:** abrir la página no consume el token; lo consume el POST de "Activar acceso".
- **Correo confirmado:** exige correo confirmado según Auth y la invitación vigente de ese correo.
- **Vencimiento:** el enlace dura lo que diga *Email OTP Expiration*; la invitación, 7 días. Si el enlace vence, el OWNER usa **Reenviar**.

### 2.4 Allowlist en producción

- Se exige en **todos** los entornos: sin lista no sale ningún correo. `CONTEXT` no existe en el runtime de Netlify y no hay ninguna excepción para producción.
- **Piloto:** una sola dirección exacta, la del titular.
- **Equipo:** reemplazar la lista por las **direcciones exactas** del equipo, separadas por coma, y redeployar. `*@derocompany.com.ar` sirve sólo si todas las cuentas del equipo están en ese dominio; el comodín no cruza la `@`.
- **No existe "abierto a cualquier dirección"**: un `*` solo no coincide con ningún correo. Abrirlo es un cambio de código y una decisión aparte.

### 2.5 Piloto de punta a punta (una dirección)

1. Cargar 2.1 y 2.2 con autorización y redeployar `main`. Releer los metadatos (`scopes`, `contexts`) sin valores.
2. Como OWNER en producción, invitar a la dirección del piloto con permisos mínimos (Consulta, un cliente, un módulo). La respuesta tiene que ser `SENT`.
3. Recibir el correo y comprobar que el enlace apunte a `https://liquidadoriva.netlify.app/auth/accept-invite`. Abrirlo, definir la contraseña y entrar.
4. Verificar con esa sesión: clientes y módulos visibles; una URL fuera del alcance da 404.
5. Con la sesión abierta, el OWNER desactiva el acceso; al recargar, "Sin organización". Revocar o desactivar lo que quede.
6. Comprobar en Auth (logs) y en la base, en solo lectura: invitación ACCEPTED, membresía DISABLED, cupo de vuelta.
7. Recién entonces, poner la lista del equipo e invitar.

## 3. Lo que este procedimiento NO hace

- No limpia datos ni cuentas de prueba de DEV. Se conservan: los estudios `syn_users_*` y las 2 cuentas del piloto DEV, desactivadas.
- No cambia `seatLimit`, no habilita ARCA y no toca el runner de ARCA.
- No contempla abrir la allowlist ni alcances de secretos más amplios.
