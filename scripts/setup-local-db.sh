#!/usr/bin/env bash
# Creates local development and test databases on a running PostgreSQL (14+) and applies migrations.
# Usage: scripts/setup-local-db.sh        (connects with your default libpq settings: PGHOST, PGUSER, ...)
# The connecting role needs CREATEDB/CREATEROLE (a local superuser is fine). Production uses managed Postgres;
# see docs/ENVIRONMENTS.md.
set -euo pipefail
cd "$(dirname "$0")/.."

for db in disputeos_dev disputeos_test; do
  if ! psql -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1; then
    psql -d postgres -qc "create database $db"
    echo "created $db"
  fi
done

HOST="${PGHOST:-/var/run/postgresql}"
export DATABASE_URL="postgres://$(whoami)@%2F${HOST//\//%2F}/disputeos_dev"
[ "${HOST:0:1}" = "/" ] || export DATABASE_URL="postgres://${PGUSER:-$(whoami)}@${HOST}/disputeos_dev"
node scripts/migrate.mjs

export APP_ENV=test
export DATABASE_URL_TEST="${DATABASE_URL/disputeos_dev/disputeos_test}"
node scripts/migrate.mjs
echo "Local databases ready. Add DATABASE_URL to .env.local (see .env.example)."
