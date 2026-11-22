-- Up Migration
-- Uses the Insight outbox and sequence initialized by 20261122001000.
CREATE TABLE insight.manuals_grants_record (
  store_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('manual', 'draft', 'checklist', 'notice', 'application')),
  parent_id uuid,
  business_day date,
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  PRIMARY KEY (store_id, id),
  FOREIGN KEY (store_id, parent_id) REFERENCES insight.manuals_grants_record (store_id, id),
  CHECK ((kind IN ('checklist', 'application')) = (parent_id IS NOT NULL)),
  CHECK ((kind = 'checklist') = (business_day IS NOT NULL))
);
CREATE INDEX manuals_grants_list ON insight.manuals_grants_record (store_id, kind, id) WHERE NOT archived;
CREATE UNIQUE INDEX manuals_grants_checklist_day ON insight.manuals_grants_record
  (store_id, parent_id, business_day, (data->>'manualRevision')) WHERE kind = 'checklist' AND NOT archived;
CREATE UNIQUE INDEX manuals_grants_application_notice ON insight.manuals_grants_record
  (store_id, parent_id) WHERE kind = 'application' AND NOT archived;

CREATE TABLE insight.manuals_grants_history (
  store_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  revision integer NOT NULL,
  actor_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  operation text NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (store_id, resource_id, revision),
  FOREIGN KEY (store_id, resource_id) REFERENCES insight.manuals_grants_record (store_id, id)
);
CREATE TABLE insight.manuals_grants_command (
  store_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  command_key text NOT NULL,
  fingerprint text NOT NULL,
  receipt_id uuid NOT NULL,
  receipt jsonb NOT NULL,
  inverse jsonb,
  undone_at timestamptz,
  PRIMARY KEY (store_id, actor_id, command_key),
  UNIQUE (store_id, receipt_id)
);
CREATE TABLE insight.manuals_grants_revision (
  store_id uuid PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0)
);

DO $migration$
DECLARE scoped_table text;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY[
    'manuals_grants_record', 'manuals_grants_history', 'manuals_grants_command', 'manuals_grants_revision'
  ] LOOP
    EXECUTE format('ALTER TABLE insight.%I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE insight.%I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('CREATE POLICY store_scope ON insight.%I TO insight_mig, insight_run
      USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
      WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
  END LOOP;
END
$migration$;
GRANT SELECT, INSERT ON insight.manuals_grants_record, insight.manuals_grants_history,
  insight.manuals_grants_command, insight.manuals_grants_revision TO insight_run;
GRANT UPDATE (data, revision, updated_at, archived) ON insight.manuals_grants_record TO insight_run;
GRANT UPDATE (undone_at) ON insight.manuals_grants_command TO insight_run;
GRANT UPDATE (revision) ON insight.manuals_grants_revision TO insight_run;

-- Down Migration
DROP TABLE insight.manuals_grants_command,
  insight.manuals_grants_history, insight.manuals_grants_record, insight.manuals_grants_revision;
