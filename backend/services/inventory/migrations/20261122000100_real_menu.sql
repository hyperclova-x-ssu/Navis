-- Up Migration
ALTER TABLE inventory.menu_item
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN memo text CHECK (char_length(memo) <= 1000),
    ADD COLUMN prep_min integer NOT NULL DEFAULT 3 CHECK (prep_min BETWEEN 1 AND 1440),
    ADD COLUMN photo_key text CHECK (photo_key ~ '^menu-photo-0[1-8]$'),
    ADD COLUMN photo_file_id uuid,
    ADD COLUMN option_groups jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(option_groups) = 'array'),
    ADD COLUMN recipe_lines jsonb CHECK (jsonb_typeof(recipe_lines) = 'array'),
    ADD CHECK (photo_key IS NULL OR photo_file_id IS NULL);

CREATE INDEX menu_item_active_category ON inventory.menu_item (store_id, category, menu_id)
WHERE kind = 'menu' AND deleted_at IS NULL;

CREATE TABLE inventory.menu_command (
    store_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    menu_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    inverse jsonb CHECK (jsonb_typeof(inverse) = 'object'),
    undone_at timestamptz,
    PRIMARY KEY (store_id, receipt_id),
    UNIQUE (store_id, actor_id, idempotency_key),
    FOREIGN KEY (store_id, menu_id) REFERENCES inventory.menu_item (store_id, menu_id),
    CHECK (undone_at IS NULL OR inverse IS NULL)
);
CREATE INDEX menu_command_menu ON inventory.menu_command (store_id, menu_id);
ALTER TABLE inventory.menu_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.menu_command FORCE ROW LEVEL SECURITY;
CREATE POLICY menu_command_scope ON inventory.menu_command TO inventory_mig, inventory_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

CREATE POLICY provision_store_scope ON inventory.store FOR INSERT TO inventory_run
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY recipe_ingredient_scope ON inventory.inventory_item FOR SELECT TO inventory_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

GRANT INSERT (store_id) ON inventory.store TO inventory_run;
GRANT SELECT (store_id, item_id, base_unit) ON inventory.inventory_item TO inventory_run;
GRANT INSERT (store_id, menu_id, kind, name, category, price, sale_status, memo, recipe_lines),
    UPDATE (name, category, price, sale_status, deleted_at, revision, memo, prep_min, photo_key, photo_file_id, option_groups, recipe_lines)
    ON inventory.menu_item TO inventory_run;
GRANT INSERT ON inventory.recipe_version, inventory.recipe_current TO inventory_run;
GRANT UPDATE (version) ON inventory.recipe_current TO inventory_run;
GRANT SELECT, INSERT, UPDATE (inverse, undone_at) ON inventory.menu_command TO inventory_run;

-- Catalog is one mutable aggregate per menu. Other producers' inventory events
-- keep the existing uniqueness rule for their immutable aggregate IDs.
ALTER TABLE inventory.outbox DROP CONSTRAINT outbox_store_id_event_type_aggregate_id_key;
CREATE UNIQUE INDEX outbox_non_catalog_identity ON inventory.outbox (store_id, event_type, aggregate_id)
WHERE event_type <> 'inventory.catalog_changed.v1';
CREATE UNIQUE INDEX outbox_catalog_revision ON inventory.outbox (store_id, aggregate_id, ((payload->>'revision')::integer))
WHERE event_type = 'inventory.catalog_changed.v1';

-- Down Migration
-- Roll back app images once live menu commands exist. Keep their data and events.
ALTER TABLE inventory.menu_command NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM inventory.menu_command) THEN
        RAISE EXCEPTION 'Inventory menu commands exist; revert the app image and retain the migration';
    END IF;
END
$$;
DROP INDEX inventory.outbox_catalog_revision;
DROP INDEX inventory.outbox_non_catalog_identity;
ALTER TABLE inventory.outbox ADD UNIQUE (store_id, event_type, aggregate_id);
REVOKE INSERT (store_id) ON inventory.store FROM inventory_run;
REVOKE SELECT (store_id, item_id, base_unit) ON inventory.inventory_item FROM inventory_run;
REVOKE INSERT (store_id, menu_id, kind, name, category, price, sale_status, memo, recipe_lines),
    UPDATE (name, category, price, sale_status, deleted_at)
    ON inventory.menu_item FROM inventory_run;
REVOKE INSERT ON inventory.recipe_version, inventory.recipe_current FROM inventory_run;
REVOKE UPDATE (version) ON inventory.recipe_current FROM inventory_run;
DROP POLICY provision_store_scope ON inventory.store;
DROP POLICY recipe_ingredient_scope ON inventory.inventory_item;
DROP TABLE inventory.menu_command;
DROP INDEX inventory.menu_item_active_category;
ALTER TABLE inventory.menu_item DROP COLUMN revision, DROP COLUMN memo, DROP COLUMN prep_min,
    DROP COLUMN photo_key, DROP COLUMN photo_file_id, DROP COLUMN option_groups, DROP COLUMN recipe_lines;
