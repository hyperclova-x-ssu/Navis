-- Up Migration
ALTER TABLE inventory.supplier_dispatch ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE inventory.supplier_dispatch DROP CONSTRAINT supplier_dispatch_store_id_po_id_order_revision_channel_key;
CREATE UNIQUE INDEX supplier_dispatch_active_order_channel
    ON inventory.supplier_dispatch (store_id, po_id, order_revision, channel)
    WHERE state NOT IN ('failed', 'blocked');

-- Down Migration
ALTER TABLE inventory.supplier_dispatch NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM inventory.supplier_dispatch GROUP BY store_id, po_id, order_revision, channel HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Supplier retry receipts exist. Revert the application and retain the audit data.';
    END IF;
END $$;
ALTER TABLE inventory.supplier_dispatch FORCE ROW LEVEL SECURITY;
DROP INDEX inventory.supplier_dispatch_active_order_channel;
ALTER TABLE inventory.supplier_dispatch ADD UNIQUE (store_id, po_id, order_revision, channel);
ALTER TABLE inventory.supplier_dispatch DROP COLUMN created_at;
