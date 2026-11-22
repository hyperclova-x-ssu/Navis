-- Up Migration
CREATE TABLE marketing.local_trend_list (
    store_id uuid PRIMARY KEY,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE marketing.local_trend_candidate (
    store_id uuid NOT NULL REFERENCES marketing.local_trend_list (store_id),
    id uuid NOT NULL,
    keyword text NOT NULL CHECK (length(keyword) BETWEEN 1 AND 80),
    keyword_key text NOT NULL CHECK (length(keyword_key) BETWEEN 1 AND 160),
    suggested boolean NOT NULL,
    PRIMARY KEY (store_id, id),
    UNIQUE (store_id, keyword_key)
);

CREATE TABLE marketing.local_trend_cache (
    store_id uuid PRIMARY KEY REFERENCES marketing.local_trend_list (store_id),
    end_date date NOT NULL,
    fingerprint text NOT NULL CHECK (length(fingerprint) = 64),
    ranking jsonb NOT NULL CHECK (jsonb_typeof(ranking) = 'object')
);

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['local_trend_list', 'local_trend_candidate', 'local_trend_cache'] LOOP
        EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY', name);
        EXECUTE format('ALTER TABLE marketing.%I FORCE ROW LEVEL SECURITY', name);
        EXECUTE format('CREATE POLICY owner_store_scope ON marketing.%I TO marketing_run, marketing_mig
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', name);
    END LOOP;
END
$$;

GRANT SELECT, INSERT ON marketing.local_trend_list, marketing.local_trend_candidate, marketing.local_trend_cache TO marketing_run;
GRANT UPDATE (revision) ON marketing.local_trend_list TO marketing_run;
GRANT UPDATE (end_date, fingerprint, ranking) ON marketing.local_trend_cache TO marketing_run;
GRANT DELETE ON marketing.local_trend_candidate TO marketing_run;

-- Down Migration
DROP TABLE marketing.local_trend_cache, marketing.local_trend_candidate, marketing.local_trend_list;
