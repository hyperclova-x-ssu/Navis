-- Up Migration
CREATE TABLE marketing.local_change (
    store_id uuid NOT NULL,
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('food-license', 'festival', 'owner-record')),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    region text NOT NULL,
    authority text NOT NULL,
    source_url text,
    date_kind text NOT NULL CHECK (date_kind IN ('license-date', 'event-date', 'recorded-date')),
    reference_date date NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    acknowledged_at timestamptz,
    imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, id),
    CHECK ((kind = 'food-license' AND date_kind = 'license-date' AND source_url IS NOT NULL)
        OR (kind = 'festival' AND date_kind = 'event-date' AND source_url IS NOT NULL)
        OR (kind = 'owner-record' AND date_kind = 'recorded-date'))
);
CREATE INDEX local_change_date ON marketing.local_change (store_id, reference_date DESC, id DESC);

CREATE TABLE marketing.local_population_band (
    store_id uuid NOT NULL,
    region text NOT NULL,
    quarter text NOT NULL CHECK (quarter ~ '^[0-9]{4}-Q[1-4]$'),
    weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    start_hour smallint NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
    end_hour smallint NOT NULL CHECK (end_hour BETWEEN 1 AND 24 AND end_hour > start_hour),
    estimate integer NOT NULL CHECK (estimate >= 0),
    reference_date date NOT NULL,
    refreshed_at timestamptz NOT NULL,
    source_url text NOT NULL,
    PRIMARY KEY (store_id, region, quarter, weekday, start_hour)
);

CREATE TABLE marketing.local_coverage (
    store_id uuid PRIMARY KEY,
    region text NOT NULL,
    reference_date date NOT NULL,
    kinds text[] NOT NULL CHECK (kinds <@ ARRAY['food-license', 'festival']::text[])
);

CREATE TABLE marketing.local_source_revision (
    store_id uuid NOT NULL,
    source text NOT NULL CHECK (source IN ('local-changes', 'community')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (store_id, source)
);

CREATE TABLE marketing.community_offer (
    sender_store_id uuid NOT NULL,
    recipient_store_id uuid NOT NULL CHECK (recipient_store_id <> sender_store_id),
    id uuid PRIMARY KEY,
    title text NOT NULL,
    terms text NOT NULL,
    shared_contact text CHECK (length(shared_contact) BETWEEN 1 AND 160),
    starts_on date NOT NULL,
    ends_on date NOT NULL CHECK (ends_on >= starts_on),
    respond_by date NOT NULL CHECK (respond_by <= ends_on),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    interested boolean NOT NULL DEFAULT false,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX community_offer_sender ON marketing.community_offer (sender_store_id, respond_by, id);
CREATE INDEX community_offer_recipient ON marketing.community_offer (recipient_store_id, respond_by, id);

CREATE TABLE marketing.local_command (
    store_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    key text NOT NULL,
    fingerprint text NOT NULL,
    receipt jsonb NOT NULL,
    receipt_id uuid GENERATED ALWAYS AS ((receipt->>'receiptId')::uuid) STORED,
    PRIMARY KEY (store_id, actor_id, key),
    UNIQUE (store_id, actor_id, receipt_id)
);

CREATE TABLE marketing.local_sale_delta (
    store_id uuid NOT NULL,
    event_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    menu_id text NOT NULL,
    quantity integer NOT NULL CHECK (quantity <> 0),
    business_date date NOT NULL,
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, event_id, allocation_id)
);
CREATE INDEX local_sale_range ON marketing.local_sale_delta (store_id, business_date) WHERE quantity > 0;
CREATE INDEX local_sale_allocation ON marketing.local_sale_delta (store_id, settlement_id, allocation_id);

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['local_command', 'local_change', 'local_population_band', 'local_coverage',
                                'community_offer', 'local_sale_delta', 'local_source_revision'] LOOP
        EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY', name);
        EXECUTE format('ALTER TABLE marketing.%I FORCE ROW LEVEL SECURITY', name);
        IF name <> 'community_offer' THEN
            EXECUTE format('CREATE POLICY local_scope ON marketing.%I TO marketing_mig, marketing_run
              USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', name);
        END IF;
    END LOOP;
END
$$;

CREATE POLICY offer_read ON marketing.community_offer FOR SELECT TO marketing_run, marketing_mig
    USING ((SELECT nullif(current_setting('app.store_id', true), '')::uuid) IN (sender_store_id, recipient_store_id));
CREATE POLICY offer_create ON marketing.community_offer FOR INSERT TO marketing_run, marketing_mig
    WITH CHECK (sender_store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY offer_respond ON marketing.community_offer FOR UPDATE TO marketing_run
    USING (recipient_store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (recipient_store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

CREATE POLICY owner_record_only ON marketing.local_change AS RESTRICTIVE FOR INSERT TO marketing_run
    WITH CHECK (kind = 'owner-record' AND authority = '사장님 기록');

GRANT SELECT, INSERT ON marketing.local_command, marketing.local_change, marketing.community_offer TO marketing_run;
GRANT SELECT ON marketing.local_coverage, marketing.local_population_band TO marketing_run;
GRANT SELECT, INSERT ON marketing.local_sale_delta TO marketing_run;
GRANT SELECT, INSERT ON marketing.local_source_revision TO marketing_run;
GRANT UPDATE (revision) ON marketing.local_source_revision TO marketing_run;
GRANT UPDATE (acknowledged_at, revision) ON marketing.local_change TO marketing_run;
GRANT UPDATE (status, interested, revision, updated_at) ON marketing.community_offer TO marketing_run;

-- Down Migration
DROP TABLE marketing.local_command, marketing.community_offer, marketing.local_population_band,
    marketing.local_coverage, marketing.local_change, marketing.local_sale_delta, marketing.local_source_revision;
