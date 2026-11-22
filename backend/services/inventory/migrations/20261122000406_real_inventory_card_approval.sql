-- Up Migration
CREATE TABLE inventory.card_approval (
    store_id uuid NOT NULL, approval_id uuid NOT NULL, actor_id uuid NOT NULL,
    operation text NOT NULL, target_ref text, revision integer NOT NULL CHECK (revision >= 0),
    fingerprint text NOT NULL, expires_at timestamptz NOT NULL, confirmed_at timestamptz, consumed_at timestamptz,
    requires_confirmation boolean NOT NULL,
    PRIMARY KEY (store_id, approval_id)
);
CREATE INDEX card_approval_expiry ON inventory.card_approval (store_id, expires_at);
ALTER TABLE inventory.card_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.card_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON inventory.card_approval TO inventory_mig, inventory_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT, DELETE ON inventory.card_approval TO inventory_run;
GRANT UPDATE (confirmed_at, consumed_at) ON inventory.card_approval TO inventory_run;


CREATE TABLE inventory.publication_preview (
    store_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    preview_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('place-menu', 'place-venue', 'commerce-stock', 'supplier-message')),
    resource_ref text NOT NULL,
    revision integer NOT NULL CHECK (revision >= 0),
    input_hash text NOT NULL,
    snapshot text NOT NULL,
    request jsonb NOT NULL,
    local_snapshot text,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, preview_id)
);
CREATE INDEX publication_preview_expiry ON inventory.publication_preview (store_id, expires_at);
ALTER TABLE inventory.publication_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.publication_preview FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON inventory.publication_preview TO inventory_mig, inventory_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT, DELETE ON inventory.publication_preview TO inventory_run;

ALTER TABLE inventory.owner_publication
    ADD COLUMN preview_id uuid,
    ADD COLUMN preview_revision integer,
    ADD COLUMN approval_expires_at timestamptz;

-- Down Migration
ALTER TABLE inventory.owner_publication NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM inventory.owner_publication WHERE preview_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Publication approval receipts exist. Revert the application and retain the audit data.';
    END IF;
END $$;
ALTER TABLE inventory.owner_publication FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory.owner_publication DROP COLUMN preview_id, DROP COLUMN preview_revision, DROP COLUMN approval_expires_at;
DROP TABLE inventory.publication_preview;
DROP TABLE inventory.card_approval;
