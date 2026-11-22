-- Up Migration
CREATE TABLE marketing.promo_job_media (
    store_id uuid NOT NULL,
    job_id uuid NOT NULL,
    file_id uuid NOT NULL,
    identity text NOT NULL CHECK (identity ~ '^[A-Za-z0-9_-]{1,128}$'),
    purpose text NOT NULL,
    content_type text NOT NULL,
    object_key text NOT NULL UNIQUE,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 16777216),
    ready boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, job_id, file_id),
    UNIQUE (store_id, job_id, purpose, identity),
    FOREIGN KEY (store_id, job_id) REFERENCES marketing.promo_job (store_id, job_id) ON DELETE RESTRICT,
    CHECK ((purpose = 'promo_output' AND content_type = 'video/mp4')
        OR (purpose = 'promo_checkpoint' AND content_type IN ('application/json', 'application/octet-stream')))
);

CREATE TABLE marketing.promo_fixture_media (
    store_id uuid NOT NULL,
    name text NOT NULL CHECK (name ~ '^(reference/ref-[0-9]+/(poster\.jpg|preview\.mp4)|music/[a-z0-9-]+\.m4a)$'),
    content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'video/mp4', 'audio/mp4')),
    object_key text NOT NULL UNIQUE,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 16777216),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, name)
);

ALTER TABLE marketing.promo_job_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.promo_job_media FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_scope ON marketing.promo_job_media TO marketing_mig, marketing_run, marketing_wrk
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT ON marketing.promo_job_media TO marketing_run, marketing_wrk;
GRANT INSERT ON marketing.promo_job_media TO marketing_wrk;
GRANT UPDATE (ready) ON marketing.promo_job_media TO marketing_wrk;

ALTER TABLE marketing.promo_fixture_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.promo_fixture_media FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_scope ON marketing.promo_fixture_media TO marketing_mig, marketing_run, marketing_wrk
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT ON marketing.promo_fixture_media TO marketing_run, marketing_wrk;

-- Down Migration
DROP TABLE marketing.promo_fixture_media, marketing.promo_job_media;
