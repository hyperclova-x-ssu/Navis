-- Up Migration
CREATE TABLE marketing.outbox_scope (
    scope_key text PRIMARY KEY,
    last_seq bigint NOT NULL CHECK (last_seq > 0)
);

CREATE TABLE marketing.outbox (
    event_id uuid PRIMARY KEY,
    producer text NOT NULL DEFAULT 'marketing' CHECK (producer = 'marketing'),
    store_id uuid NOT NULL,
    scope_key text NOT NULL CHECK (scope_key = store_id::text),
    store_seq bigint NOT NULL CHECK (store_seq > 0),
    event_type text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    aggregate_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    published_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz,
    UNIQUE (scope_key, store_seq),
    UNIQUE (store_id, event_type, aggregate_id)
);
CREATE INDEX outbox_pending ON marketing.outbox (scope_key, store_seq) WHERE published_at IS NULL;

CREATE TABLE marketing.promo_job (
    store_id uuid NOT NULL,
    job_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action_key text NOT NULL CHECK (length(action_key) BETWEEN 8 AND 64),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    input jsonb NOT NULL,
    catalog_snapshot jsonb NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    stage text NOT NULL DEFAULT 'look' CHECK (stage IN ('look', 'story', 'scenes', 'merge')),
    lease_token uuid,
    lease_until timestamptz,
    dispatched_at timestamptz,
    next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    stage_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    fail_reason text,
    asset_id uuid,
    result jsonb,
    PRIMARY KEY (store_id, job_id),
    UNIQUE (store_id, action_key),
    CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
    CHECK (status = 'running' OR lease_token IS NULL),
    CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL)),
    CHECK ((status = 'failed') = (fail_reason IS NOT NULL)),
    CHECK ((status = 'done') = (asset_id IS NOT NULL AND result IS NOT NULL)),
    CHECK ((result IS NULL) = (asset_id IS NULL))
);
CREATE UNIQUE INDEX promo_job_active ON marketing.promo_job (store_id) WHERE status IN ('queued', 'running');

CREATE TABLE marketing.promo_checkpoint (
    store_id uuid NOT NULL,
    job_id uuid NOT NULL,
    stage text NOT NULL CHECK (stage IN ('look', 'story', 'scenes')),
    asset_id uuid NOT NULL,
    PRIMARY KEY (store_id, job_id, stage),
    FOREIGN KEY (store_id, job_id) REFERENCES marketing.promo_job (store_id, job_id) ON DELETE RESTRICT
);

CREATE TABLE marketing.promo_attempt (
    store_id uuid NOT NULL,
    job_id uuid NOT NULL,
    stage text NOT NULL CHECK (stage IN ('look', 'story', 'scenes', 'merge')),
    call_key text NOT NULL,
    attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 2),
    attempt_id uuid NOT NULL UNIQUE,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'received', 'not_sent')),
    asset_id uuid,
    usage jsonb,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz,
    PRIMARY KEY (store_id, job_id, stage, call_key, attempt_no),
    FOREIGN KEY (store_id, job_id) REFERENCES marketing.promo_job (store_id, job_id) ON DELETE RESTRICT,
    CHECK ((state = 'pending') = (settled_at IS NULL)),
    CHECK (state = 'received' OR (asset_id IS NULL AND usage IS NULL)),
    CHECK (usage IS NULL OR asset_id IS NOT NULL)
);

CREATE TABLE marketing.stream_checkpoint (
    consumer_group text NOT NULL,
    producer text NOT NULL,
    scope_key text NOT NULL,
    last_seq bigint NOT NULL CHECK (last_seq > 0),
    PRIMARY KEY (consumer_group, producer, scope_key)
);
CREATE TABLE marketing.stream_inbox (
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

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['promo_job', 'promo_checkpoint', 'promo_attempt', 'outbox', 'outbox_scope',
                                 'stream_inbox', 'stream_checkpoint'] LOOP
        EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY', name);
        EXECUTE format('ALTER TABLE marketing.%I FORCE ROW LEVEL SECURITY', name);
        EXECUTE format('CREATE POLICY marketing_scope ON marketing.%I TO marketing_mig, marketing_run USING (%s)',
            name,
            CASE
                WHEN name IN ('stream_inbox', 'stream_checkpoint')
                    THEN 'scope_key = (SELECT current_setting(''app.stream_scope'', true))'
                WHEN name = 'outbox_scope'
                    THEN 'scope_key = (SELECT current_setting(''app.store_id'', true))'
                ELSE 'store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid)'
            END);
    END LOOP;
END
$$;

GRANT SELECT, INSERT ON marketing.promo_job, marketing.promo_checkpoint, marketing.promo_attempt,
    marketing.outbox, marketing.outbox_scope, marketing.stream_checkpoint, marketing.stream_inbox TO marketing_run;
GRANT UPDATE (status, stage, lease_token, lease_until, dispatched_at, next_run_at, stage_started_at,
    finished_at, fail_reason, asset_id, result) ON marketing.promo_job TO marketing_run;
GRANT UPDATE (state, asset_id, usage, settled_at) ON marketing.promo_attempt TO marketing_run;
GRANT UPDATE (last_seq) ON marketing.outbox_scope, marketing.stream_checkpoint TO marketing_run;
GRANT UPDATE (status, attempts, retry_at, reason, envelope, notified_at) ON marketing.stream_inbox TO marketing_run;

-- Down Migration
DROP TABLE marketing.stream_inbox, marketing.stream_checkpoint, marketing.promo_attempt,
    marketing.promo_checkpoint, marketing.promo_job, marketing.outbox, marketing.outbox_scope;
