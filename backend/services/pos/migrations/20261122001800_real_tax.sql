-- Up Migration
-- B18 tax workflow (D-347): owner-recorded tax payments, evidence files held by Account,
-- review checks for expenses without evidence, receipt undo and frozen accountant exports.
CREATE TABLE pos.tax_payment (
    store_id uuid NOT NULL REFERENCES pos.store,
    tax_payment_id uuid NOT NULL,
    tax_type text NOT NULL CHECK (length(tax_type) BETWEEN 1 AND 60),
    type_key text NOT NULL CHECK (length(type_key) BETWEEN 1 AND 240),
    amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
    due_on date NOT NULL,
    paid_on date,
    status text NOT NULL CHECK (status IN ('unpaid', 'paid')),
    paid_recorded_by uuid,
    paid_recorded_at timestamptz,
    revision integer NOT NULL CHECK (revision > 0),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    deleted_by uuid,
    PRIMARY KEY (store_id, tax_payment_id),
    CHECK ((status = 'paid') = (paid_on IS NOT NULL)),
    CHECK ((status = 'paid') = (paid_recorded_at IS NOT NULL)),
    CHECK ((paid_recorded_at IS NULL) = (paid_recorded_by IS NULL)),
    CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
);
CREATE INDEX tax_payment_due ON pos.tax_payment (store_id, due_on, tax_payment_id) WHERE deleted_at IS NULL;
CREATE INDEX tax_payment_unpaid ON pos.tax_payment (store_id, due_on, amount, tax_payment_id)
    WHERE deleted_at IS NULL AND status = 'unpaid';
CREATE INDEX tax_payment_same ON pos.tax_payment (store_id, type_key, amount, due_on) WHERE deleted_at IS NULL;
CREATE INDEX tax_payment_paid ON pos.tax_payment (store_id, paid_on) WHERE deleted_at IS NULL AND status = 'paid';

-- Only the file ID and an immutable metadata snapshot cross from Account. Bytes stay in Account.
CREATE TABLE pos.tax_evidence (
    store_id uuid NOT NULL,
    tax_payment_id uuid NOT NULL,
    file_id uuid NOT NULL,
    content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')),
    size integer NOT NULL CHECK (size > 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    attached_by uuid NOT NULL,
    attached_at timestamptz NOT NULL,
    detached_at timestamptz,
    detached_by uuid,
    PRIMARY KEY (store_id, tax_payment_id, file_id),
    FOREIGN KEY (store_id, tax_payment_id) REFERENCES pos.tax_payment,
    CHECK ((detached_at IS NULL) = (detached_by IS NULL))
);
CREATE INDEX tax_evidence_file ON pos.tax_evidence (store_id, file_id) WHERE detached_at IS NULL;

-- A check is bound to the expense revision it reviewed. A later expense edit needs a new check.
CREATE TABLE pos.tax_review (
    store_id uuid NOT NULL,
    expense_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('checked', 'unchecked')),
    expense_revision integer NOT NULL CHECK (expense_revision > 0),
    revision integer NOT NULL CHECK (revision > 0),
    checked_by uuid NOT NULL,
    checked_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, expense_id),
    FOREIGN KEY (store_id, expense_id) REFERENCES pos.expense
);

CREATE TABLE pos.tax_undo (
    store_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    resource_kind text NOT NULL CHECK (resource_kind IN ('tax-payment', 'tax-review')),
    resource_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    undo_until timestamptz NOT NULL,
    resource_revision integer NOT NULL CHECK (resource_revision > 0),
    before_image jsonb CHECK (before_image IS NULL OR jsonb_typeof(before_image) = 'object'),
    undone_at timestamptz,
    PRIMARY KEY (store_id, receipt_id)
);
CREATE INDEX tax_undo_resource ON pos.tax_undo (store_id, resource_kind, resource_id);

-- Frozen export. Files are regenerated from the snapshot and must match the stored hashes.
CREATE TABLE pos.tax_export (
    store_id uuid NOT NULL REFERENCES pos.store,
    export_id uuid NOT NULL,
    from_date date NOT NULL,
    to_date date NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL,
    source_revision bigint NOT NULL,
    row_count integer NOT NULL CHECK (row_count >= 0),
    csv_sha256 text NOT NULL CHECK (csv_sha256 ~ '^[0-9a-f]{64}$'),
    xlsx_sha256 text NOT NULL CHECK (xlsx_sha256 ~ '^[0-9a-f]{64}$'),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    PRIMARY KEY (store_id, export_id),
    CHECK (from_date <= to_date AND to_date - from_date <= 365)
);
CREATE INDEX tax_export_history ON pos.tax_export (store_id, created_at DESC, export_id DESC);

DO $migration$
DECLARE
    scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY['tax_payment', 'tax_evidence', 'tax_review', 'tax_undo', 'tax_export'] LOOP
        EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE pos.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('CREATE POLICY store_scope ON pos.%I TO pos_mig, pos_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
    END LOOP;
END
$migration$;

GRANT SELECT, INSERT ON pos.tax_payment, pos.tax_evidence, pos.tax_review, pos.tax_undo, pos.tax_export TO pos_run;
GRANT UPDATE (tax_type, type_key, amount, due_on, paid_on, status, paid_recorded_by, paid_recorded_at,
    revision, updated_at, deleted_at, deleted_by) ON pos.tax_payment TO pos_run;
GRANT UPDATE (content_type, size, sha256, attached_by, attached_at, detached_at, detached_by) ON pos.tax_evidence TO pos_run;
GRANT UPDATE (status, expense_revision, revision, checked_by, checked_at) ON pos.tax_review TO pos_run;
GRANT UPDATE (undone_at) ON pos.tax_undo TO pos_run;

-- Down Migration
DO $migration$
DECLARE
    scoped_table text;
    has_records boolean;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY['tax_payment', 'tax_evidence', 'tax_review', 'tax_undo', 'tax_export'] LOOP
        EXECUTE format('ALTER TABLE pos.%I NO FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('SELECT EXISTS (SELECT FROM pos.%I)', scoped_table) INTO has_records;
        IF has_records THEN
            RAISE EXCEPTION 'Cannot roll back tax migration with records in pos.%', scoped_table;
        END IF;
    END LOOP;
END
$migration$;
DROP TABLE pos.tax_export, pos.tax_undo, pos.tax_review, pos.tax_evidence, pos.tax_payment;
