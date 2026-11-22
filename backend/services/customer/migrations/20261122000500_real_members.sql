-- Up Migration
CREATE TABLE customer.member (
    store_id uuid NOT NULL,
    member_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    phone text NOT NULL CHECK (phone ~ '^[0-9]{10,11}$'),
    grade_override text CHECK (grade_override IN ('regular', 'frequent', 'occasional', 'inactive')),
    contact_allowed boolean NOT NULL DEFAULT true,
    marketing_allowed boolean NOT NULL DEFAULT false CHECK (NOT marketing_allowed OR contact_allowed),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL,
    archived_at timestamptz,
    PRIMARY KEY (store_id, member_id)
);
CREATE UNIQUE INDEX member_active_phone ON customer.member (store_id, phone) WHERE archived_at IS NULL;

CREATE TABLE customer.member_note (
    store_id uuid NOT NULL,
    note_id uuid NOT NULL,
    member_id uuid NOT NULL,
    body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL,
    archived_at timestamptz,
    PRIMARY KEY (store_id, note_id),
    FOREIGN KEY (store_id, member_id) REFERENCES customer.member
);
CREATE INDEX member_note_member ON customer.member_note (store_id, member_id, note_id);

CREATE TABLE customer.member_visit (
    store_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    member_id uuid NOT NULL,
    visited_at timestamptz NOT NULL,
    reversed_at timestamptz,
    PRIMARY KEY (store_id, settlement_id),
    FOREIGN KEY (store_id, member_id) REFERENCES customer.member
);
CREATE INDEX member_visit_member ON customer.member_visit (store_id, member_id, visited_at);

CREATE TABLE customer.membership_product (
    store_id uuid NOT NULL,
    product_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
    kind text NOT NULL CHECK (kind IN ('count', 'period')),
    sold_price bigint NOT NULL CHECK (sold_price BETWEEN 1 AND 9007199254740991),
    total_uses integer CHECK (total_uses BETWEEN 1 AND 10000),
    valid_days integer NOT NULL CHECK (valid_days BETWEEN 1 AND 3660),
    daily_limit integer CHECK (daily_limit BETWEEN 1 AND 100),
    menu_ids uuid[] NOT NULL CHECK (cardinality(menu_ids) BETWEEN 1 AND 100),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (store_id, product_id),
    CHECK ((kind = 'count') = (total_uses IS NOT NULL))
);
ALTER TABLE customer.membership
    ADD COLUMN member_id uuid,
    ADD COLUMN product_id uuid,
    ADD COLUMN sale_settlement_id uuid,
    ADD COLUMN sold_terms jsonb CHECK (jsonb_typeof(sold_terms) = 'object'),
    ADD CONSTRAINT membership_member_fk FOREIGN KEY (store_id, member_id) REFERENCES customer.member,
    ADD CONSTRAINT membership_product_fk FOREIGN KEY (store_id, product_id) REFERENCES customer.membership_product,
    ADD CONSTRAINT membership_sold_terms_present CHECK (
        num_nonnulls(member_id, product_id, sale_settlement_id, sold_terms) IN (0, 4)),
    ADD UNIQUE (store_id, sale_settlement_id);
CREATE INDEX membership_member ON customer.membership (store_id, member_id, ends_on);
CREATE INDEX membership_product_ref ON customer.membership (store_id, product_id);
ALTER TABLE customer.pos_claim ADD COLUMN used_at timestamptz, ADD COLUMN restored_at timestamptz;

CREATE TABLE customer.member_command (
    store_id uuid NOT NULL,
    request_key text NOT NULL,
    actor_id uuid NOT NULL,
    fingerprint text NOT NULL,
    receipt_id uuid NOT NULL,
    receipt jsonb NOT NULL,
    inverse jsonb,
    undone_at timestamptz,
    PRIMARY KEY (store_id, request_key),
    UNIQUE (store_id, receipt_id)
);

CREATE TABLE customer.outbox_scope (
    scope_key text PRIMARY KEY,
    last_seq bigint NOT NULL CHECK (last_seq > 0)
);
CREATE TABLE customer.outbox (
    event_id uuid PRIMARY KEY,
    producer text NOT NULL DEFAULT 'customer' CHECK (producer = 'customer'),
    store_id uuid NOT NULL,
    scope_key text NOT NULL CHECK (scope_key = store_id::text),
    store_seq bigint NOT NULL CHECK (store_seq > 0),
    event_type text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    aggregate_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    published_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz,
    UNIQUE (scope_key, store_seq)
);
CREATE INDEX customer_outbox_pending ON customer.outbox (scope_key, store_seq) WHERE published_at IS NULL;

DO $migration$
DECLARE scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY['member','member_note','member_visit','membership_product','member_command','outbox'] LOOP
        EXECUTE format('ALTER TABLE customer.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE customer.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('CREATE POLICY store_scope ON customer.%I TO customer_mig, customer_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
    END LOOP;
END
$migration$;
ALTER TABLE customer.outbox_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer.outbox_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON customer.outbox_scope TO customer_mig, customer_run
    USING (scope_key = (SELECT current_setting('app.store_id', true)))
    WITH CHECK (scope_key = (SELECT current_setting('app.store_id', true)));
GRANT SELECT, INSERT ON customer.member, customer.member_note, customer.member_visit, customer.member_command,
    customer.membership_product, customer.membership, customer.outbox, customer.outbox_scope TO customer_run;
GRANT UPDATE (name, phone, grade_override, contact_allowed, marketing_allowed, revision, archived_at)
    ON customer.member TO customer_run;
GRANT UPDATE (body, revision, updated_at, archived_at) ON customer.member_note TO customer_run;
GRANT UPDATE (reversed_at) ON customer.member_visit TO customer_run;
GRANT UPDATE (undone_at) ON customer.member_command TO customer_run;
GRANT UPDATE (status, version) ON customer.membership TO customer_run;
GRANT UPDATE (used_at, restored_at) ON customer.pos_claim TO customer_run;
GRANT UPDATE (last_seq) ON customer.outbox_scope TO customer_run;

-- Down Migration
REVOKE INSERT ON customer.membership FROM customer_run;
REVOKE UPDATE (status, version) ON customer.membership FROM customer_run;
ALTER TABLE customer.pos_claim DROP COLUMN used_at, DROP COLUMN restored_at;
DROP INDEX customer.membership_member, customer.membership_product_ref;
ALTER TABLE customer.membership DROP COLUMN member_id, DROP COLUMN product_id, DROP COLUMN sale_settlement_id, DROP COLUMN sold_terms;
DROP TABLE customer.member_command, customer.member_visit, customer.member_note, customer.membership_product,
    customer.member, customer.outbox, customer.outbox_scope;
