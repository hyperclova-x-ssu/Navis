#!/bin/bash
set -euo pipefail

# Initialize local worker logins before their domain migrations reference them.
psql_worker() {
  psql -Xq --host /var/run/postgresql --username "$POSTGRES_USER" --dbname postgres --no-password --set ON_ERROR_STOP=1 "$@"
}

for service in inventory pos; do
  role="${service}_wrk"
  password=$(<"/run/navis-db/${role}_password")
  if [[ -z "$password" ]]; then
    printf 'Missing password for %s\n' "$role" >&2
    exit 1
  fi

  psql_worker -v db="$service" -v worker="$role" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('navis:worker-login', 0)) AS locked \gset
SELECT format('CREATE ROLE %I LOGIN NOINHERIT', :'worker')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'worker')
\gexec
GRANT CONNECT ON DATABASE :"db" TO :"worker";
ALTER ROLE :"worker" IN DATABASE :"db" SET search_path TO :"db";
COMMIT;
SQL

  printf '%s\n%s\n' "$password" "$password" | psql_worker -c "\\password $role"
done
