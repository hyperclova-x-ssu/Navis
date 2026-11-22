-- Up Migration
CREATE TABLE insight.ai_usage (
  store_id uuid NOT NULL,
  feature text NOT NULL CHECK (feature IN ('navis', 'promo')),
  attempt_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  stage text,
  model text NOT NULL,
  mode text NOT NULL,
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  outcome text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fingerprint text NOT NULL,
  PRIMARY KEY (store_id, feature, attempt_id),
  CHECK ((feature = 'promo') = (stage IS NOT NULL))
);

CREATE TABLE insight.assistant_proposal (
  store_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  run_id text NOT NULL,
  snapshot_revision bigint NOT NULL CHECK (snapshot_revision >= 0),
  input jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  job_id uuid,
  PRIMARY KEY (store_id, proposal_id),
  CHECK (job_id IS NULL OR confirmed_at IS NOT NULL)
);

CREATE TABLE insight.sales_recognition (
  store_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  business_date date NOT NULL,
  sale_hour smallint NOT NULL CHECK (sale_hour BETWEEN 0 AND 23),
  amount bigint NOT NULL CHECK (amount >= 0),
  fingerprint text NOT NULL,
  PRIMARY KEY (store_id, settlement_id)
);
CREATE INDEX sales_recognition_day ON insight.sales_recognition (store_id, business_date, sale_hour);

CREATE TABLE insight.sales_line (
  store_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  menu_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (store_id, settlement_id, allocation_id),
  FOREIGN KEY (store_id, settlement_id) REFERENCES insight.sales_recognition
);

CREATE TABLE insight.sales_correction (
  store_id uuid NOT NULL,
  correction_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  amount_delta bigint NOT NULL CHECK (amount_delta <= 0),
  fingerprint text NOT NULL,
  PRIMARY KEY (store_id, correction_id),
  UNIQUE (store_id, settlement_id, correction_id),
  FOREIGN KEY (store_id, settlement_id) REFERENCES insight.sales_recognition
);

CREATE TABLE insight.sales_restoration (
  store_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  correction_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (store_id, settlement_id, correction_id, allocation_id),
  FOREIGN KEY (store_id, settlement_id, correction_id) REFERENCES insight.sales_correction (store_id, settlement_id, correction_id),
  FOREIGN KEY (store_id, settlement_id, allocation_id) REFERENCES insight.sales_line
);
CREATE INDEX sales_restoration_allocation ON insight.sales_restoration (store_id, settlement_id, allocation_id);

CREATE TABLE insight.camera (
  store_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  zone_set_revision bigint NOT NULL CHECK (zone_set_revision >= 0),
  PRIMARY KEY (store_id, camera_id)
);

CREATE TABLE insight.cctv_device (
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (store_id, device_id),
  FOREIGN KEY (store_id, camera_id) REFERENCES insight.camera
);
CREATE INDEX cctv_device_camera ON insight.cctv_device (store_id, camera_id);

CREATE TABLE insight.table_zone (
  store_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  zone_set_revision bigint NOT NULL CHECK (zone_set_revision >= 0),
  zone_version_id uuid NOT NULL,
  PRIMARY KEY (store_id, camera_id, zone_set_revision, zone_version_id),
  FOREIGN KEY (store_id, camera_id) REFERENCES insight.camera
);

CREATE TABLE insight.people_count_bucket (
  store_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  bucket_start timestamptz NOT NULL,
  bucket_minutes smallint NOT NULL CHECK (bucket_minutes = 5),
  zone_set_revision bigint NOT NULL CHECK (zone_set_revision >= 0),
  observed_until timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ok', 'partial', 'none')),
  avg_in_store double precision,
  max_in_store integer,
  fingerprint text NOT NULL,
  PRIMARY KEY (store_id, camera_id, bucket_start, bucket_minutes),
  UNIQUE (store_id, camera_id, bucket_start, bucket_minutes, zone_set_revision),
  FOREIGN KEY (store_id, camera_id) REFERENCES insight.camera,
  CHECK (observed_until BETWEEN bucket_start AND bucket_start + interval '5 minutes'),
  CHECK ((status = 'none' AND avg_in_store IS NULL AND max_in_store IS NULL)
      OR (status <> 'none' AND avg_in_store IS NOT NULL AND max_in_store IS NOT NULL
        AND avg_in_store BETWEEN 0 AND max_in_store))
);
CREATE INDEX people_count_recent ON insight.people_count_bucket (store_id, bucket_start DESC, camera_id);

CREATE TABLE insight.table_occupancy_bucket (
  store_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  bucket_start timestamptz NOT NULL,
  bucket_minutes smallint NOT NULL,
  zone_set_revision bigint NOT NULL,
  zone_version_id uuid NOT NULL,
  occupied_seconds integer NOT NULL CHECK (occupied_seconds BETWEEN 0 AND 300),
  finished_sessions integer NOT NULL CHECK (finished_sessions >= 0),
  finished_seconds_sum bigint NOT NULL CHECK (finished_seconds_sum >= 0),
  to_clear_events integer NOT NULL CHECK (to_clear_events >= 0),
  PRIMARY KEY (store_id, camera_id, bucket_start, bucket_minutes, zone_version_id),
  FOREIGN KEY (store_id, camera_id, bucket_start, bucket_minutes, zone_set_revision)
    REFERENCES insight.people_count_bucket (store_id, camera_id, bucket_start, bucket_minutes, zone_set_revision),
  FOREIGN KEY (store_id, camera_id, zone_set_revision, zone_version_id) REFERENCES insight.table_zone
);
CREATE INDEX occupancy_zone ON insight.table_occupancy_bucket (store_id, camera_id, zone_set_revision, zone_version_id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ai_usage', 'assistant_proposal', 'sales_recognition', 'sales_line', 'sales_correction', 'sales_restoration',
    'camera', 'cctv_device', 'table_zone', 'people_count_bucket', 'table_occupancy_bucket'
  ] LOOP
    EXECUTE format('ALTER TABLE insight.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE insight.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY store_scope ON insight.%I TO insight_run, insight_mig
      USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', table_name);
  END LOOP;
END $$;

CREATE POLICY device_token ON insight.cctv_device FOR SELECT TO insight_run
  USING (token_hash = (SELECT current_setting('app.cctv_token_hash', true)));

GRANT SELECT, INSERT ON insight.ai_usage, insight.assistant_proposal,
  insight.sales_recognition, insight.sales_line, insight.sales_correction, insight.sales_restoration,
  insight.people_count_bucket, insight.table_occupancy_bucket TO insight_run;
GRANT UPDATE (confirmed_at, job_id) ON insight.assistant_proposal TO insight_run;
GRANT SELECT ON insight.camera, insight.cctv_device, insight.table_zone TO insight_run;

-- Down Migration
DROP TABLE insight.table_occupancy_bucket, insight.people_count_bucket, insight.table_zone,
  insight.cctv_device, insight.camera, insight.sales_restoration, insight.sales_correction,
  insight.sales_line, insight.sales_recognition, insight.assistant_proposal, insight.ai_usage;
