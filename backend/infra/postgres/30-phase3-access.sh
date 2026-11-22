#!/bin/bash
set -euo pipefail

# Cloud DB mode uses the API-created migration logins and libpq connection settings.
grants_only=0
case "${1:-}" in
  "") ;;
  --grants-only) : "${PGHOST:?Set PGHOST for the Cloud DB connection}"; grants_only=1 ;;
  *) printf 'Usage: %s [--grants-only]\n' "$0" >&2; exit 2 ;;
esac

psql_phase3() {
  local db_user
  if [[ "$grants_only" == 1 ]]; then db_user="${1}_mig"; else db_user="$POSTGRES_USER"; fi
  psql -Xq --username "$db_user" --dbname "$1" --no-password --set ON_ERROR_STOP=1 "${@:2}"
}

if [[ "$grants_only" == 0 ]]; then
  for identity in marketing_rly insight_rly marketing_wrk; do
    database="${identity%_*}"
    psql_phase3 postgres -v db="$database" -v identity="$identity" <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('navis:phase3-access', 0)) AS locked \gset
SELECT format('CREATE ROLE %I LOGIN NOINHERIT', :'identity')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'identity')
\gexec
GRANT CONNECT ON DATABASE :"db" TO :"identity";
COMMIT;
SQL

    password=$(<"/run/navis-db/${identity}_password")
    if [[ -z "$password" ]]; then printf 'Missing password for %s\n' "$identity" >&2; exit 1; fi
    printf '%s\n%s\n' "$password" "$password" | psql_phase3 postgres -c "\\password $identity"
    unset password
  done
fi

# At initial Postgres bootstrap the tables do not exist. Run again after migrations.
psql_phase3 insight <<'SQL'
BEGIN;
GRANT USAGE ON SCHEMA insight TO insight_rly;
SELECT to_regclass('insight.stream_checkpoint') IS NOT NULL AS ready \gset
\if :ready
DROP POLICY IF EXISTS stream_relay_checkpoint ON insight.stream_checkpoint;
CREATE POLICY stream_relay_checkpoint ON insight.stream_checkpoint FOR SELECT TO insight_rly
  USING (consumer_group IN ('insight', 'insight-tables') AND producer = 'pos');
GRANT SELECT (consumer_group, producer, scope_key, last_seq) ON insight.stream_checkpoint TO insight_rly;
\endif
SELECT to_regclass('insight.outbox') IS NOT NULL AS outbox_ready \gset
\if :outbox_ready
DROP POLICY IF EXISTS stream_relay_read ON insight.outbox;
CREATE POLICY stream_relay_read ON insight.outbox FOR SELECT TO insight_rly USING (producer = 'insight');
DROP POLICY IF EXISTS stream_relay_mark ON insight.outbox;
CREATE POLICY stream_relay_mark ON insight.outbox FOR UPDATE TO insight_rly
  USING (producer = 'insight') WITH CHECK (producer = 'insight');
GRANT SELECT, UPDATE (published_at, attempt_count, next_attempt_at) ON insight.outbox TO insight_rly;
\endif
COMMIT;
SQL

psql_phase3 marketing <<'SQL'
BEGIN;
GRANT USAGE ON SCHEMA marketing TO marketing_rly, marketing_wrk;
SELECT to_regclass('marketing.sens_attempt') IS NOT NULL AS ready \gset
\if :ready
DROP POLICY IF EXISTS stream_relay_checkpoint ON marketing.stream_checkpoint;
CREATE POLICY stream_relay_checkpoint ON marketing.stream_checkpoint FOR SELECT TO marketing_rly
  USING ((consumer_group = 'marketing-worker' AND producer = 'marketing')
    OR (consumer_group = 'marketing-supplier' AND producer = 'inventory')
    OR (consumer_group = 'marketing' AND producer IN ('pos', 'customer')));
GRANT SELECT (consumer_group, producer, scope_key, last_seq) ON marketing.stream_checkpoint TO marketing_rly;

DROP POLICY IF EXISTS stream_relay_read ON marketing.outbox;
CREATE POLICY stream_relay_read ON marketing.outbox FOR SELECT TO marketing_rly USING (producer = 'marketing');
DROP POLICY IF EXISTS stream_relay_mark ON marketing.outbox;
CREATE POLICY stream_relay_mark ON marketing.outbox FOR UPDATE TO marketing_rly
  USING (producer = 'marketing') WITH CHECK (producer = 'marketing');
GRANT SELECT, UPDATE (published_at, attempt_count, next_attempt_at) ON marketing.outbox TO marketing_rly;

DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['promo_job', 'promo_checkpoint', 'promo_attempt', 'sens_attempt',
                                'stream_inbox', 'stream_checkpoint'] LOOP
    EXECUTE format('ALTER POLICY marketing_scope ON marketing.%I TO marketing_mig, marketing_run, marketing_wrk', name);
  END LOOP;
END
$$;
GRANT SELECT ON marketing.promo_job, marketing.sens_attempt TO marketing_wrk;
GRANT SELECT, INSERT ON marketing.promo_checkpoint, marketing.promo_attempt,
  marketing.stream_checkpoint, marketing.stream_inbox TO marketing_wrk;
GRANT UPDATE (status, stage, lease_token, lease_until, dispatched_at, next_run_at, stage_started_at,
  finished_at, fail_reason, asset_id, result) ON marketing.promo_job TO marketing_wrk;
GRANT UPDATE (state, asset_id, usage, settled_at) ON marketing.promo_attempt TO marketing_wrk;
GRANT UPDATE (state, dispatched_at, send_token, first_send_at, retry_send_at, provider_request_id,
  accepted_at, delivery_state, delivery_at) ON marketing.sens_attempt TO marketing_wrk;
GRANT UPDATE (last_seq) ON marketing.stream_checkpoint TO marketing_wrk;
GRANT UPDATE (status, attempts, retry_at, reason, envelope, notified_at) ON marketing.stream_inbox TO marketing_wrk;
\endif
COMMIT;
SQL
