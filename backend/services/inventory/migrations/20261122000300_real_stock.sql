-- Up Migration
ALTER TABLE inventory.store ADD COLUMN stock_timezone text, ADD COLUMN stock_day_start time;
CREATE POLICY stock_clock_read ON inventory.store FOR SELECT TO inventory_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY stock_clock_write ON inventory.store FOR UPDATE TO inventory_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT (stock_timezone, stock_day_start), UPDATE (stock_timezone, stock_day_start) ON inventory.store TO inventory_run;

ALTER TABLE inventory.inventory_item
    ADD COLUMN sku text CHECK (char_length(sku) BETWEEN 1 AND 80 AND btrim(sku) = sku),
    ADD COLUMN name text CHECK (char_length(name) BETWEEN 1 AND 120 AND btrim(name) = name),
    ADD COLUMN display_unit text CHECK (display_unit IN ('g', 'kg', 'mL', 'L', 'pcs')),
    ADD COLUMN threshold_base bigint CHECK (threshold_base BETWEEN 0 AND 9007199254740991),
    ADD COLUMN track_restock boolean NOT NULL DEFAULT true,
    ADD COLUMN track_expiry boolean NOT NULL DEFAULT false,
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN updated_at timestamptz,
    ADD COLUMN archived_at timestamptz,
    ADD CONSTRAINT inventory_item_display_dimension CHECK (
        display_unit IS NULL OR (base_unit IS NOT NULL AND base_unit = CASE display_unit
            WHEN 'kg' THEN 'g' WHEN 'L' THEN 'mL' ELSE display_unit END)
    );
CREATE UNIQUE INDEX inventory_item_sku ON inventory.inventory_item (store_id, lower(sku)) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX inventory_item_active_name ON inventory.inventory_item (store_id, lower(name))
WHERE name IS NOT NULL AND archived_at IS NULL;

ALTER TABLE inventory.stock_movement ADD COLUMN source_id uuid, ADD COLUMN reason text;
ALTER TABLE inventory.sale_usage ADD COLUMN recorded_at timestamptz;
ALTER TABLE inventory.sale_usage_correction ADD COLUMN recorded_at timestamptz;
ALTER TABLE inventory.demand_forecast ADD COLUMN catalog_seq bigint CHECK (
    catalog_seq IS NULL OR (catalog_seq >= 0 AND menu_id IS NULL AND item_id IS NULL)
);
CREATE INDEX outbox_catalog_sequence ON inventory.outbox (store_id, store_seq DESC)
WHERE event_type = 'inventory.catalog_changed.v1';

CREATE TABLE inventory.stock_batch (
    store_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    item_id uuid NOT NULL,
    quantity_base bigint NOT NULL CHECK (quantity_base BETWEEN 1 AND 9007199254740991),
    remaining_base bigint NOT NULL CHECK (remaining_base BETWEEN 0 AND quantity_base),
    expires_on date NOT NULL,
    received_at timestamptz NOT NULL,
    discarded_at timestamptz,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (store_id, batch_id),
    FOREIGN KEY (store_id, item_id) REFERENCES inventory.inventory_item (store_id, item_id),
    CHECK (discarded_at IS NULL OR (discarded_at >= received_at AND remaining_base = 0))
);
CREATE INDEX stock_batch_item ON inventory.stock_batch (store_id, item_id, expires_on, batch_id);

CREATE TABLE inventory.stock_batch_usage (
    store_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    used_base bigint NOT NULL CHECK (used_base > 0),
    restored_base bigint NOT NULL DEFAULT 0 CHECK (restored_base BETWEEN 0 AND used_base),
    PRIMARY KEY (store_id, settlement_id, allocation_id, batch_id),
    FOREIGN KEY (store_id, settlement_id, allocation_id)
        REFERENCES inventory.sale_usage_line (store_id, settlement_id, allocation_id),
    FOREIGN KEY (store_id, batch_id) REFERENCES inventory.stock_batch (store_id, batch_id)
);
CREATE INDEX stock_batch_usage_batch ON inventory.stock_batch_usage (store_id, batch_id);

CREATE TABLE inventory.stock_command (
    store_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    item_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    inverse jsonb CHECK (jsonb_typeof(inverse) = 'object'),
    undone_at timestamptz,
    PRIMARY KEY (store_id, receipt_id),
    UNIQUE (store_id, actor_id, idempotency_key),
    FOREIGN KEY (store_id, item_id) REFERENCES inventory.inventory_item (store_id, item_id),
    CHECK (undone_at IS NULL OR inverse IS NULL)
);
CREATE INDEX stock_command_item ON inventory.stock_command (store_id, item_id);

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY['stock_batch', 'stock_batch_usage', 'stock_command'] LOOP
        EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY', name);
        EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY', name);
        EXECUTE format(
            'CREATE POLICY inventory_scope ON inventory.%I TO inventory_mig, inventory_run
              USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
              WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))',
            name
        );
    END LOOP;
END
$$;

CREATE POLICY stock_item_insert ON inventory.inventory_item FOR INSERT TO inventory_run
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY stock_item_update ON inventory.inventory_item FOR UPDATE TO inventory_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT (sku, name, display_unit, threshold_base, track_restock, track_expiry,
    revision, updated_at, archived_at),
    INSERT (store_id, item_id, recipe_key, base_unit, sku, name, display_unit, threshold_base, track_restock, updated_at),
    UPDATE (name, threshold_base, track_restock, track_expiry, revision, updated_at, archived_at)
    ON inventory.inventory_item TO inventory_run;
GRANT INSERT ON inventory.business_day, inventory.stock_daily_opening TO inventory_run;
GRANT SELECT, INSERT ON inventory.stock_batch, inventory.stock_batch_usage, inventory.stock_command TO inventory_run;
GRANT UPDATE (remaining_base, discarded_at, revision) ON inventory.stock_batch TO inventory_run;
GRANT UPDATE (restored_base) ON inventory.stock_batch_usage TO inventory_run;
GRANT UPDATE (inverse, undone_at) ON inventory.stock_command TO inventory_run;

-- Existing B04 receipt postings share the movement ledger and invalidate stale stock cards.
CREATE FUNCTION inventory.advance_receipt_stock_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    UPDATE inventory.inventory_item
    SET revision = revision + 1, updated_at = greatest(updated_at, NEW.at)
    WHERE store_id = NEW.store_id AND item_id = NEW.item_id;
    RETURN NEW;
END
$$;
CREATE TRIGGER advance_receipt_stock_revision AFTER INSERT ON inventory.stock_movement
    FOR EACH ROW WHEN (NEW.kind = 'receive')
    EXECUTE FUNCTION inventory.advance_receipt_stock_revision();

-- Down Migration
ALTER TABLE inventory.stock_command NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM inventory.stock_command) THEN
        RAISE EXCEPTION 'Inventory stock records exist; revert the app image and retain the migration';
    END IF;
END
$$;
DROP TRIGGER advance_receipt_stock_revision ON inventory.stock_movement;
DROP FUNCTION inventory.advance_receipt_stock_revision();
DROP TABLE inventory.stock_command, inventory.stock_batch_usage, inventory.stock_batch;
REVOKE INSERT ON inventory.business_day, inventory.stock_daily_opening FROM inventory_run;
REVOKE INSERT (store_id, item_id, recipe_key, base_unit) ON inventory.inventory_item FROM inventory_run;
DROP POLICY stock_item_insert ON inventory.inventory_item;
DROP POLICY stock_item_update ON inventory.inventory_item;
DROP POLICY stock_clock_read ON inventory.store;
DROP POLICY stock_clock_write ON inventory.store;
ALTER TABLE inventory.store DROP COLUMN stock_timezone, DROP COLUMN stock_day_start;
ALTER TABLE inventory.sale_usage DROP COLUMN recorded_at;
ALTER TABLE inventory.sale_usage_correction DROP COLUMN recorded_at;
DROP INDEX inventory.outbox_catalog_sequence;
ALTER TABLE inventory.demand_forecast DROP COLUMN catalog_seq;
ALTER TABLE inventory.stock_movement DROP COLUMN source_id, DROP COLUMN reason;
ALTER TABLE inventory.inventory_item DROP COLUMN sku, DROP COLUMN name, DROP COLUMN display_unit,
    DROP COLUMN threshold_base, DROP COLUMN track_restock, DROP COLUMN track_expiry, DROP COLUMN revision,
    DROP COLUMN updated_at, DROP COLUMN archived_at;
