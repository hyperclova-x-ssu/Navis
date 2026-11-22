-- Up Migration
CREATE TABLE insight.configured_zone (
  store_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  zone_set_revision bigint NOT NULL,
  zone_version_id uuid NOT NULL,
  zone_id uuid NOT NULL,
  label text NOT NULL,
  polygon jsonb NOT NULL,
  PRIMARY KEY (store_id, camera_id, zone_set_revision, zone_version_id),
  UNIQUE (store_id, camera_id, zone_set_revision, zone_id),
  FOREIGN KEY (store_id, camera_id, zone_set_revision, zone_version_id) REFERENCES insight.table_zone
);
CREATE TABLE insight.pos_table_source (
  store_id uuid NOT NULL,
  table_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  archived boolean NOT NULL,
  PRIMARY KEY (store_id, table_id)
);
CREATE TABLE insight.zone_table_link (
  store_id uuid NOT NULL,
  zone_id uuid NOT NULL,
  camera_id uuid NOT NULL,
  table_id uuid,
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (store_id, zone_id),
  UNIQUE (store_id, table_id),
  FOREIGN KEY (store_id, camera_id) REFERENCES insight.camera,
  FOREIGN KEY (store_id, table_id) REFERENCES insight.pos_table_source
);
CREATE TABLE insight.environment_reading (
  store_id uuid NOT NULL,
  reading_id uuid NOT NULL,
  measured_at timestamptz NOT NULL,
  temperature_c double precision NOT NULL CHECK (temperature_c BETWEEN -50 AND 80),
  humidity_pct double precision NOT NULL CHECK (humidity_pct BETWEEN 0 AND 100),
  PRIMARY KEY (store_id, reading_id)
);
CREATE INDEX environment_reading_period ON insight.environment_reading (store_id, measured_at DESC, reading_id DESC);
CREATE TABLE insight.environment_limits (
  store_id uuid PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  temperature_min double precision NOT NULL,
  temperature_max double precision NOT NULL,
  humidity_min double precision NOT NULL,
  humidity_max double precision NOT NULL,
  CHECK (-50 <= temperature_min AND temperature_min <= temperature_max AND temperature_max <= 80),
  CHECK (0 <= humidity_min AND humidity_min <= humidity_max AND humidity_max <= 100)
);
CREATE TABLE insight.cctv_review (
  store_id uuid NOT NULL,
  business_date date NOT NULL,
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  review_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  marked_at timestamptz,
  PRIMARY KEY (store_id, business_date, hour),
  UNIQUE (store_id, review_id)
);
CREATE TABLE insight.observation_command (
  store_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  command_key text NOT NULL,
  fingerprint text NOT NULL,
  receipt_id uuid NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (store_id, actor_id, command_key),
  UNIQUE (store_id, receipt_id)
);
CREATE TABLE insight.outbox_scope (
  scope_key text PRIMARY KEY,
  last_seq bigint NOT NULL CHECK (last_seq > 0)
);
CREATE TABLE insight.outbox (
  event_id uuid PRIMARY KEY,
  producer text NOT NULL DEFAULT 'insight' CHECK (producer = 'insight'),
  store_id uuid NOT NULL,
  scope_key text NOT NULL CHECK (scope_key = store_id::text),
  store_seq bigint NOT NULL CHECK (store_seq > 0),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  aggregate_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  UNIQUE (scope_key, store_seq)
);
CREATE INDEX insight_outbox_pending ON insight.outbox (scope_key, store_seq) WHERE published_at IS NULL;

DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['configured_zone','pos_table_source','zone_table_link',
    'environment_reading','environment_limits','cctv_review','observation_command','outbox'] LOOP
    EXECUTE format('ALTER TABLE insight.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE insight.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY store_scope ON insight.%I TO insight_run, insight_mig
      USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
      WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', table_name);
  END LOOP;
END
$migration$;
ALTER TABLE insight.outbox_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight.outbox_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON insight.outbox_scope TO insight_run, insight_mig
  USING (scope_key = (SELECT current_setting('app.store_id', true)))
  WITH CHECK (scope_key = (SELECT current_setting('app.store_id', true)));

GRANT SELECT, INSERT ON insight.configured_zone, insight.pos_table_source, insight.zone_table_link,
  insight.environment_reading, insight.environment_limits, insight.cctv_review, insight.observation_command, insight.outbox, insight.outbox_scope TO insight_run;
GRANT UPDATE (revision, archived) ON insight.pos_table_source TO insight_run;
GRANT UPDATE (table_id, revision) ON insight.zone_table_link TO insight_run;
GRANT UPDATE (revision, temperature_min, temperature_max, humidity_min, humidity_max) ON insight.environment_limits TO insight_run;
GRANT UPDATE (review_id, revision, marked_at) ON insight.cctv_review TO insight_run;
GRANT UPDATE (last_seq) ON insight.outbox_scope TO insight_run;
GRANT UPDATE (zone_set_revision) ON insight.camera TO insight_run;
GRANT INSERT ON insight.table_zone TO insight_run;

-- Down Migration
REVOKE INSERT ON insight.table_zone FROM insight_run;
REVOKE UPDATE (zone_set_revision) ON insight.camera FROM insight_run;
DROP TABLE insight.outbox, insight.outbox_scope, insight.observation_command, insight.environment_limits,
  insight.environment_reading, insight.cctv_review, insight.zone_table_link, insight.pos_table_source, insight.configured_zone;
