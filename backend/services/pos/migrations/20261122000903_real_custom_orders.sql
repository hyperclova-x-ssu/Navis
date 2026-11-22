-- Up Migration
CREATE TABLE pos.custom_template (
    store_id uuid NOT NULL REFERENCES pos.store,
    template_id uuid NOT NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array'),
    revision integer NOT NULL CHECK (revision > 0),
    archived_at timestamptz,
    PRIMARY KEY (store_id, template_id)
);

CREATE TABLE pos.custom_order (
    store_id uuid NOT NULL,
    custom_order_id uuid NOT NULL,
    order_no integer NOT NULL CHECK (order_no > 0),
    template_id uuid NOT NULL,
    template_snapshot jsonb NOT NULL CHECK (jsonb_typeof(template_snapshot) = 'object'),
    receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
    request_fingerprint text NOT NULL CHECK (length(request_fingerprint) = 64),
    desired_pickup_at timestamp NOT NULL,
    proposed_pickup_at timestamp,
    production_at timestamp,
    stage text NOT NULL CHECK (stage IN ('received', 'quote_pending', 'approval_pending', 'revision_requested', 'payment_pending',
        'in_production', 'production_complete', 'received_by_customer', 'canceled')),
    customer_decision text NOT NULL CHECK (customer_decision IN ('pending', 'approved', 'rejected', 'revision_requested')),
    payment_timing text NOT NULL CHECK (payment_timing IN ('advance', 'on_pickup')),
    quote_amount bigint CHECK (quote_amount BETWEEN 1 AND 9007199254740991),
    quote_revision integer NOT NULL CHECK (quote_revision >= 0),
    approved_quote_revision integer,
    settlement_id uuid,
    revision integer NOT NULL CHECK (revision > 0),
    CHECK (approved_quote_revision IS NULL OR (approved_quote_revision = quote_revision AND customer_decision = 'approved' AND quote_amount IS NOT NULL)),
    PRIMARY KEY (store_id, custom_order_id),
    UNIQUE (store_id, order_no),
    UNIQUE (store_id, settlement_id),
    FOREIGN KEY (store_id, template_id) REFERENCES pos.custom_template,
    FOREIGN KEY (store_id, settlement_id) REFERENCES pos.settlement
);
CREATE INDEX custom_order_template ON pos.custom_order (store_id, template_id);
CREATE INDEX custom_order_schedule ON pos.custom_order (store_id, stage, desired_pickup_at);
CREATE UNIQUE INDEX custom_order_open_request ON pos.custom_order (store_id, request_fingerprint)
    WHERE stage NOT IN ('received_by_customer', 'canceled');

CREATE TABLE pos.custom_order_history (
    store_id uuid NOT NULL,
    custom_order_id uuid NOT NULL,
    order_revision integer NOT NULL CHECK (order_revision > 0),
    record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
    PRIMARY KEY (store_id, custom_order_id, order_revision),
    FOREIGN KEY (store_id, custom_order_id) REFERENCES pos.custom_order
);

CREATE TABLE pos.custom_pickup (
    store_id uuid NOT NULL,
    custom_order_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    scheduled_at timestamp NOT NULL CHECK (extract(minute FROM scheduled_at) IN (0, 30) AND extract(second FROM scheduled_at) = 0),
    status text NOT NULL CHECK (status IN ('confirmed', 'completed', 'canceled')),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, custom_order_id),
    UNIQUE (store_id, reservation_id),
    FOREIGN KEY (store_id, custom_order_id) REFERENCES pos.custom_order
);
CREATE INDEX custom_pickup_schedule ON pos.custom_pickup (store_id, status, scheduled_at);

CREATE TABLE pos.custom_receipt_undo (
    store_id uuid NOT NULL REFERENCES pos.store,
    receipt_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    command_type text NOT NULL,
    command_key text NOT NULL,
    undo_until timestamptz NOT NULL,
    effect jsonb NOT NULL CHECK (jsonb_typeof(effect) = 'object'),
    PRIMARY KEY (store_id, receipt_id),
    FOREIGN KEY (store_id, command_type, command_key) REFERENCES pos.command_ledger
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX custom_receipt_undo_command ON pos.custom_receipt_undo (store_id, command_type, command_key);

CREATE TABLE pos.custom_pickup_adjustment (
    store_id uuid NOT NULL,
    adjustment_id uuid NOT NULL,
    correction_id uuid,
    custom_order_id uuid NOT NULL,
    business_date date NOT NULL,
    at timestamptz NOT NULL,
    kind text NOT NULL CHECK (kind IN ('refund', 'undo', 'receive')),
    amount bigint NOT NULL CHECK (abs(amount) BETWEEN 1 AND 9007199254740991),
    CHECK ((kind = 'receive') = (amount > 0)),
    CHECK ((kind = 'refund') = (correction_id IS NOT NULL)),
    PRIMARY KEY (store_id, adjustment_id),
    UNIQUE (store_id, correction_id),
    FOREIGN KEY (store_id, correction_id) REFERENCES pos.payment_correction,
    FOREIGN KEY (store_id, custom_order_id) REFERENCES pos.custom_order,
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day
);
CREATE INDEX custom_pickup_adjustment_order ON pos.custom_pickup_adjustment (store_id, custom_order_id);
CREATE INDEX custom_pickup_adjustment_day ON pos.custom_pickup_adjustment (store_id, business_date);

DO $policies$
DECLARE tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'custom_template', 'custom_order', 'custom_order_history', 'custom_pickup', 'custom_receipt_undo', 'custom_pickup_adjustment'
    ] LOOP
        EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('ALTER TABLE pos.%I FORCE ROW LEVEL SECURITY', tbl);
        EXECUTE format(
            'CREATE POLICY store_scope ON pos.%I TO pos_mig, pos_run USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid)) WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))',
            tbl
        );
        EXECUTE format('GRANT SELECT, INSERT ON pos.%I TO pos_run', tbl);
    END LOOP;
END
$policies$;
GRANT UPDATE ON pos.custom_template, pos.custom_order, pos.custom_pickup TO pos_run;

-- Down Migration
ALTER TABLE pos.custom_order NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pos.custom_template NO FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
    IF EXISTS (SELECT 1 FROM pos.custom_order) OR EXISTS (SELECT 1 FROM pos.custom_template) THEN
        RAISE EXCEPTION 'Custom order records exist; roll back the application instead';
    END IF;
END
$migration$;
DROP TABLE pos.custom_pickup_adjustment, pos.custom_receipt_undo, pos.custom_pickup, pos.custom_order_history, pos.custom_order, pos.custom_template;
