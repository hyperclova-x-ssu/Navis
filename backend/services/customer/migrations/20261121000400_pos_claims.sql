-- Up Migration
CREATE TABLE customer.reservation (
    store_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'canceled')),
    table_id uuid,
    table_archived boolean NOT NULL DEFAULT false CHECK (NOT table_archived OR table_id IS NOT NULL),
    first_order_id uuid,
    first_bill_id uuid,
    PRIMARY KEY (store_id, reservation_id),
    UNIQUE (store_id, first_order_id),
    UNIQUE (store_id, first_bill_id),
    CHECK ((first_order_id IS NULL) = (first_bill_id IS NULL)),
    CHECK (status = 'confirmed' OR first_order_id IS NULL)
);

CREATE TABLE customer.membership (
    store_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    starts_on date NOT NULL,
    ends_on date NOT NULL CHECK (ends_on >= starts_on),
    uses_total integer NOT NULL CHECK (uses_total > 0),
    uses_left integer NOT NULL CHECK (uses_left BETWEEN 0 AND uses_total),
    PRIMARY KEY (store_id, membership_id)
);

CREATE TABLE customer.pos_claim (
    store_id uuid NOT NULL,
    claim_id uuid NOT NULL,
    request_key text NOT NULL,
    command_key text NOT NULL,
    actor_id uuid NOT NULL,
    source_version integer NOT NULL CHECK (source_version > 0),
    reservation_id uuid,
    membership_id uuid,
    state text NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'committed', 'released', 'restored')),
    pos_bound boolean NOT NULL DEFAULT false,
    settlement_id uuid,
    bill_id uuid,
    order_id uuid,
    release_reason text CHECK (release_reason IN ('aborted', 'rejected')),
    PRIMARY KEY (store_id, claim_id),
    UNIQUE (store_id, request_key),
    UNIQUE (store_id, command_key),
    UNIQUE (store_id, settlement_id),
    FOREIGN KEY (store_id, reservation_id) REFERENCES customer.reservation,
    FOREIGN KEY (store_id, membership_id) REFERENCES customer.membership,
    CHECK ((reservation_id IS NULL) <> (membership_id IS NULL)),
    CHECK (state <> 'restored' OR membership_id IS NOT NULL),
    CHECK ((state = 'released') = (release_reason IS NOT NULL)),
    CHECK (state = 'held' OR pos_bound),
    CHECK ((state IN ('committed', 'restored')) = (settlement_id IS NOT NULL)),
    CHECK ((settlement_id IS NULL) = (bill_id IS NULL)),
    CHECK ((settlement_id IS NULL) = (order_id IS NULL))
);
CREATE UNIQUE INDEX pos_claim_one_first_order ON customer.pos_claim (store_id, reservation_id)
    WHERE reservation_id IS NOT NULL AND state IN ('held', 'committed');
CREATE INDEX pos_claim_reservation ON customer.pos_claim (store_id, reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX pos_claim_membership ON customer.pos_claim (store_id, membership_id) WHERE membership_id IS NOT NULL;

CREATE TABLE customer.reservation_cancel_command (
    store_id uuid NOT NULL,
    request_key text NOT NULL,
    reservation_id uuid NOT NULL,
    source_version integer NOT NULL CHECK (source_version > 0),
    actor_id uuid NOT NULL,
    PRIMARY KEY (store_id, request_key),
    FOREIGN KEY (store_id, reservation_id) REFERENCES customer.reservation
);
CREATE INDEX reservation_cancel_command_reservation ON customer.reservation_cancel_command (store_id, reservation_id);

CREATE TABLE customer.membership_contribution (
    store_id uuid NOT NULL,
    use_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    returned integer NOT NULL DEFAULT 0 CHECK (returned BETWEEN 0 AND quantity),
    PRIMARY KEY (store_id, use_id, allocation_id),
    FOREIGN KEY (store_id, use_id) REFERENCES customer.pos_claim (store_id, claim_id)
);

CREATE TABLE customer.membership_correction (
    store_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    event_id uuid NOT NULL,
    use_id uuid NOT NULL,
    effect jsonb NOT NULL CHECK (jsonb_typeof(effect) = 'object'),
    PRIMARY KEY (store_id, correction_id),
    FOREIGN KEY (store_id, use_id) REFERENCES customer.pos_claim (store_id, claim_id)
);
CREATE INDEX membership_correction_use ON customer.membership_correction (store_id, use_id);

DO $migration$
DECLARE
    scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY[
        'reservation', 'membership', 'pos_claim', 'reservation_cancel_command',
        'membership_contribution', 'membership_correction'
    ]
    LOOP
        EXECUTE format('ALTER TABLE customer.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE customer.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format(
            'CREATE POLICY store_scope ON customer.%I TO customer_migrate, customer_runtime
             USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))',
            scoped_table
        );
    END LOOP;
END
$migration$;

GRANT SELECT ON customer.reservation, customer.membership TO customer_runtime;
GRANT SELECT, INSERT ON customer.pos_claim, customer.reservation_cancel_command,
    customer.membership_contribution, customer.membership_correction TO customer_runtime;
GRANT UPDATE (status, version, first_order_id, first_bill_id) ON customer.reservation TO customer_runtime;
GRANT UPDATE (uses_left) ON customer.membership TO customer_runtime;
GRANT UPDATE (state, pos_bound, settlement_id, bill_id, order_id, release_reason) ON customer.pos_claim TO customer_runtime;
GRANT UPDATE (returned) ON customer.membership_contribution TO customer_runtime;

-- Down Migration
DROP TABLE customer.membership_correction, customer.membership_contribution,
    customer.reservation_cancel_command, customer.pos_claim, customer.membership, customer.reservation;
