-- Up Migration
CREATE TABLE inventory.owner_publication (
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    receipt_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('place-menu', 'place-venue', 'commerce-stock', 'supplier-message')),
    resource_id uuid NOT NULL,
    snapshot text NOT NULL,
    request jsonb NOT NULL,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, receipt_id)
);
ALTER TABLE inventory.owner_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.owner_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY publication_scope ON inventory.owner_publication TO inventory_run, inventory_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT, UPDATE (result) ON inventory.owner_publication TO inventory_run;

-- Down Migration
ALTER TABLE inventory.owner_publication NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM inventory.owner_publication) THEN
        RAISE EXCEPTION 'Owner publication receipts exist; revert the application and retain the data';
    END IF;
END $$;
DROP TABLE inventory.owner_publication;
