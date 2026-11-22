-- Up Migration
ALTER TABLE pos.bill DROP CONSTRAINT bill_status_check;
ALTER TABLE pos.bill ADD CONSTRAINT bill_status_check CHECK (status IN ('open', 'paid', 'void'));
ALTER TABLE pos.pos_order ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE pos.payment ADD COLUMN channel text NOT NULL DEFAULT 'fixture'
    CHECK (channel IN ('fixture', 'cash_record', 'terminal_record'));
ALTER TABLE pos.payment_correction ADD CONSTRAINT correction_payment_identity UNIQUE (store_id, payment_id, correction_id);

CREATE TABLE pos.store_table (
    store_id uuid NOT NULL REFERENCES pos.store,
    table_id uuid NOT NULL,
    label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
    seats integer NOT NULL CHECK (seats BETWEEN 1 AND 30),
    state text NOT NULL DEFAULT 'empty' CHECK (state IN ('empty', 'occupied', 'cleaning', 'archived')),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (store_id, table_id)
);
CREATE UNIQUE INDEX store_table_active_label ON pos.store_table (store_id, lower(label)) WHERE state <> 'archived';

CREATE TABLE pos.table_session (
    store_id uuid NOT NULL,
    bill_id uuid NOT NULL,
    table_id uuid NOT NULL,
    opened_at timestamptz NOT NULL,
    ended_at timestamptz CHECK (ended_at >= opened_at),
    PRIMARY KEY (store_id, bill_id),
    FOREIGN KEY (store_id, bill_id) REFERENCES pos.bill,
    FOREIGN KEY (store_id, table_id) REFERENCES pos.store_table
);
CREATE UNIQUE INDEX table_session_active ON pos.table_session (store_id, table_id) WHERE ended_at IS NULL;
CREATE INDEX table_session_history ON pos.table_session (store_id, table_id, opened_at DESC);

CREATE TABLE pos.terminal_record (
    store_id uuid NOT NULL,
    record_id uuid NOT NULL,
    payment_id uuid NOT NULL,
    correction_id uuid,
    business_date date NOT NULL,
    direction text GENERATED ALWAYS AS (CASE WHEN correction_id IS NULL THEN 'sale' ELSE 'return' END) STORED,
    approval_no text CHECK (approval_no ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
    receipt_no text CHECK (receipt_no ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL CHECK (recorded_at >= occurred_at),
    PRIMARY KEY (store_id, record_id),
    FOREIGN KEY (store_id, payment_id) REFERENCES pos.payment,
    FOREIGN KEY (store_id, payment_id, correction_id) REFERENCES pos.payment_correction (store_id, payment_id, correction_id),
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day,
    CHECK (record_id = coalesce(correction_id, payment_id)),
    CHECK (approval_no IS NOT NULL OR receipt_no IS NOT NULL)
);
CREATE UNIQUE INDEX terminal_approval_per_day ON pos.terminal_record (store_id, business_date, direction, approval_no)
    WHERE approval_no IS NOT NULL;
CREATE UNIQUE INDEX terminal_receipt_per_day ON pos.terminal_record (store_id, business_date, direction, receipt_no)
    WHERE receipt_no IS NOT NULL;
CREATE INDEX terminal_record_payment ON pos.terminal_record (store_id, payment_id, correction_id);

CREATE INDEX bill_listing ON pos.bill (store_id, created_at DESC, bill_id DESC);
CREATE INDEX order_listing ON pos.pos_order (store_id, ordered_at DESC, order_id DESC);

ALTER TABLE pos.outbox DROP CONSTRAINT outbox_event_type_check;
ALTER TABLE pos.outbox ADD CONSTRAINT outbox_event_type_check CHECK (event_type IN (
    'pos.sale_recognized.v1', 'pos.sale_corrected.v1', 'pos.table_changed.v1', 'pos.table_session_changed.v1'
));

DO $migration$
DECLARE
    scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY['store_table', 'table_session', 'terminal_record'] LOOP
        EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE pos.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format(
            'CREATE POLICY store_scope ON pos.%I TO pos_mig, pos_run
             USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
             WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))',
            scoped_table
        );
    END LOOP;
END
$migration$;

GRANT SELECT, INSERT ON pos.store_table, pos.table_session, pos.terminal_record TO pos_run;
GRANT UPDATE (label, seats, state, revision) ON pos.store_table TO pos_run;
GRANT UPDATE (ended_at) ON pos.table_session TO pos_run;
GRANT UPDATE (revision) ON pos.pos_order TO pos_run;
GRANT UPDATE (draft) ON pos.bill TO pos_run;
GRANT INSERT (store_id) ON pos.store TO pos_run;
GRANT INSERT (store_id, business_date, starts_at, ends_at) ON pos.business_day TO pos_run;

-- Down Migration
-- Use an earlier app image for operational rollback. These validated old constraints
-- deliberately prevent a schema downgrade after incompatible records exist.
ALTER TABLE pos.outbox DROP CONSTRAINT outbox_event_type_check;
ALTER TABLE pos.outbox ADD CONSTRAINT outbox_event_type_check CHECK (event_type IN ('pos.sale_recognized.v1', 'pos.sale_corrected.v1'));
ALTER TABLE pos.bill DROP CONSTRAINT bill_status_check;
ALTER TABLE pos.bill ADD CONSTRAINT bill_status_check CHECK (status IN ('open', 'paid'));
DO $migration$
BEGIN
    -- FORCE RLS hides rows from migration owners. Hold a schema lock while checking.
    ALTER TABLE pos.payment NO FORCE ROW LEVEL SECURITY;
    IF EXISTS (SELECT 1 FROM pos.payment WHERE channel <> 'fixture') THEN
        RAISE EXCEPTION 'POS payment records exist; roll back the application instead';
    END IF;
    ALTER TABLE pos.payment FORCE ROW LEVEL SECURITY;
END
$migration$;
REVOKE UPDATE (draft) ON pos.bill FROM pos_run;
REVOKE INSERT (store_id) ON pos.store FROM pos_run;
REVOKE INSERT (store_id, business_date, starts_at, ends_at) ON pos.business_day FROM pos_run;
DROP INDEX pos.bill_listing, pos.order_listing;
DROP TABLE pos.terminal_record, pos.table_session, pos.store_table;
ALTER TABLE pos.payment_correction DROP CONSTRAINT correction_payment_identity;
ALTER TABLE pos.pos_order DROP COLUMN revision;
ALTER TABLE pos.payment DROP COLUMN channel;
