-- Up Migration
CREATE TABLE pos.table_transfer_receipt (
    store_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    command_type text NOT NULL CHECK (command_type IN ('bill.move_table', 'bill.merge_tables', 'bill.separate_table')),
    command_key text NOT NULL,
    undo_until timestamptz NOT NULL,
    effect jsonb NOT NULL CHECK (jsonb_typeof(effect) = 'object'),
    PRIMARY KEY (store_id, receipt_id),
    FOREIGN KEY (store_id, command_type, command_key) REFERENCES pos.command_ledger
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX table_transfer_command ON pos.table_transfer_receipt (store_id, command_type, command_key);
ALTER TABLE pos.table_transfer_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.table_transfer_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON pos.table_transfer_receipt TO pos_mig, pos_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON pos.table_transfer_receipt TO pos_run;

-- Down Migration
ALTER TABLE pos.table_transfer_receipt NO FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
    IF EXISTS (SELECT 1 FROM pos.table_transfer_receipt) THEN
        RAISE EXCEPTION 'POS transfer receipts exist; roll back the application instead';
    END IF;
END
$migration$;
DROP TABLE pos.table_transfer_receipt;
