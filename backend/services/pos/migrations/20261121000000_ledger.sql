-- Up Migration
CREATE TABLE pos.store (
    store_id uuid PRIMARY KEY,
    display_name text
);

CREATE TABLE pos.business_day (
    store_id uuid NOT NULL REFERENCES pos.store,
    business_date date NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    seq integer NOT NULL DEFAULT 0 CHECK (seq >= 0),
    PRIMARY KEY (store_id, business_date)
);
CREATE INDEX business_day_boundary ON pos.business_day (store_id, starts_at DESC);

-- Sale-time snapshots are copied from the synthetic catalogue into the ledger.
CREATE TABLE pos.catalog_menu (
    store_id uuid NOT NULL REFERENCES pos.store,
    menu_id uuid NOT NULL,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    PRIMARY KEY (store_id, menu_id)
);

CREATE TABLE pos.bill (
    store_id uuid NOT NULL,
    bill_id uuid NOT NULL,
    business_date date NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid')),
    draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
    created_at timestamptz NOT NULL,
    recognized_at timestamptz,
    PRIMARY KEY (store_id, bill_id),
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day,
    CHECK ((status = 'paid') = (recognized_at IS NOT NULL))
);
CREATE INDEX bill_day ON pos.bill (store_id, business_date);

CREATE TABLE pos.pos_order (
    store_id uuid NOT NULL,
    order_id uuid NOT NULL,
    origin_bill_id uuid NOT NULL,
    business_date date NOT NULL,
    order_no integer NOT NULL CHECK (order_no > 0),
    preparation text NOT NULL DEFAULT 'accepted' CHECK (preparation IN ('accepted', 'preparing', 'completed')),
    ordered_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, order_id),
    UNIQUE (store_id, origin_bill_id),
    UNIQUE (store_id, business_date, order_no),
    FOREIGN KEY (store_id, origin_bill_id) REFERENCES pos.bill,
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day
);

CREATE TABLE pos.order_line (
    store_id uuid NOT NULL,
    order_line_id uuid NOT NULL,
    order_id uuid NOT NULL,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    PRIMARY KEY (store_id, order_line_id),
    FOREIGN KEY (store_id, order_id) REFERENCES pos.pos_order
);
CREATE INDEX order_line_order ON pos.order_line (store_id, order_id);

CREATE TABLE pos.bill_allocation (
    store_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    bill_id uuid NOT NULL,
    order_line_id uuid NOT NULL,
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    PRIMARY KEY (store_id, allocation_id),
    FOREIGN KEY (store_id, bill_id) REFERENCES pos.bill,
    FOREIGN KEY (store_id, order_line_id) REFERENCES pos.order_line
);
CREATE INDEX bill_allocation_bill ON pos.bill_allocation (store_id, bill_id);
CREATE INDEX bill_allocation_order_line ON pos.bill_allocation (store_id, order_line_id);

CREATE TABLE pos.settlement (
    store_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    bill_id uuid NOT NULL,
    purpose text NOT NULL CHECK (purpose = 'sale'),
    amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
    at timestamptz NOT NULL,
    PRIMARY KEY (store_id, settlement_id),
    UNIQUE (store_id, bill_id),
    FOREIGN KEY (store_id, bill_id) REFERENCES pos.bill
);

CREATE TABLE pos.settlement_line (
    store_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    PRIMARY KEY (store_id, settlement_id, allocation_id),
    FOREIGN KEY (store_id, settlement_id) REFERENCES pos.settlement,
    FOREIGN KEY (store_id, allocation_id) REFERENCES pos.bill_allocation
);
CREATE INDEX settlement_line_allocation ON pos.settlement_line (store_id, allocation_id);

CREATE TABLE pos.payment (
    store_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    created_by uuid NOT NULL,
    amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
    splits jsonb NOT NULL CHECK (jsonb_typeof(splits) = 'array'),
    transaction_no text NOT NULL,
    approval_no text NOT NULL,
    at timestamptz NOT NULL,
    PRIMARY KEY (store_id, payment_id),
    UNIQUE (store_id, settlement_id),
    UNIQUE (store_id, transaction_no),
    FOREIGN KEY (store_id, settlement_id) REFERENCES pos.settlement
);

CREATE TABLE pos.payment_correction (
    store_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    business_date date NOT NULL,
    created_by uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('cancel', 'refund')),
    amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
    methods jsonb NOT NULL CHECK (jsonb_typeof(methods) = 'array'),
    allocations jsonb NOT NULL CHECK (jsonb_typeof(allocations) = 'array'),
    seq integer NOT NULL CHECK (seq > 0),
    at timestamptz NOT NULL,
    PRIMARY KEY (store_id, correction_id),
    UNIQUE (store_id, business_date, seq),
    FOREIGN KEY (store_id, payment_id) REFERENCES pos.payment,
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day
);
CREATE INDEX payment_correction_payment ON pos.payment_correction (store_id, payment_id, seq);

CREATE TABLE pos.sales_recognition (
    store_id uuid NOT NULL,
    recognition_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    business_date date NOT NULL,
    amount bigint NOT NULL,
    cost bigint,
    correction_id uuid,
    original_recognition_id uuid,
    at timestamptz NOT NULL,
    PRIMARY KEY (store_id, recognition_id),
    UNIQUE NULLS NOT DISTINCT (store_id, settlement_id, allocation_id, correction_id),
    FOREIGN KEY (store_id, settlement_id, allocation_id) REFERENCES pos.settlement_line,
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day,
    FOREIGN KEY (store_id, correction_id) REFERENCES pos.payment_correction,
    FOREIGN KEY (store_id, original_recognition_id) REFERENCES pos.sales_recognition,
    CHECK ((correction_id IS NULL) = (original_recognition_id IS NULL)),
    CHECK ((correction_id IS NULL AND amount >= 0 AND (cost IS NULL OR cost >= 0))
        OR (correction_id IS NOT NULL AND amount <= 0 AND (cost IS NULL OR cost <= 0)))
);
CREATE INDEX recognition_day ON pos.sales_recognition (store_id, business_date);
CREATE INDEX recognition_correction ON pos.sales_recognition (store_id, correction_id) WHERE correction_id IS NOT NULL;
CREATE INDEX recognition_original ON pos.sales_recognition (store_id, original_recognition_id) WHERE original_recognition_id IS NOT NULL;

CREATE TABLE pos.command_ledger (
    store_id uuid NOT NULL REFERENCES pos.store,
    command_type text NOT NULL,
    command_key text NOT NULL,
    fingerprint text,
    status text NOT NULL CHECK (status IN ('pending', 'committed', 'rejected', 'aborted')),
    receipt jsonb,
    terminal_receipt jsonb,
    attempt_id uuid,
    bill_id uuid,
    approval jsonb,
    PRIMARY KEY (store_id, command_type, command_key),
    UNIQUE (store_id, attempt_id),
    FOREIGN KEY (store_id, bill_id) REFERENCES pos.bill,
    CHECK (status = 'aborted' OR (fingerprint IS NOT NULL AND receipt IS NOT NULL)),
    CHECK ((status = 'pending') = (terminal_receipt IS NULL))
);
CREATE INDEX command_bill ON pos.command_ledger (store_id, bill_id) WHERE bill_id IS NOT NULL;
CREATE UNIQUE INDEX command_active_bill_approval ON pos.command_ledger (store_id, bill_id)
WHERE command_type = 'approval.begin' AND status = 'pending';

CREATE TABLE pos.customer_claim (
    store_id uuid NOT NULL REFERENCES pos.store,
    claim_id uuid NOT NULL,
    command_key text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('reservation_first_order', 'membership_use')),
    source_id uuid NOT NULL,
    source_version integer NOT NULL CHECK (source_version > 0),
    PRIMARY KEY (store_id, claim_id),
    UNIQUE (store_id, command_key)
);

CREATE TABLE pos.outbox_scope (
    store_id uuid PRIMARY KEY REFERENCES pos.store,
    last_seq bigint NOT NULL CHECK (last_seq > 0)
);

CREATE TABLE pos.outbox (
    event_id uuid PRIMARY KEY,
    producer text NOT NULL DEFAULT 'pos' CHECK (producer = 'pos'),
    store_id uuid NOT NULL REFERENCES pos.store,
    scope_key text NOT NULL CHECK (scope_key = store_id::text),
    store_seq bigint NOT NULL CHECK (store_seq > 0),
    event_type text NOT NULL CHECK (event_type IN ('pos.sale_recognized.v1', 'pos.sale_corrected.v1')),
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    aggregate_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    published_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz,
    UNIQUE (scope_key, store_seq)
);
CREATE INDEX outbox_pending ON pos.outbox (scope_key, store_seq) WHERE published_at IS NULL;

CREATE TABLE pos.expense_candidate (
    store_id uuid NOT NULL REFERENCES pos.store,
    receipt_id uuid NOT NULL,
    expense_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    business_date date NOT NULL,
    amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
    status text NOT NULL DEFAULT 'candidate' CHECK (status = 'candidate'),
    PRIMARY KEY (store_id, receipt_id),
    UNIQUE (store_id, expense_id)
);

DO $migration$
DECLARE
    scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY[
        'store', 'business_day', 'catalog_menu', 'bill', 'pos_order', 'order_line', 'bill_allocation',
        'settlement', 'settlement_line', 'payment', 'payment_correction', 'sales_recognition',
        'command_ledger', 'customer_claim', 'outbox_scope', 'outbox', 'expense_candidate'
    ]
    LOOP
        EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE pos.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format(
            'CREATE POLICY store_scope ON pos.%I TO pos_mig, pos_run
             USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))',
            scoped_table
        );
    END LOOP;
END
$migration$;

GRANT SELECT ON pos.store, pos.business_day, pos.catalog_menu TO pos_run;
GRANT SELECT, INSERT ON pos.bill, pos.pos_order, pos.order_line, pos.bill_allocation,
    pos.settlement, pos.settlement_line, pos.payment, pos.payment_correction, pos.sales_recognition,
    pos.command_ledger, pos.customer_claim, pos.outbox_scope, pos.outbox, pos.expense_candidate TO pos_run;
GRANT UPDATE (seq) ON pos.business_day TO pos_run;
GRANT UPDATE (status, recognized_at) ON pos.bill TO pos_run;
GRANT UPDATE (preparation) ON pos.pos_order TO pos_run;
GRANT UPDATE (status, terminal_receipt) ON pos.command_ledger TO pos_run;
GRANT UPDATE (last_seq) ON pos.outbox_scope TO pos_run;

-- Down Migration
DROP TABLE pos.expense_candidate, pos.outbox, pos.outbox_scope, pos.customer_claim, pos.command_ledger,
    pos.sales_recognition, pos.payment_correction, pos.payment, pos.settlement_line, pos.settlement,
    pos.bill_allocation, pos.order_line, pos.pos_order, pos.bill, pos.catalog_menu, pos.business_day, pos.store;
