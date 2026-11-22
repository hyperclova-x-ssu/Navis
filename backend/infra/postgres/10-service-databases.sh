#!/bin/bash
set -euo pipefail

psql_init() {
  psql -Xq --host /var/run/postgresql --username "$POSTGRES_USER" --dbname "$1" --no-password --set ON_ERROR_STOP=1 "${@:2}"
}

set_local_password() {
  local role="$1" password
  password=$(<"/run/navis-db/${role}_password")
  if [[ -z "$password" ]]; then
    printf 'Missing password for %s\n' "$role" >&2
    exit 1
  fi
  # psql hashes the password client-side before sending the ALTER ROLE.
  printf '%s\n%s\n' "$password" "$password" | psql_init postgres -c "\\password $role"
}

# Keep role OIDs, ownership, grants and RLS policies on pre-rename Compose volumes.
if [[ "${1:-}" == --upgrade-local-roles ]]; then
  psql_init postgres <<'SQL'
BEGIN;
WITH service(name) AS (VALUES ('account'), ('pos'), ('inventory'), ('customer'), ('marketing'), ('insight')),
suffix(old, new) AS (VALUES ('migrate', 'mig'), ('runtime', 'run'), ('relay', 'rly'), ('worker', 'wrk'))
SELECT format('ALTER ROLE %I RENAME TO %I', rolname, name || '_' || new)
FROM service CROSS JOIN suffix
JOIN pg_roles ON rolname = name || '_' || old
WHERE old IN ('migrate', 'runtime') OR (old = 'relay' AND name <> 'account') OR (old = 'worker' AND name = 'marketing')
\gexec
COMMIT;
SQL
  # Older account policies also refer to the migration user by name in their expressions.
  psql_init account <<'SQL'
SELECT format('ALTER POLICY %I ON account.%I USING (%s)', policyname, tablename,
              replace(qual, quote_literal('account_migrate'), quote_literal('account_mig')))
FROM pg_policies
WHERE schemaname = 'account'
  AND (tablename, policyname) IN (('store', 'store_scope'), ('store_member', 'store_member_scope'),
    ('auth_session', 'auth_session_scope'), ('refresh_token', 'refresh_token_scope'))
  AND strpos(qual, quote_literal('account_migrate')) > 0
\gexec
SQL
  roles="$(psql_init postgres -Atc "SELECT rolname FROM pg_roles WHERE rolname ~ '^((account|pos|inventory|customer|marketing|insight)_(mig|run)|(pos|inventory|customer|marketing|insight)_rly|marketing_wrk)$'")"
  while IFS= read -r role; do
    [[ -z "$role" ]] || set_local_password "$role"
  done <<< "$roles"
  exit 0
fi
if [[ $# != 0 ]]; then
  printf 'Usage: %s [--upgrade-local-roles]\n' "$0" >&2
  exit 2
fi

psql_init postgres <<'SQL'
REVOKE ALL ON DATABASE postgres, template0, template1 FROM PUBLIC;
SQL

for service in account pos inventory customer marketing insight; do
  migrate="${service}_mig"
  runtime="${service}_run"

  # The names come from the fixed service list above. psql quotes them as identifiers.
  psql_init postgres -v db="$service" -v migrate="$migrate" -v runtime="$runtime" <<'SQL'
CREATE ROLE :"migrate" LOGIN NOINHERIT;
CREATE ROLE :"runtime" LOGIN NOINHERIT;
CREATE DATABASE :"db" TEMPLATE template0;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"migrate", :"runtime";
SQL

  set_local_password "$migrate"
  set_local_password "$runtime"

  psql_init "$service" -v db="$service" -v migrate="$migrate" -v runtime="$runtime" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA :"db" AUTHORIZATION :"migrate";
GRANT USAGE ON SCHEMA :"db" TO :"runtime";
ALTER ROLE :"migrate" IN DATABASE :"db" SET search_path TO :"db";
ALTER ROLE :"runtime" IN DATABASE :"db" SET search_path TO :"db";
SQL
done
