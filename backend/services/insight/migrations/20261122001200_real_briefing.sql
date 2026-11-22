-- Up Migration
CREATE TABLE insight.briefing_ack (
  store_id uuid NOT NULL,
  business_day date NOT NULL,
  actor_id uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  receipt_id uuid NOT NULL,
  PRIMARY KEY (store_id, business_day),
  UNIQUE (store_id, receipt_id)
);
CREATE TABLE insight.briefing_ack_command (
  store_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  command_key text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 128),
  business_day date NOT NULL,
  PRIMARY KEY (store_id, actor_id, command_key),
  FOREIGN KEY (store_id, business_day) REFERENCES insight.briefing_ack
);
DO $migration$
DECLARE scoped_table text;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY['briefing_ack', 'briefing_ack_command'] LOOP
    EXECUTE format('ALTER TABLE insight.%I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE insight.%I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('CREATE POLICY store_scope ON insight.%I TO insight_mig, insight_run
      USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
      WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
  END LOOP;
END
$migration$;
GRANT SELECT, INSERT ON insight.briefing_ack, insight.briefing_ack_command TO insight_run;

-- Down Migration
DROP TABLE insight.briefing_ack_command, insight.briefing_ack;
