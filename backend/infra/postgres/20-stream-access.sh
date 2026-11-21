#!/bin/bash
set -euo pipefail

# Also run this directly in the local db container after service migrations.
# Bootstrap creates the roles and consumer state on new and existing volumes.
psql_streams() {
  psql -Xq --username "$POSTGRES_USER" --dbname "$1" --no-password --set ON_ERROR_STOP=1 "${@:2}"
}

for service in pos inventory customer; do
  relay="${service}_relay"
  psql_streams postgres -v db="$service" -v relay="$relay" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('navis:stream-access', 0)) AS locked \gset
SELECT format('CREATE ROLE %I LOGIN NOINHERIT', :'relay')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'relay')
\gexec
GRANT CONNECT ON DATABASE :"db" TO :"relay";
COMMIT;
SQL

  password=$(<"/run/navis-db/${relay}_password")
  if [[ -z "$password" ]]; then
    printf 'Missing password for %s\n' "$relay" >&2
    exit 1
  fi
  printf '%s\n%s\n' "$password" "$password" | psql_streams postgres -c "\\password $relay"
  unset password

  psql_streams "$service" -v db="$service" -v relay="$relay" \
    -v migrate="${service}_migrate" -v runtime="${service}_runtime" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('navis:stream-access', 0)) AS locked \gset
GRANT USAGE ON SCHEMA :"db" TO :"relay";
SET LOCAL ROLE :"migrate";

CREATE TABLE IF NOT EXISTS :"db".stream_checkpoint (
    consumer_group text NOT NULL,
    producer text NOT NULL,
    scope_key text NOT NULL,
    last_seq bigint NOT NULL CHECK (last_seq > 0),
    PRIMARY KEY (consumer_group, producer, scope_key)
);

CREATE TABLE IF NOT EXISTS :"db".stream_inbox (
    consumer_group text NOT NULL,
    producer text NOT NULL,
    scope_key text NOT NULL,
    store_seq bigint NOT NULL CHECK (store_seq > 0),
    event_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('retry', 'quarantined', 'applied', 'ignored')),
    attempts integer NOT NULL CHECK (attempts > 0),
    retry_at timestamptz,
    reason text,
    envelope jsonb,
    notified_at timestamptz,
    PRIMARY KEY (consumer_group, event_id),
    UNIQUE (consumer_group, producer, scope_key, store_seq),
    CHECK ((status = 'retry') = (retry_at IS NOT NULL)),
    CHECK (status <> 'quarantined' OR (reason IS NOT NULL AND envelope IS NOT NULL))
);

ALTER TABLE :"db".stream_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE :"db".stream_checkpoint FORCE ROW LEVEL SECURITY;
ALTER TABLE :"db".stream_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE :"db".stream_inbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stream_runtime_scope ON :"db".stream_checkpoint;
CREATE POLICY stream_runtime_scope ON :"db".stream_checkpoint TO :"runtime", :"migrate"
    USING (scope_key = current_setting('app.stream_scope', true));
DROP POLICY IF EXISTS stream_runtime_scope ON :"db".stream_inbox;
CREATE POLICY stream_runtime_scope ON :"db".stream_inbox TO :"runtime", :"migrate"
    USING (scope_key = current_setting('app.stream_scope', true));
DROP POLICY IF EXISTS stream_relay_checkpoint ON :"db".stream_checkpoint;
CREATE POLICY stream_relay_checkpoint ON :"db".stream_checkpoint FOR SELECT TO :"relay"
    USING (consumer_group = :'db');

GRANT SELECT, INSERT, UPDATE (last_seq) ON :"db".stream_checkpoint TO :"runtime";
GRANT SELECT, INSERT, UPDATE (status, attempts, retry_at, reason, envelope, notified_at)
    ON :"db".stream_inbox TO :"runtime";
GRANT SELECT ON :"db".stream_checkpoint TO :"relay";

-- The inventory outbox arrives with the T-308 migration. Re-run this script
-- after that migration, as for POS after its ledger migration.
SELECT to_regclass(format('%I.outbox', :'db')) IS NOT NULL AS has_outbox \gset
\if :has_outbox
ALTER TABLE :"db".outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE :"db".outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stream_relay_read ON :"db".outbox;
CREATE POLICY stream_relay_read ON :"db".outbox FOR SELECT TO :"relay"
    USING (producer = :'db');
DROP POLICY IF EXISTS stream_relay_mark ON :"db".outbox;
CREATE POLICY stream_relay_mark ON :"db".outbox FOR UPDATE TO :"relay"
    USING (producer = :'db') WITH CHECK (producer = :'db');
GRANT SELECT, UPDATE (published_at, attempt_count, next_attempt_at) ON :"db".outbox TO :"relay";
\endif
COMMIT;
SQL
done
