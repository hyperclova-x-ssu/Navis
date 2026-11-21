-- Up Migration
CREATE TABLE marketing.sens_attempt (
    store_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action_key text NOT NULL CHECK (length(action_key) BETWEEN 8 AND 64),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    draft_id text NOT NULL CHECK (draft_id ~ '^[A-Za-z0-9_-]{1,80}$'),
    draft_session_id uuid NOT NULL,
    sample_id text NOT NULL CHECK (sample_id ~ '^[A-Za-z0-9_-]{1,80}$'),
    target_alias text NOT NULL CHECK (target_alias ~ '^[A-Za-z0-9_-]{1,80}$'),
    routing_hash text NOT NULL CHECK (routing_hash ~ '^[0-9a-f]{64}$'),
    body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'uncertain', 'retryable', 'accepted', 'blocked', 'failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    dispatched_at timestamptz,
    send_token uuid,
    first_send_at timestamptz,
    retry_send_at timestamptz,
    provider_request_id text CHECK (provider_request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    accepted_at timestamptz,
    delivery_state text CHECK (delivery_state IN ('pending', 'delivered', 'failed')),
    delivery_at timestamptz,
    PRIMARY KEY (store_id, receipt_id),
    UNIQUE (store_id, action_key),
    UNIQUE (store_id, actor_id, draft_session_id, sample_id),
    CHECK ((send_token IS NULL) = (first_send_at IS NULL)),
    CHECK (retry_send_at IS NULL OR (first_send_at IS NOT NULL AND retry_send_at >= first_send_at)),
    CHECK (state NOT IN ('sending', 'uncertain', 'retryable', 'accepted', 'failed') OR send_token IS NOT NULL),
    CHECK (state <> 'queued' OR send_token IS NULL),
    CHECK (state <> 'retryable' OR retry_send_at IS NULL),
    CHECK (state NOT IN ('queued', 'retryable', 'failed') OR provider_request_id IS NULL),
    CHECK ((state = 'accepted') = (accepted_at IS NOT NULL)),
    CHECK (accepted_at IS NULL OR provider_request_id IS NOT NULL),
    CHECK ((accepted_at IS NULL) = (delivery_state IS NULL)),
    CHECK ((delivery_at IS NOT NULL) = coalesce(delivery_state IN ('delivered', 'failed'), false))
);
CREATE UNIQUE INDEX sens_attempt_open ON marketing.sens_attempt (store_id)
    WHERE state IN ('queued', 'sending', 'uncertain', 'retryable');
CREATE INDEX sens_attempt_reserved ON marketing.sens_attempt (store_id, created_at DESC);
CREATE INDEX sens_attempt_first_send ON marketing.sens_attempt (store_id, first_send_at DESC) WHERE first_send_at IS NOT NULL;
CREATE INDEX sens_attempt_retry_send ON marketing.sens_attempt (store_id, retry_send_at DESC) WHERE retry_send_at IS NOT NULL;

ALTER TABLE marketing.sens_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.sens_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_scope ON marketing.sens_attempt TO marketing_migrate, marketing_runtime
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

GRANT SELECT, INSERT ON marketing.sens_attempt TO marketing_runtime;
GRANT UPDATE (state, dispatched_at, send_token, first_send_at, retry_send_at,
    provider_request_id, accepted_at, delivery_state, delivery_at) ON marketing.sens_attempt TO marketing_runtime;

-- Down Migration
DROP TABLE marketing.sens_attempt;
