-- Up Migration
ALTER TABLE inventory.supplier_dispatch
    ADD COLUMN provider_live boolean NOT NULL DEFAULT false,
    ADD COLUMN block_reason text CHECK (block_reason IN ('NOT_SENT_TEST_MODE', 'SMS_SETTINGS_REQUIRED'));
GRANT UPDATE (block_reason) ON inventory.supplier_dispatch TO inventory_run;

-- Down Migration
ALTER TABLE inventory.supplier_dispatch DROP COLUMN provider_live, DROP COLUMN block_reason;
