-- Up Migration
CREATE TABLE insight.grant_refresh_profile (
  store_id uuid PRIMARY KEY,
  region text NOT NULL CHECK (length(region) BETWEEN 1 AND 40),
  industry text NOT NULL CHECK (length(industry) BETWEEN 1 AND 80),
  attempt_day date,
  fetched_at timestamptz
);
CREATE INDEX grant_refresh_due ON insight.grant_refresh_profile (attempt_day NULLS FIRST, store_id);
CREATE TABLE insight.grant_provider_notice (
  store_id uuid NOT NULL REFERENCES insight.grant_refresh_profile (store_id),
  provider_id text NOT NULL CHECK (provider_id ~ '^PBLN_[0-9]+$'),
  notice jsonb NOT NULL CHECK (jsonb_typeof(notice) = 'object'),
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (store_id, provider_id)
);
ALTER TABLE insight.grant_refresh_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight.grant_refresh_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE insight.grant_provider_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight.grant_provider_notice FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON insight.grant_refresh_profile TO insight_mig, insight_run
  USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
  WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY store_scope ON insight.grant_provider_notice TO insight_mig, insight_run
  USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
  WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY refresh_schedule ON insight.grant_refresh_profile FOR SELECT TO insight_mig USING (true);
GRANT SELECT, INSERT ON insight.grant_refresh_profile TO insight_run;
GRANT UPDATE (region, industry, attempt_day, fetched_at) ON insight.grant_refresh_profile TO insight_run;
GRANT SELECT, INSERT, DELETE ON insight.grant_provider_notice TO insight_run;

-- The scheduler can discover due store IDs only. All subsequent reads and writes use store RLS.
CREATE FUNCTION insight.due_grant_refreshes(p_day date) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $function$
  SELECT store_id FROM insight.grant_refresh_profile
  WHERE attempt_day IS NULL OR attempt_day < p_day
  ORDER BY attempt_day NULLS FIRST, store_id LIMIT 100
$function$;
REVOKE ALL ON FUNCTION insight.due_grant_refreshes(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insight.due_grant_refreshes(date) TO insight_run;

-- Down Migration
DROP FUNCTION insight.due_grant_refreshes(date);
DROP TABLE insight.grant_provider_notice, insight.grant_refresh_profile;
