-- Up Migration
ALTER TABLE marketing.local_change ADD COLUMN change_type text CHECK (
  change_type IS NULL OR (kind = 'food-license' AND change_type IN ('opening', 'closure'))
);
ALTER TABLE marketing.local_coverage ADD COLUMN fetched_at timestamptz;

CREATE TABLE marketing.local_public_fetch (
  store_id uuid NOT NULL,
  dataset text NOT NULL CHECK (dataset IN ('events', 'general', 'rest', 'population')),
  attempt_day date NOT NULL,
  fetched_at timestamptz,
  reference_date date,
  PRIMARY KEY (store_id, dataset)
);
ALTER TABLE marketing.local_public_fetch ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.local_public_fetch FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON marketing.local_public_fetch TO marketing_run, marketing_mig
  USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
  WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON marketing.local_public_fetch TO marketing_run;
GRANT UPDATE (attempt_day) ON marketing.local_public_fetch TO marketing_run;

-- The runtime retains its owner-record-only INSERT policy on local_change.
-- This importer can only update the supported region and the specified official feed.
CREATE FUNCTION marketing.apply_seoul_public(
  p_store uuid, p_dataset text, p_at timestamptz, p_reference date, p_rows jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  region_name constant text := '서울 동작구 상도동';
  source_name text;
  change_kind text;
BEGIN
  IF p_store IS DISTINCT FROM nullif(current_setting('app.store_id', true), '')::uuid
     OR p_dataset NOT IN ('events', 'general', 'rest', 'population')
     OR p_at IS NULL OR p_reference IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'Invalid Seoul public import';
  END IF;
  -- Ignore a response that lost its daily claim or is older than the last good import.
  UPDATE marketing.local_public_fetch SET fetched_at = p_at, reference_date = p_reference
  WHERE store_id = p_store AND dataset = p_dataset
    AND attempt_day = (p_at AT TIME ZONE 'Asia/Seoul')::date
    AND (fetched_at IS NULL OR fetched_at <= p_at);
  IF NOT FOUND THEN RETURN; END IF;

  IF p_dataset = 'population' THEN
    INSERT INTO marketing.local_population_band AS existing
      (store_id, region, quarter, weekday, start_hour, end_hour, estimate, reference_date, refreshed_at, source_url)
    SELECT p_store, region_name, r.quarter, r.weekday, r."startHour", r."endHour",
      r.estimate, r."referenceDate", p_at, 'https://data.seoul.go.kr/dataList/OA-23016/S/1/datasetView.do'
    FROM jsonb_to_recordset(p_rows) AS r(quarter text, weekday smallint, "startHour" smallint,
      "endHour" smallint, estimate integer, "referenceDate" date)
    ON CONFLICT (store_id, region, quarter, weekday, start_hour) DO UPDATE SET
      end_hour = EXCLUDED.end_hour, estimate = EXCLUDED.estimate, reference_date = EXCLUDED.reference_date,
      refreshed_at = EXCLUDED.refreshed_at, source_url = EXCLUDED.source_url
      WHERE existing.reference_date <= EXCLUDED.reference_date AND existing.refreshed_at <= EXCLUDED.refreshed_at;
    INSERT INTO marketing.local_coverage (store_id, region, reference_date, kinds)
    VALUES (p_store, region_name, p_reference, ARRAY[]::text[]) ON CONFLICT (store_id) DO NOTHING;
    RETURN;
  END IF;

  change_kind := CASE WHEN p_dataset = 'events' THEN 'festival' ELSE 'food-license' END;
  source_name := CASE p_dataset
    WHEN 'general' THEN 'https://data.seoul.go.kr/dataList/OA-18671/S/1/datasetView.do'
    WHEN 'rest' THEN 'https://data.seoul.go.kr/dataList/OA-18696/S/1/datasetView.do'
  END;
  INSERT INTO marketing.local_change AS existing
    (store_id, id, kind, title, region, authority, source_url, date_kind, reference_date, change_type, imported_at)
  SELECT p_store, r.id, change_kind, r.title, region_name,
    CASE WHEN p_dataset = 'events' THEN r.authority ELSE '서울특별시 동작구' END,
    coalesce(source_name, r."sourceUrl"), CASE WHEN p_dataset = 'events' THEN 'event-date' ELSE 'license-date' END,
    r."referenceDate", r."changeType", p_at
  FROM jsonb_to_recordset(p_rows) AS r(id uuid, title text, authority text, "sourceUrl" text,
    "referenceDate" date, "changeType" text)
  WHERE source_name IS NOT NULL OR r."sourceUrl" LIKE 'https://culture.seoul.go.kr/%'
  ON CONFLICT (store_id, id) DO UPDATE SET title = EXCLUDED.title, authority = EXCLUDED.authority,
    source_url = EXCLUDED.source_url, reference_date = EXCLUDED.reference_date, change_type = EXCLUDED.change_type,
    revision = existing.revision + 1, imported_at = p_at
  WHERE existing.kind = EXCLUDED.kind AND existing.region = EXCLUDED.region
    AND (existing.title, existing.authority, existing.source_url, existing.reference_date, existing.change_type)
      IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.authority, EXCLUDED.source_url, EXCLUDED.reference_date, EXCLUDED.change_type);

  INSERT INTO marketing.local_coverage AS existing (store_id, region, reference_date, kinds, fetched_at)
  VALUES (p_store, region_name, p_reference, ARRAY[change_kind], p_at)
  ON CONFLICT (store_id) DO UPDATE SET
    reference_date = greatest(existing.reference_date, EXCLUDED.reference_date),
    kinds = ARRAY(SELECT DISTINCT unnest(existing.kinds || EXCLUDED.kinds) ORDER BY 1),
    fetched_at = greatest(existing.fetched_at, EXCLUDED.fetched_at)
  WHERE existing.region = EXCLUDED.region;
  INSERT INTO marketing.local_source_revision (store_id, source) VALUES (p_store, 'local-changes')
  ON CONFLICT (store_id, source) DO UPDATE SET revision = marketing.local_source_revision.revision + 1;
END
$function$;
REVOKE ALL ON FUNCTION marketing.apply_seoul_public(uuid, text, timestamptz, date, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketing.apply_seoul_public(uuid, text, timestamptz, date, jsonb) TO marketing_run;

-- Down Migration
DROP FUNCTION marketing.apply_seoul_public(uuid, text, timestamptz, date, jsonb);
DROP TABLE marketing.local_public_fetch;
ALTER TABLE marketing.local_coverage DROP COLUMN fetched_at;
ALTER TABLE marketing.local_change DROP COLUMN change_type;
