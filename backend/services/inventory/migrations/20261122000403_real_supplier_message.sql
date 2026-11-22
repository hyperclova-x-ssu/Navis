-- Up Migration
CREATE TABLE inventory.supplier_dispatch (
    store_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    po_id uuid NOT NULL,
    order_revision integer NOT NULL,
    channel text NOT NULL CHECK (channel IN ('sms', 'mail')),
    snapshot text NOT NULL,
    scheduled_at timestamptz,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','ready','dispatching','unknown','accepted','delivered','failed','blocked')),
    provider_id text,
    started_at timestamptz,
    PRIMARY KEY (store_id, receipt_id),
    UNIQUE (store_id, po_id, order_revision, channel),
    FOREIGN KEY (store_id, receipt_id) REFERENCES inventory.owner_publication (store_id, receipt_id),
    FOREIGN KEY (store_id, po_id) REFERENCES inventory.purchase_order (store_id, po_id)
);
CREATE INDEX supplier_dispatch_pending ON inventory.supplier_dispatch (store_id, state, scheduled_at);
ALTER TABLE inventory.supplier_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.supplier_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_dispatch_scope ON inventory.supplier_dispatch TO inventory_run, inventory_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE (state, provider_id, started_at) ON inventory.supplier_dispatch TO inventory_run;

-- Down Migration
ALTER TABLE inventory.supplier_dispatch NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM inventory.supplier_dispatch) THEN
        RAISE EXCEPTION 'Supplier dispatches exist; revert the application and retain the data';
    END IF;
END $$;
DROP TABLE inventory.supplier_dispatch;
