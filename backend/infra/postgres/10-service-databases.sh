#!/bin/bash
set -euo pipefail

psql_init() {
  psql -Xq --username "$POSTGRES_USER" --dbname "$1" --no-password --set ON_ERROR_STOP=1 "${@:2}"
}

psql_init postgres <<'SQL'
REVOKE ALL ON DATABASE postgres, template0, template1 FROM PUBLIC;
SQL

for service in account pos inventory customer marketing insight; do
  migrate="${service}_migrate"
  runtime="${service}_runtime"

  # The names come from the fixed service list above. psql quotes them as identifiers.
  psql_init postgres -v db="$service" -v migrate="$migrate" -v runtime="$runtime" <<'SQL'
CREATE ROLE :"migrate" LOGIN NOINHERIT;
CREATE ROLE :"runtime" LOGIN NOINHERIT;
CREATE DATABASE :"db" TEMPLATE template0;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"migrate", :"runtime";
SQL

  # psql hashes the password client-side before sending the ALTER ROLE.
  for role in "$migrate" "$runtime"; do
    password=$(<"/run/navis-db/${role}_password")
    if [[ -z "$password" ]]; then
      printf 'Missing password for %s\n' "$role" >&2
      exit 1
    fi
    printf '%s\n%s\n' "$password" "$password" | psql_init postgres -c "\\password $role"
    unset password
  done

  psql_init "$service" -v db="$service" -v migrate="$migrate" -v runtime="$runtime" <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA :"db" AUTHORIZATION :"migrate";
GRANT USAGE ON SCHEMA :"db" TO :"runtime";
ALTER ROLE :"migrate" IN DATABASE :"db" SET search_path TO :"db";
ALTER ROLE :"runtime" IN DATABASE :"db" SET search_path TO :"db";
SQL
done
