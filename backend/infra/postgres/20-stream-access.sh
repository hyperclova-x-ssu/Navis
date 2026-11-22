#!/bin/bash
set -euo pipefail

# Run after service migrations to grant relay access to the outboxes.
# Cloud DB mode uses the API-created migration logins and libpq connection settings.
case "${1:-}" in
  "") ;;
  --grants-only) : "${PGHOST:?Set PGHOST for the Cloud DB connection}" ;;
  *) printf 'Usage: %s [--grants-only]\n' "$0" >&2; exit 2 ;;
esac

psql_streams() {
  psql -Xq --username "$db_user" --dbname "$1" --no-password --set ON_ERROR_STOP=1 "${@:2}"
}

for service in pos inventory customer; do
  migrate="${service}_mig"
  relay="${service}_rly"
  if [[ "${1:-}" == --grants-only ]]; then
    db_user="$migrate"
  else
    db_user="$POSTGRES_USER"
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
  fi

  worker="${service}_wrk"
  psql_streams "$service" -v db="$service" -v relay="$relay" \
    -v migrate="$migrate" -v runtime="${service}_run" -v worker="$worker" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('navis:stream-access', 0)) AS locked \gset
SET LOCAL ROLE :"migrate";
GRANT USAGE ON SCHEMA :"db" TO :"relay";

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

SELECT :'db' IN ('inventory', 'pos') AS has_worker,
       CASE WHEN :'db' = 'pos' THEN 'inventory' ELSE 'pos' END AS worker_producer,
       CASE WHEN :'db' = 'pos' THEN 'stream_receipt_worker_scope' ELSE 'stream_stock_worker_scope' END AS worker_policy
\gset
\if :has_worker
GRANT USAGE ON SCHEMA :"db" TO :"worker";
DROP POLICY IF EXISTS :"worker_policy" ON :"db".stream_checkpoint;
CREATE POLICY :"worker_policy" ON :"db".stream_checkpoint TO :"worker"
    USING (consumer_group = :'db' AND producer = :'worker_producer'
        AND scope_key = nullif(current_setting('app.stream_scope', true), ''))
    WITH CHECK (consumer_group = :'db' AND producer = :'worker_producer'
        AND scope_key = nullif(current_setting('app.stream_scope', true), ''));
DROP POLICY IF EXISTS :"worker_policy" ON :"db".stream_inbox;
CREATE POLICY :"worker_policy" ON :"db".stream_inbox TO :"worker"
    USING (consumer_group = :'db' AND producer = :'worker_producer'
        AND scope_key = nullif(current_setting('app.stream_scope', true), ''))
    WITH CHECK (consumer_group = :'db' AND producer = :'worker_producer'
        AND scope_key = nullif(current_setting('app.stream_scope', true), ''));
GRANT SELECT, INSERT, UPDATE (last_seq) ON :"db".stream_checkpoint TO :"worker";
GRANT SELECT, INSERT, UPDATE (status, attempts, retry_at, reason, envelope, notified_at)
    ON :"db".stream_inbox TO :"worker";
\endif

-- Catch up a finance migration applied before the receipt worker login existed.
SELECT :'db' = 'pos' AND EXISTS (
    SELECT FROM pg_attribute WHERE attrelid = to_regclass('pos.expense_candidate')
        AND attname = 'undo_until' AND NOT attisdropped
) AS has_finance \gset
\if :has_finance
DROP POLICY IF EXISTS receipt_worker_store_scope ON pos.store;
CREATE POLICY receipt_worker_store_scope ON pos.store FOR INSERT TO pos_wrk
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT INSERT (store_id) ON pos.store TO pos_wrk;
DROP POLICY IF EXISTS receipt_worker_scope ON pos.expense_candidate;
CREATE POLICY receipt_worker_scope ON pos.expense_candidate TO pos_wrk
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT ON pos.expense_candidate TO pos_wrk;
GRANT INSERT (store_id, receipt_id, expense_id, supplier_id, business_date, amount, undo_until),
    UPDATE (status, revision) ON pos.expense_candidate TO pos_wrk;
\endif

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
