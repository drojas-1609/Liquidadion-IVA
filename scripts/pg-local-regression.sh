#!/usr/bin/env bash
# Regresión de la ficha de clientes contra un PostgreSQL 17 LOCAL Y DESCARTABLE.
#
#  1. Crea un clúster temporal (initdb, sólo 127.0.0.1, sin socket Unix).
#  2. Aplica TODAS las migraciones del repositorio con `prisma migrate deploy`.
#  3. Verifica que schema.prisma y las migraciones no difieren (prisma migrate
#     diff con una base shadow del mismo clúster).
#  4. Corre las pruebas de integración locales (ficha de clientes, usuarios del estudio, WSAA y
#     controles de ARCA en producción) contra ese clúster, más una base con el
#     esquema del DEV actual (sin la última migración) para probar el cierre.
#  5. Detiene y borra el clúster (también ante errores).
#
# No usa ni hereda credenciales: los procesos hijos corren con `env -i` y sólo
# reciben la URL local. Se niega a correr si el shell tiene variables de
# conexión definidas. Uso: scripts/pg-local-regression.sh
set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PR17_LOCAL_PG_PORT:-55432}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

die() { printf 'DETENIDO: %s\n' "$*" >&2; exit 1; }
for v in DATABASE_URL DIRECT_URL PGHOST PGPASSWORD PGUSER PGDATABASE PGSERVICE; do
  [ -z "${!v:-}" ] || die "la variable ${v} está definida en el shell: abrí una terminal limpia"
done
for t in initdb pg_ctl psql; do [ -x "${PG_BIN}/${t}" ] || die "falta ${PG_BIN}/${t}"; done
case "$("${PG_BIN}/psql" --version)" in *"(PostgreSQL) 17."*) ;; *) die "se requiere PostgreSQL 17";; esac
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then die "el puerto ${PORT} está ocupado"; fi

TMP="$(mktemp -d -t pr17-pg)"
cleanup() {
  "${PG_BIN}/pg_ctl" -D "$TMP/data" -m fast -w stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

"${PG_BIN}/initdb" -D "$TMP/data" -U postgres -A trust -E UTF8 --no-locale >/dev/null
"${PG_BIN}/pg_ctl" -D "$TMP/data" -l "$TMP/server.log" -w \
  -o "-p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
URL="postgresql://postgres@127.0.0.1:${PORT}/postgres"
echo "PostgreSQL local: $("${PG_BIN}/psql" "$URL" -X -qAt -c 'SHOW server_version')"

# Un único clúster compartido: los archivos corren en serie (algunos vacían tablas).
# Roles sintéticos y permisos por defecto como los que puede heredar una tabla en Supabase.
"${PG_BIN}/psql" "$URL" -X -v ON_ERROR_STOP=1 -q -c 'CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role;' >/dev/null

# LID_VOLUME=1 habilita la prueba de volumen del Libro IVA Digital (opcional, más lenta).
CLEAN_ENV=(env -i PATH="$PATH" HOME="$HOME" CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 NEXT_TELEMETRY_DISABLED=1 LID_VOLUME="${LID_VOLUME:-0}")
( cd "$REPO" && "${CLEAN_ENV[@]}" DATABASE_URL="$URL" DIRECT_URL="$URL" npx --no-install prisma migrate deploy ) \
  || { tail -20 "$TMP/server.log"; die "falló prisma migrate deploy en el clúster local"; }
"${PG_BIN}/psql" "$URL" -X -qAt -c \
  "SELECT 'migraciones aplicadas: ' || count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
"${PG_BIN}/psql" "$URL" -X -qAt -c \
  "SELECT 'FK alícuota->jurisdicción: ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ClientActivityRate_clientId_organizationId_jurisdictionCod_fkey'"

# Migraciones posteriores al DEV actual (todavía no aplicadas en DEV): quedan fuera
# de las bases "tipo DEV" y del precheck del runner, que verifica la lista exacta
# de DEV (scripts/arca/homologation-runner.ts EXPECTED_MIGRATIONS).
NOT_IN_DEV='^20261106120000_vat_credit_adjustments$'
# Última migración aplicada en DEV: runner_prev representa el DEV anterior a ella.
LAST_IN_DEV='^20261104230000_add_operator_role$'

# Base con el esquema del DEV actual: todas las migraciones salvo la de controles de producción.
"${PG_BIN}/psql" "$URL" -X -qAt -c "CREATE DATABASE devlike" >/dev/null
DEVLIKE="postgresql://postgres@127.0.0.1:${PORT}/devlike"
for m in $(cd "$REPO/prisma/migrations" && ls -d */ | tr -d / | grep -v '^20261102120000_arca_production_controls$' | grep -v "$NOT_IN_DEV" | sort); do
  "${PG_BIN}/psql" "$DEVLIKE" -X -q -v ON_ERROR_STOP=1 -f "$REPO/prisma/migrations/$m/migration.sql" >/dev/null || die "falló $m en devlike"
done

# Bases propias del precheck del runner, aplicadas con Prisma (con _prisma_migrations):
# runner_prev = las 12 previas (esquema anterior) y runner_cur = las 13. Privilegios por
# defecto sobre tablas y secuencias como los que puede heredar un objeto en Supabase.
RUNNER_PRISMA="$TMP/runner-prisma"
mkdir -p "$RUNNER_PRISMA/migrations"; cp "$REPO/prisma/schema.prisma" "$RUNNER_PRISMA/"; cp "$REPO/prisma/migrations/migration_lock.toml" "$RUNNER_PRISMA/migrations/"
for m in $(cd "$REPO/prisma/migrations" && ls -d */ | tr -d / | grep -v "$LAST_IN_DEV" | grep -v "$NOT_IN_DEV"); do cp -R "$REPO/prisma/migrations/$m" "$RUNNER_PRISMA/migrations/"; done
# runner_cur = el DEV actual (las 13), también sin las migraciones posteriores.
RUNNER_CUR_PRISMA="$TMP/runner-cur-prisma"
mkdir -p "$RUNNER_CUR_PRISMA/migrations"; cp "$REPO/prisma/schema.prisma" "$RUNNER_CUR_PRISMA/"; cp "$REPO/prisma/migrations/migration_lock.toml" "$RUNNER_CUR_PRISMA/migrations/"
for m in $(cd "$REPO/prisma/migrations" && ls -d */ | tr -d / | grep -v "$NOT_IN_DEV"); do cp -R "$REPO/prisma/migrations/$m" "$RUNNER_CUR_PRISMA/migrations/"; done
for db in runner_prev runner_cur; do
  "${PG_BIN}/psql" "$URL" -X -qAt -c "CREATE DATABASE $db" >/dev/null
  "${PG_BIN}/psql" "postgresql://postgres@127.0.0.1:${PORT}/$db" -X -q -v ON_ERROR_STOP=1 -c 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;' >/dev/null
done
RUNNER_PREV="postgresql://postgres@127.0.0.1:${PORT}/runner_prev"
RUNNER_CUR="postgresql://postgres@127.0.0.1:${PORT}/runner_cur"
( cd "$REPO" && "${CLEAN_ENV[@]}" DATABASE_URL="$RUNNER_PREV" DIRECT_URL="$RUNNER_PREV" npx --no-install prisma migrate deploy --schema "$RUNNER_PRISMA/schema.prisma" ) >/dev/null || die "falló deploy runner_prev"
( cd "$REPO" && "${CLEAN_ENV[@]}" DATABASE_URL="$RUNNER_CUR" DIRECT_URL="$RUNNER_CUR" npx --no-install prisma migrate deploy --schema "$RUNNER_CUR_PRISMA/schema.prisma" ) >/dev/null || die "falló deploy runner_cur"

# schema.prisma y las migraciones describen el MISMO esquema (base shadow local).
"${PG_BIN}/psql" "$URL" -X -qAt -c "CREATE DATABASE prisma_shadow" >/dev/null
SHADOW="postgresql://postgres@127.0.0.1:${PORT}/prisma_shadow"
( cd "$REPO" && "${CLEAN_ENV[@]}" npx --no-install prisma migrate diff --from-migrations prisma/migrations \
    --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW" --exit-code >/dev/null ) \
  && echo "schema.prisma == migraciones: sin diferencias" || die "schema.prisma y las migraciones difieren"

( cd "$REPO" && "${CLEAN_ENV[@]}" PR17_LOCAL_PG_URL="$URL" PR17_LOCAL_PG_DEVLIKE_URL="$DEVLIKE" PR17_LOCAL_PG_RUNNER_PREV_URL="$RUNNER_PREV" PR17_LOCAL_PG_RUNNER_URL="$RUNNER_CUR" npx --no-install vitest run --no-file-parallelism tests/integration/client-profile-pg.test.ts tests/integration/arca-wsaa-pg.test.ts tests/integration/arca-production-pg.test.ts tests/integration/arca-devlike-pg.test.ts tests/integration/arca-runner-precheck-pg.test.ts tests/integration/users-permissions-pg.test.ts tests/integration/period-totals-pg.test.ts tests/integration/vat-position-pg.test.ts tests/integration/libro-iva-import-pg.test.ts tests/integration/libro-iva-import-volume-pg.test.ts )

# Ensayo de la prueba DEV de usuarias sintéticas (tests/dev-smoke) contra el clúster local,
# DESPUÉS de las pruebas anteriores: sus datos hacen de "estudio real" que no debe cambiar.
( cd "$REPO" && "${CLEAN_ENV[@]}" USERS_DEV_SMOKE_REHEARSAL_URL="$URL" npx --no-install vitest run tests/dev-smoke/users-dev-smoke.test.ts )
