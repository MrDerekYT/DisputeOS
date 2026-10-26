#!/usr/bin/env bash
# Runs the RLS tenant-isolation suite against a throwaway database.
# Usage: PGHOST=... PGUSER=... PGPASSWORD=... scripts/test-rls.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB="dispute_rls_test_$$"
psql -v ON_ERROR_STOP=1 -d postgres -qc "create database $DB"
trap 'psql -d postgres -qc "drop database if exists $DB" >/dev/null' EXIT
export PGDATABASE="$DB"
psql -v ON_ERROR_STOP=1 -q -f supabase/tests/00_auth_stub.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -v ON_ERROR_STOP=1 -f supabase/tests/rls_tenant_isolation.sql
echo "RLS suite passed"
