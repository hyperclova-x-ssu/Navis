-- Up Migration
ALTER TABLE customer.reservation DROP CONSTRAINT reservation_status_check;
ALTER TABLE customer.reservation
    ADD CONSTRAINT reservation_status_check CHECK (status IN ('needs-check', 'confirmed', 'proposed', 'canceled', 'completed', 'no-show')),
    ADD COLUMN starts_at timestamptz,
    ADD COLUMN party_size integer CHECK (party_size BETWEEN 1 AND 1000),
    ADD COLUMN source text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct', 'phone_ai')),
    ADD COLUMN member_id uuid,
    ADD COLUMN guest_name text,
    ADD COLUMN guest_phone text,
    ADD COLUMN request text,
    ADD COLUMN assignment_mode text NOT NULL DEFAULT 'auto' CHECK (assignment_mode IN ('auto', 'manual')),
    ADD COLUMN preferred_table_id text CHECK (preferred_table_id ~ '^[A-Za-z0-9_-]{1,100}$'),
    ADD COLUMN allocation_warning text CHECK (allocation_warning IN ('NO_MATCHING_TABLE', 'SEAT_LIMIT')),
    ADD COLUMN capacity_override boolean NOT NULL DEFAULT false,
    ADD COLUMN confirmed_by text CHECK (confirmed_by IN ('auto', 'person')),
    ADD COLUMN proposed_time time,
    ADD CONSTRAINT booking_member_fk FOREIGN KEY (store_id, member_id) REFERENCES customer.member,
    ADD CONSTRAINT booking_schedule_fields CHECK ((starts_at IS NULL) = (party_size IS NULL));

CREATE INDEX booking_member ON customer.reservation (store_id, member_id) WHERE member_id IS NOT NULL;
CREATE INDEX booking_period ON customer.reservation (store_id, starts_at, reservation_id) WHERE starts_at IS NOT NULL;
CREATE INDEX booking_active_period ON customer.reservation (store_id, starts_at) WHERE status = 'confirmed' AND first_order_id IS NULL;
ALTER POLICY store_scope ON customer.reservation
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT INSERT ON customer.reservation TO customer_run;
GRANT UPDATE (starts_at, party_size, source, member_id, guest_name, guest_phone, request, table_id, table_archived,
    assignment_mode, preferred_table_id, allocation_warning, capacity_override, confirmed_by, proposed_time) ON customer.reservation TO customer_run;

ALTER TABLE customer.pos_claim
    DROP CONSTRAINT pos_claim_check4,
    DROP CONSTRAINT pos_claim_check5,
    DROP CONSTRAINT pos_claim_check6,
    ADD CONSTRAINT pos_claim_terminal_shape CHECK (
        (state IN ('committed', 'restored') AND bill_id IS NOT NULL AND order_id IS NOT NULL
            AND (settlement_id IS NOT NULL OR (state = 'committed' AND reservation_id IS NOT NULL)))
        OR (state NOT IN ('committed', 'restored') AND settlement_id IS NULL AND bill_id IS NULL AND order_id IS NULL)
    );

CREATE TABLE customer.booking_candidate (
    store_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[0-9a-f]{64}$'),
    received_at timestamptz NOT NULL,
    starts_at timestamptz NOT NULL,
    party_size integer NOT NULL CHECK (party_size BETWEEN 1 AND 1000),
    phone_masked text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'proposed', 'accepted', 'declined')),
    proposed_time time,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    reservation_id uuid,
    PRIMARY KEY (store_id, candidate_id),
    UNIQUE (store_id, dedupe_key),
    UNIQUE (store_id, reservation_id),
    FOREIGN KEY (store_id, reservation_id) REFERENCES customer.reservation,
    CHECK ((status = 'accepted') = (reservation_id IS NOT NULL)),
    CHECK ((status = 'proposed') = (proposed_time IS NOT NULL))
);

CREATE TABLE customer.booking_change (
    store_id uuid NOT NULL,
    change_id uuid NOT NULL,
    reservation_id text NOT NULL,
    changed_at timestamptz NOT NULL,
    kind text NOT NULL CHECK (kind IN ('created', 'updated', 'canceled', 'status')),
    before_summary jsonb,
    after_summary jsonb NOT NULL,
    PRIMARY KEY (store_id, change_id)
);
CREATE INDEX booking_change_history ON customer.booking_change (store_id, reservation_id, changed_at);
CREATE INDEX booking_change_period ON customer.booking_change (store_id, changed_at, change_id);

CREATE TABLE customer.booking_revision (
    store_id uuid PRIMARY KEY,
    revision integer NOT NULL CHECK (revision > 0)
);

CREATE TABLE customer.booking_command (
    store_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    key text NOT NULL CHECK (length(key) BETWEEN 1 AND 160),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    receipt_id uuid NOT NULL,
    receipt jsonb,
    inverse jsonb,
    undone_at timestamptz,
    provider_ref text,
    provider_effect jsonb,
    PRIMARY KEY (store_id, actor_id, key),
    UNIQUE (store_id, receipt_id),
    CHECK ((provider_ref IS NULL) = (provider_effect IS NULL)),
    CONSTRAINT booking_command_outcome CHECK (receipt IS NOT NULL OR provider_ref IS NOT NULL)
);
CREATE UNIQUE INDEX booking_provider_pending ON customer.booking_command (store_id, provider_ref) WHERE receipt IS NULL;

CREATE TABLE customer.booking_pickup (
    store_id uuid NOT NULL,
    custom_order_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    pickup jsonb CHECK (jsonb_typeof(pickup) = 'object'),
    date date,
    PRIMARY KEY (store_id, custom_order_id),
    CHECK ((pickup IS NULL) = (date IS NULL))
);
CREATE INDEX booking_pickup_period ON customer.booking_pickup (store_id, date, custom_order_id) WHERE date IS NOT NULL;

DO $migration$
DECLARE scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY['booking_candidate', 'booking_change', 'booking_revision', 'booking_command', 'booking_pickup'] LOOP
        EXECUTE format('ALTER TABLE customer.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE customer.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('CREATE POLICY store_scope ON customer.%I TO customer_mig, customer_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
    END LOOP;
END
$migration$;

GRANT SELECT, INSERT ON customer.booking_candidate, customer.booking_change, customer.booking_revision,
    customer.booking_command, customer.booking_pickup TO customer_run;
GRANT UPDATE (status, revision, reservation_id, phone_masked, proposed_time) ON customer.booking_candidate TO customer_run;
GRANT UPDATE (revision) ON customer.booking_revision TO customer_run;
GRANT UPDATE (receipt, inverse, undone_at, provider_ref, provider_effect) ON customer.booking_command TO customer_run;
GRANT DELETE ON customer.booking_command TO customer_run;
GRANT UPDATE (revision, pickup, date) ON customer.booking_pickup TO customer_run;

-- Down Migration
ALTER TABLE customer.booking_revision NO FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
    IF EXISTS (SELECT FROM customer.booking_revision) THEN
        RAISE EXCEPTION 'Booking records exist; roll back the application while retaining the schema';
    END IF;
END
$migration$;
DROP TABLE customer.booking_pickup, customer.booking_command, customer.booking_revision, customer.booking_change, customer.booking_candidate;
ALTER TABLE customer.pos_claim DROP CONSTRAINT pos_claim_terminal_shape,
    ADD CONSTRAINT pos_claim_check4 CHECK ((state IN ('committed', 'restored')) = (settlement_id IS NOT NULL)),
    ADD CONSTRAINT pos_claim_check5 CHECK ((settlement_id IS NULL) = (bill_id IS NULL)),
    ADD CONSTRAINT pos_claim_check6 CHECK ((settlement_id IS NULL) = (order_id IS NULL));
REVOKE INSERT ON customer.reservation FROM customer_run;
ALTER TABLE customer.reservation
    DROP CONSTRAINT reservation_status_check, DROP COLUMN starts_at, DROP COLUMN party_size, DROP COLUMN source, DROP COLUMN member_id,
    DROP COLUMN guest_name, DROP COLUMN guest_phone, DROP COLUMN request, DROP COLUMN assignment_mode, DROP COLUMN preferred_table_id,
    DROP COLUMN allocation_warning, DROP COLUMN capacity_override, DROP COLUMN confirmed_by, DROP COLUMN proposed_time;
ALTER TABLE customer.reservation ADD CONSTRAINT reservation_status_check CHECK (status IN ('confirmed', 'canceled'));
