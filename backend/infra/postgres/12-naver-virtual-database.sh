#!/bin/bash
set -euo pipefail

psql_persona() {
  psql -Xq --host /var/run/postgresql --username "$POSTGRES_USER" --dbname "$1" --no-password --set ON_ERROR_STOP=1 "${@:2}"
}

psql_persona postgres <<'SQL'
SELECT format('CREATE ROLE %I LOGIN NOINHERIT', name)
FROM (VALUES ('nvirtual_mig'), ('nvirtual_run')) AS roles(name)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name)
\gexec
SELECT 'CREATE DATABASE naver_virtual TEMPLATE template0'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'naver_virtual')
\gexec
REVOKE ALL ON DATABASE naver_virtual FROM PUBLIC;
GRANT CONNECT ON DATABASE naver_virtual TO nvirtual_mig, nvirtual_run;
SQL

for role in nvirtual_mig nvirtual_run; do
  password=$(<"/run/navis-db/${role}_password")
  if [[ -z "$password" ]]; then
    printf 'Missing password for %s\n' "$role" >&2
    exit 1
  fi
  printf '%s\n%s\n' "$password" "$password" | psql_persona postgres -c "\\password $role"
done

psql_persona naver_virtual <<'SQL'
BEGIN;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS naver_virtual AUTHORIZATION nvirtual_mig;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA naver_virtual;
GRANT USAGE ON SCHEMA naver_virtual TO nvirtual_run;
ALTER ROLE nvirtual_mig IN DATABASE naver_virtual SET search_path TO naver_virtual;
ALTER ROLE nvirtual_run IN DATABASE naver_virtual SET search_path TO naver_virtual;
COMMIT;
SQL
