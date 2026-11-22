-- Up Migration
ALTER TABLE pos.expense_candidate DROP CONSTRAINT expense_candidate_amount_check;
ALTER TABLE pos.expense_candidate ADD CONSTRAINT expense_candidate_amount_check CHECK (amount BETWEEN 0 AND 9007199254740991);
ALTER TABLE pos.expense_candidate DROP CONSTRAINT expense_candidate_status_check;
ALTER TABLE pos.expense_candidate
    ADD CONSTRAINT expense_candidate_status_check CHECK (status IN ('candidate', 'confirmed', 'canceled')),
    ADD COLUMN undo_until timestamptz,
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE INDEX expense_candidate_day ON pos.expense_candidate (store_id, business_date, expense_id);
GRANT UPDATE (status, revision) ON pos.expense_candidate TO pos_run;
DO $receipt_worker$
BEGIN
    IF to_regrole('pos_wrk') IS NOT NULL THEN
        CREATE POLICY receipt_worker_scope ON pos.expense_candidate TO pos_wrk
            USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
        GRANT SELECT ON pos.expense_candidate TO pos_wrk;
        GRANT INSERT (store_id, receipt_id, expense_id, supplier_id, business_date, amount, undo_until),
            UPDATE (status, revision) ON pos.expense_candidate TO pos_wrk;
    END IF;
END
$receipt_worker$;

CREATE TABLE pos.expense (
    store_id uuid NOT NULL REFERENCES pos.store,
    expense_id uuid NOT NULL,
    receipt_id uuid,
    supplier_id uuid,
    business_date date NOT NULL,
    category text NOT NULL CHECK (category IN ('ingredients','operations','supplies','labor','rent','other')),
    amount bigint NOT NULL CHECK (amount BETWEEN 0 AND 9007199254740991 AND (amount > 0 OR receipt_id IS NOT NULL)),
    evidence text NOT NULL CHECK (evidence IN ('receipt','tax-invoice','card','none')),
    memo text CHECK (length(memo) <= 250),
    status text NOT NULL CHECK (status IN ('confirmed','canceled')),
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, expense_id),
    UNIQUE (store_id, receipt_id),
    FOREIGN KEY (store_id, receipt_id) REFERENCES pos.expense_candidate
);
CREATE INDEX expense_day ON pos.expense (store_id, business_date, expense_id);

CREATE TABLE pos.expense_undo (
    store_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    expense_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    undo_until timestamptz NOT NULL,
    expense_revision integer NOT NULL,
    before_image jsonb CHECK (before_image IS NULL OR jsonb_typeof(before_image) = 'object'),
    undone_at timestamptz,
    PRIMARY KEY (store_id, receipt_id),
    FOREIGN KEY (store_id, expense_id) REFERENCES pos.expense
);
CREATE INDEX expense_undo_source ON pos.expense_undo (store_id, expense_id);

CREATE TABLE pos.drawer (
    store_id uuid NOT NULL,
    business_date date NOT NULL,
    opening bigint NOT NULL DEFAULT 0 CHECK (opening BETWEEN 0 AND 9007199254740991),
    actual bigint CHECK (actual BETWEEN 0 AND 9007199254740991),
    memo text NOT NULL DEFAULT '' CHECK (length(memo) <= 100),
    PRIMARY KEY (store_id, business_date),
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day
);

CREATE TABLE pos.cash_movement (
    store_id uuid NOT NULL,
    movement_id uuid NOT NULL,
    business_date date NOT NULL,
    actor_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('in','out')),
    amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
    memo text NOT NULL CHECK (length(memo) <= 100),
    at timestamptz NOT NULL,
    canceled_at timestamptz,
    canceled_by uuid,
    PRIMARY KEY (store_id, movement_id),
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day,
    CHECK ((canceled_at IS NULL) = (canceled_by IS NULL))
);
CREATE INDEX cash_movement_day ON pos.cash_movement (store_id, business_date, at, movement_id);

CREATE TABLE pos.closing_snapshot (
    store_id uuid NOT NULL,
    closing_id uuid NOT NULL,
    business_date date NOT NULL,
    closed_by uuid NOT NULL,
    closed_at timestamptz NOT NULL,
    reopened_by uuid,
    reopened_at timestamptz,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    PRIMARY KEY (store_id, closing_id),
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day,
    CHECK ((reopened_at IS NULL) = (reopened_by IS NULL))
);
CREATE UNIQUE INDEX closing_active_day ON pos.closing_snapshot (store_id, business_date) WHERE reopened_at IS NULL;
CREATE INDEX closing_history_day ON pos.closing_snapshot (store_id, business_date DESC, closed_at DESC, closing_id);

DO $migration$
DECLARE
    scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY['expense','expense_undo','drawer','cash_movement','closing_snapshot'] LOOP
        EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE pos.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('CREATE POLICY store_scope ON pos.%I TO pos_mig, pos_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
    END LOOP;
END
$migration$;

GRANT SELECT, INSERT ON pos.expense, pos.expense_undo, pos.drawer, pos.cash_movement, pos.closing_snapshot TO pos_run;
GRANT UPDATE (business_date, category, amount, memo, status, revision) ON pos.expense TO pos_run;
GRANT UPDATE (undone_at) ON pos.expense_undo TO pos_run;
GRANT UPDATE (opening, actual, memo) ON pos.drawer TO pos_run;
GRANT UPDATE (canceled_at, canceled_by) ON pos.cash_movement TO pos_run;
GRANT UPDATE (reopened_at, reopened_by) ON pos.closing_snapshot TO pos_run;
GRANT UPDATE (status) ON pos.business_day TO pos_run;

-- Down Migration
-- Down is for a disposable pre-cutover database. Retain records for binary rollback.
REVOKE UPDATE (status) ON pos.business_day FROM pos_run;
DROP TABLE pos.closing_snapshot, pos.cash_movement, pos.drawer, pos.expense_undo, pos.expense;
REVOKE UPDATE (status, revision) ON pos.expense_candidate FROM pos_run;
DO $receipt_worker$
BEGIN
    IF to_regrole('pos_wrk') IS NOT NULL THEN
        REVOKE SELECT, INSERT (store_id, receipt_id, expense_id, supplier_id, business_date, amount, undo_until),
            UPDATE (status, revision) ON pos.expense_candidate FROM pos_wrk;
    END IF;
END
$receipt_worker$;
DROP POLICY IF EXISTS receipt_worker_scope ON pos.expense_candidate;
DROP INDEX pos.expense_candidate_day;
ALTER TABLE pos.expense_candidate DROP COLUMN undo_until, DROP COLUMN revision;
ALTER TABLE pos.expense_candidate DROP CONSTRAINT expense_candidate_status_check;
ALTER TABLE pos.expense_candidate ADD CONSTRAINT expense_candidate_status_check CHECK (status = 'candidate');
ALTER TABLE pos.expense_candidate DROP CONSTRAINT expense_candidate_amount_check;
ALTER TABLE pos.expense_candidate ADD CONSTRAINT expense_candidate_amount_check CHECK (amount BETWEEN 1 AND 9007199254740991);
