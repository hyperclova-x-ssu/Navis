-- Up Migration
ALTER TABLE inventory.supplier
    ADD COLUMN name_key text,
    ADD COLUMN contact text,
    ADD COLUMN phone text,
    ADD COLUMN memo text,
    ADD COLUMN archived_at timestamptz,
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE UNIQUE INDEX supplier_live_name ON inventory.supplier (store_id, name_key)
    WHERE archived_at IS NULL AND name_key IS NOT NULL;

CREATE TABLE inventory.purchase_item (
    store_id uuid NOT NULL,
    purchase_item_id uuid NOT NULL,
    item_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    purchase_unit text NOT NULL CHECK (purchase_unit IN ('g', 'kg', 'mL', 'L', 'pcs')),
    base_per_unit bigint NOT NULL CHECK (base_per_unit = CASE WHEN purchase_unit IN ('kg', 'L') THEN 1000 ELSE 1 END),
    minimum_qty numeric NOT NULL CHECK (minimum_qty BETWEEN 0.001 AND 9007199254740991 AND scale(minimum_qty) <= 3),
    order_step numeric NOT NULL CHECK (order_step BETWEEN 0.001 AND 9007199254740991 AND scale(order_step) <= 3),
    unit_price bigint NOT NULL CHECK (unit_price BETWEEN 0 AND 9007199254740991),
    lead_days integer NOT NULL CHECK (lead_days BETWEEN 0 AND 3650),
    archived_at timestamptz,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (store_id, purchase_item_id),
    FOREIGN KEY (store_id, item_id) REFERENCES inventory.inventory_item (store_id, item_id),
    FOREIGN KEY (store_id, supplier_id) REFERENCES inventory.supplier (store_id, supplier_id)
);
CREATE UNIQUE INDEX purchase_item_live_ingredient ON inventory.purchase_item (store_id, item_id) WHERE archived_at IS NULL;
CREATE INDEX purchase_item_supplier ON inventory.purchase_item (store_id, supplier_id);

ALTER TABLE inventory.purchase_order
    ADD COLUMN due_date date,
    ADD COLUMN expected_time time,
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE INDEX purchase_order_dates ON inventory.purchase_order (store_id, due_date, po_id);
CREATE INDEX purchase_order_history ON inventory.purchase_order (store_id, ordered_on, po_id);
ALTER TABLE inventory.purchase_order_line
    ALTER COLUMN qty_ordered TYPE numeric,
    ADD CONSTRAINT purchase_order_line_quantity_precision CHECK (scale(qty_ordered) <= 3),
    ADD COLUMN item_name_snapshot text;
ALTER TABLE inventory.goods_receipt
    ALTER COLUMN qty TYPE numeric,
    ALTER COLUMN qty_remaining TYPE numeric,
    ADD CONSTRAINT goods_receipt_quantity_precision CHECK (scale(qty) <= 3 AND scale(qty_remaining) <= 3),
    ADD COLUMN voided_at timestamptz,
    ADD COLUMN undo_until timestamptz;

CREATE TABLE inventory.purchase_command (
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    receipt_id uuid NOT NULL,
    result jsonb NOT NULL,
    undo_until timestamptz,
    inverse jsonb,
    undone_at timestamptz,
    PRIMARY KEY (store_id, idempotency_key),
    UNIQUE (store_id, receipt_id)
);
CREATE INDEX purchase_command_expiry ON inventory.purchase_command (store_id, undo_until) WHERE inverse IS NOT NULL;

ALTER TABLE inventory.purchase_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_item FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.purchase_command FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_scope ON inventory.purchase_item TO inventory_run, inventory_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY purchase_scope ON inventory.purchase_command TO inventory_run, inventory_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON inventory.supplier, inventory.purchase_item, inventory.purchase_command TO inventory_run;
GRANT UPDATE (name, name_key, contact, phone, memo, archived_at, revision) ON inventory.supplier TO inventory_run;
GRANT UPDATE (supplier_id, minimum_qty, order_step, unit_price, lead_days, archived_at, revision)
    ON inventory.purchase_item TO inventory_run;
GRANT INSERT ON inventory.purchase_order, inventory.purchase_order_line TO inventory_run;
GRANT UPDATE (due_date, canceled_at, revision) ON inventory.purchase_order TO inventory_run;
GRANT UPDATE (voided_at) ON inventory.goods_receipt TO inventory_run;
GRANT UPDATE (inverse, undone_at) ON inventory.purchase_command TO inventory_run;

DROP INDEX inventory.outbox_non_catalog_identity;
CREATE UNIQUE INDEX outbox_non_catalog_identity ON inventory.outbox (store_id, event_type, aggregate_id)
    WHERE event_type NOT IN ('inventory.catalog_changed.v1', 'inventory.purchase_order_changed.v1');
CREATE UNIQUE INDEX outbox_purchase_order_revision ON inventory.outbox (store_id, aggregate_id, ((payload->>'revision')::integer))
    WHERE event_type = 'inventory.purchase_order_changed.v1';

-- Down Migration
ALTER TABLE inventory.purchase_command NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM inventory.purchase_command) THEN
        RAISE EXCEPTION 'Purchasing records exist; revert the app image and retain the migration';
    END IF;
END
$$;
DROP INDEX inventory.outbox_purchase_order_revision;
DROP INDEX inventory.outbox_non_catalog_identity;
CREATE UNIQUE INDEX outbox_non_catalog_identity ON inventory.outbox (store_id, event_type, aggregate_id)
    WHERE event_type <> 'inventory.catalog_changed.v1';
REVOKE UPDATE (voided_at) ON inventory.goods_receipt FROM inventory_run;
REVOKE UPDATE (due_date, canceled_at, revision) ON inventory.purchase_order FROM inventory_run;
REVOKE INSERT ON inventory.purchase_order, inventory.purchase_order_line FROM inventory_run;
REVOKE UPDATE (name, name_key, contact, phone, memo, archived_at, revision) ON inventory.supplier FROM inventory_run;
REVOKE SELECT, INSERT ON inventory.supplier FROM inventory_run;
DROP TABLE inventory.purchase_command, inventory.purchase_item;
ALTER TABLE inventory.goods_receipt DROP CONSTRAINT goods_receipt_quantity_precision,
    DROP COLUMN voided_at, DROP COLUMN undo_until,
    ALTER COLUMN qty TYPE bigint, ALTER COLUMN qty_remaining TYPE bigint;
ALTER TABLE inventory.purchase_order_line DROP CONSTRAINT purchase_order_line_quantity_precision,
    DROP COLUMN item_name_snapshot, ALTER COLUMN qty_ordered TYPE bigint;
DROP INDEX inventory.purchase_order_dates, inventory.purchase_order_history, inventory.supplier_live_name;
ALTER TABLE inventory.purchase_order DROP COLUMN due_date, DROP COLUMN expected_time, DROP COLUMN revision;
ALTER TABLE inventory.supplier DROP COLUMN name_key, DROP COLUMN contact, DROP COLUMN phone,
    DROP COLUMN memo, DROP COLUMN archived_at, DROP COLUMN revision;
