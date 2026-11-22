-- Up Migration
CREATE TABLE marketing.promo_asset (
    store_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    file_id uuid NOT NULL,
    menu_id text,
    width integer NOT NULL CHECK (width BETWEEN 1 AND 16384),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 16384),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, asset_id),
    UNIQUE (store_id, file_id)
);

CREATE TABLE marketing.promo_draft (
    store_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
    job_id uuid,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, draft_id),
    FOREIGN KEY (store_id, job_id) REFERENCES marketing.promo_job (store_id, job_id)
);

CREATE TABLE marketing.promo_publication (
    store_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    job_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('clip', 'place-news', 'reels', 'shorts')),
    method text NOT NULL CHECK (method IN ('attestation', 'provider')),
    state text NOT NULL CHECK (state IN ('pending', 'published', 'failed')),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    provider_ref text,
    link text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, publication_id),
    UNIQUE (store_id, job_id, channel, method),
    FOREIGN KEY (store_id, job_id) REFERENCES marketing.promo_job (store_id, job_id),
    CHECK (method <> 'attestation' OR (state = 'published' AND link IS NOT NULL AND provider_ref IS NULL))
);

CREATE TABLE marketing.promo_command (
    store_id uuid NOT NULL,
    command_key text NOT NULL,
    fingerprint text NOT NULL,
    receipt jsonb NOT NULL,
    PRIMARY KEY (store_id, command_key)
);

DO $$
DECLARE relation text;
BEGIN
    FOREACH relation IN ARRAY ARRAY['promo_asset', 'promo_draft', 'promo_publication', 'promo_command']
    LOOP
        EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE marketing.%I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format(
            'CREATE POLICY marketing_scope ON marketing.%I TO marketing_mig, marketing_run
              USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
              WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', relation);
        EXECUTE format('GRANT SELECT, INSERT ON marketing.%I TO marketing_run', relation);
    END LOOP;
END $$;
GRANT UPDATE (revision, input, job_id, updated_at) ON marketing.promo_draft TO marketing_run;
GRANT UPDATE (state, revision, provider_ref, link) ON marketing.promo_publication TO marketing_run;
GRANT UPDATE (receipt) ON marketing.promo_command TO marketing_run;

-- Down Migration
DROP TABLE marketing.promo_command, marketing.promo_publication, marketing.promo_draft, marketing.promo_asset;
