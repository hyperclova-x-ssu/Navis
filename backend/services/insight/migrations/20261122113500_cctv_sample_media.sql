-- Up Migration
CREATE TABLE insight.cctv_sample_media (
    store_id uuid NOT NULL,
    asset text NOT NULL,
    content_type text NOT NULL,
    object_key text NOT NULL UNIQUE,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 33554432),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, asset),
    CHECK ((asset IN ('store-sample.mp4', 'cafe17.mp4') AND content_type = 'video/mp4')
        OR (asset IN ('store-sample-detections.json', 'cafe17-detections.json') AND content_type = 'application/json'))
);
ALTER TABLE insight.cctv_sample_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight.cctv_sample_media FORCE ROW LEVEL SECURITY;
CREATE POLICY insight_scope ON insight.cctv_sample_media TO insight_mig, insight_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT ON insight.cctv_sample_media TO insight_run;

-- Down Migration
DROP TABLE insight.cctv_sample_media;
