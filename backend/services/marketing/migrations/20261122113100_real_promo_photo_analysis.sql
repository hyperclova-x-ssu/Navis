-- Up Migration
CREATE TABLE marketing.promo_photo_analysis (
    store_id uuid NOT NULL,
    image_sha256 text NOT NULL CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
    schema_version integer NOT NULL CHECK (schema_version > 0),
    model text NOT NULL CHECK (length(model) BETWEEN 1 AND 80),
    file_id uuid,
    resource_id text CHECK (resource_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    menu_name text NOT NULL,
    state text NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed')),
    claim_id uuid,
    started_at timestamptz,
    metadata jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    fail_code text CHECK (fail_code IN ('AI_UNAVAILABLE', 'AI_BAD_OUTPUT', 'AI_TIMEOUT')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, image_sha256, schema_version, model),
    CHECK ((file_id IS NULL) = (resource_id IS NULL)),
    CHECK (state <> 'queued' OR file_id IS NOT NULL),
    CHECK ((state = 'queued') = (claim_id IS NULL AND started_at IS NULL)),
    CHECK ((state = 'ready') = (metadata IS NOT NULL)),
    CHECK ((state = 'failed') = (fail_code IS NOT NULL))
);
CREATE INDEX promo_photo_analysis_queued
    ON marketing.promo_photo_analysis (store_id, schema_version, model, created_at) WHERE state = 'queued';
ALTER TABLE marketing.promo_photo_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.promo_photo_analysis FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_scope ON marketing.promo_photo_analysis TO marketing_mig, marketing_run, marketing_wrk
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON marketing.promo_photo_analysis TO marketing_run, marketing_wrk;
GRANT UPDATE (state, claim_id, started_at, metadata, fail_code) ON marketing.promo_photo_analysis TO marketing_wrk;

-- Down Migration
DROP TABLE marketing.promo_photo_analysis;
