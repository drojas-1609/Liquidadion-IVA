#!/usr/bin/env bash
# Regresión de la ficha de clientes contra un PostgreSQL 17 LOCAL Y DESCARTABLE.
#
#  1. Crea un clúster temporal (initdb, sólo 127.0.0.1, sin socket Unix).
#  2. Aplica TODAS las migraciones del repositorio con `prisma migrate deploy`.
#  3. Verifica que schema.prisma y las migraciones no difieren (prisma migrate
#     diff con una base shadow del mismo clúster).
#  4. Corre tests/integration/client-profile-pg.test.ts contra ese clúster.
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

CLEAN_ENV=(env -i PATH="$PATH" HOME="$HOME" CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 NEXT_TELEMETRY_DISABLED=1)
( cd "$REPO" && "${CLEAN_ENV[@]}" DATABASE_URL="$URL" DIRECT_URL="$URL" npx --no-install prisma migrate deploy ) \
  || { tail -20 "$TMP/server.log"; die "falló prisma migrate deploy en el clúster local"; }
"${PG_BIN}/psql" "$URL" -X -qAt -c \
  "SELECT 'migraciones aplicadas: ' || count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
"${PG_BIN}/psql" "$URL" -X -qAt -c \
  "SELECT 'FK alícuota->jurisdicción: ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ClientActivityRate_clientId_organizationId_jurisdictionCod_fkey'"

# schema.prisma y las migraciones describen el MISMO esquema (base shadow local).
"${PG_BIN}/psql" "$URL" -X -qAt -c "CREATE DATABASE prisma_shadow" >/dev/null
SHADOW="postgresql://postgres@127.0.0.1:${PORT}/prisma_shadow"
( cd "$REPO" && "${CLEAN_ENV[@]}" npx --no-install prisma migrate diff --from-migrations prisma/migrations \
    --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW" --exit-code >/dev/null ) \
  && echo "schema.prisma == migraciones: sin diferencias" || die "schema.prisma y las migraciones difieren"

( cd "$REPO" && "${CLEAN_ENV[@]}" PR17_LOCAL_PG_URL="$URL" npx --no-install vitest run tests/integration/client-profile-pg.test.ts )
