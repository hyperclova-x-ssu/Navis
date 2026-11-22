-- Up Migration
-- B19 read model for customer groups, coupon performance and today's actions.
-- Marketing keeps only source IDs and immutable sale facts consumed from the customer and POS outboxes.
-- Names, phone numbers and message bodies never enter these tables; a member carries at most a one-letter initial.

CREATE TABLE marketing.r19_member (
    store_id uuid NOT NULL,
    member_id uuid NOT NULL,
    member_revision integer NOT NULL CHECK (member_revision > 0),
    active boolean NOT NULL,
    contact_allowed boolean NOT NULL,
    marketing_allowed boolean NOT NULL,
    name_initial text CHECK (name_initial IS NULL OR char_length(name_initial) = 1),
    event_id uuid NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, member_id),
    CHECK (contact_allowed OR NOT marketing_allowed)
);

-- One row per recognized POS settlement. Amount is the paid (net-of-discount) value in integer won.
CREATE TABLE marketing.r19_sale (
    store_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    business_date date NOT NULL,
    occurred_at timestamptz NOT NULL,
    member_id uuid,
    amount bigint NOT NULL CHECK (amount >= 0),
    cost bigint CHECK (cost IS NULL OR cost >= 0),
    incomplete_margin boolean NOT NULL,
    event_id uuid NOT NULL,
    PRIMARY KEY (store_id, settlement_id)
);
CREATE INDEX r19_sale_member ON marketing.r19_sale (store_id, member_id, business_date) WHERE member_id IS NOT NULL;
CREATE INDEX r19_sale_day ON marketing.r19_sale (store_id, business_date);

-- Signed corrections of a recognized settlement. A voided member visit removes that settlement from visit counts.
CREATE TABLE marketing.r19_sale_correction (
    store_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    business_date date NOT NULL,
    occurred_at timestamptz NOT NULL,
    kind text NOT NULL CHECK (kind IN ('cancel', 'refund')),
    amount_delta bigint NOT NULL CHECK (amount_delta <= 0),
    cost_delta bigint CHECK (cost_delta IS NULL OR cost_delta <= 0),
    incomplete_margin boolean NOT NULL,
    member_visit_voided boolean NOT NULL,
    event_id uuid NOT NULL,
    PRIMARY KEY (store_id, correction_id)
);
CREATE INDEX r19_sale_correction_settlement ON marketing.r19_sale_correction (store_id, settlement_id);

-- Monotonic per-store revision of this read model, returned as sourceRevision.
CREATE TABLE marketing.r19_projection_state (
    store_id uuid PRIMARY KEY,
    revision bigint NOT NULL CHECK (revision > 0),
    updated_at timestamptz NOT NULL
);

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['r19_member', 'r19_sale', 'r19_sale_correction', 'r19_projection_state'] LOOP
        EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY', name);
        EXECUTE format('ALTER TABLE marketing.%I FORCE ROW LEVEL SECURITY', name);
        EXECUTE format('CREATE POLICY marketing_scope ON marketing.%I TO marketing_mig, marketing_run '
            'USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid)) '
            'WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', name);
    END LOOP;
END
$$;

GRANT SELECT, INSERT ON marketing.r19_member, marketing.r19_sale, marketing.r19_sale_correction,
    marketing.r19_projection_state TO marketing_run;
GRANT UPDATE (member_revision, active, contact_allowed, marketing_allowed, name_initial, event_id, updated_at)
    ON marketing.r19_member TO marketing_run;
GRANT UPDATE (revision, updated_at) ON marketing.r19_projection_state TO marketing_run;

-- Down Migration
DROP TABLE marketing.r19_projection_state, marketing.r19_sale_correction, marketing.r19_sale, marketing.r19_member;
