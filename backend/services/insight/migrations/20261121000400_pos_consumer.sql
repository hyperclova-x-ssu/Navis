-- Up Migration
-- T-307 runner state. The relay checkpoint grant is provisioned by the shared runtime.
CREATE TABLE insight.stream_checkpoint (
  consumer_group text NOT NULL,
  producer text NOT NULL,
  scope_key text NOT NULL,
  last_seq bigint NOT NULL CHECK (last_seq > 0),
  PRIMARY KEY (consumer_group, producer, scope_key)
);

CREATE TABLE insight.stream_inbox (
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

ALTER TABLE insight.stream_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight.stream_checkpoint FORCE ROW LEVEL SECURITY;
ALTER TABLE insight.stream_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight.stream_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY stream_runtime_scope ON insight.stream_checkpoint TO insight_run, insight_mig
  USING (scope_key = (SELECT current_setting('app.stream_scope', true)));
CREATE POLICY stream_runtime_scope ON insight.stream_inbox TO insight_run, insight_mig
  USING (scope_key = (SELECT current_setting('app.stream_scope', true)));
GRANT SELECT, INSERT, UPDATE (last_seq) ON insight.stream_checkpoint TO insight_run;
GRANT SELECT, INSERT, UPDATE (status, attempts, retry_at, reason, envelope, notified_at)
  ON insight.stream_inbox TO insight_run;

-- Down Migration
DROP TABLE insight.stream_inbox, insight.stream_checkpoint;
