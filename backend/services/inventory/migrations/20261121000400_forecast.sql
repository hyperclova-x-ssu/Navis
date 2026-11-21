-- Up Migration
CREATE TABLE inventory.demand_forecast (
    forecast_id uuid PRIMARY KEY,
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    target_date date NOT NULL,
    model_version text NOT NULL CHECK (model_version ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
    menu_id uuid,
    item_id uuid,
    expected numeric(38,2) NOT NULL CHECK (expected >= 0),
    generated_at timestamptz NOT NULL,
    -- The store total identifies the completed batch and retains its input fingerprint.
    input_fingerprint text CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
    UNIQUE NULLS NOT DISTINCT (store_id, target_date, model_version, menu_id, item_id),
    FOREIGN KEY (store_id, menu_id) REFERENCES inventory.menu_item (store_id, menu_id),
    FOREIGN KEY (store_id, item_id) REFERENCES inventory.inventory_item (store_id, item_id),
    CHECK (num_nonnulls(menu_id, item_id) <= 1),
    CHECK ((num_nonnulls(menu_id, item_id) = 0) = (input_fingerprint IS NOT NULL))
);

CREATE INDEX demand_forecast_menu ON inventory.demand_forecast (store_id, menu_id) WHERE menu_id IS NOT NULL;
CREATE INDEX demand_forecast_item ON inventory.demand_forecast (store_id, item_id) WHERE item_id IS NOT NULL;

ALTER TABLE inventory.demand_forecast ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.demand_forecast FORCE ROW LEVEL SECURITY;
CREATE POLICY demand_forecast_scope ON inventory.demand_forecast TO inventory_migrate, inventory_runtime
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

GRANT SELECT, INSERT ON inventory.demand_forecast TO inventory_runtime;

-- Down Migration
DROP TABLE inventory.demand_forecast;
