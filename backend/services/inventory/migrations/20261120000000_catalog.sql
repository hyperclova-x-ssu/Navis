-- Up Migration
-- Account owns the authoritative store. Inventory keeps its ID for local foreign keys.
CREATE TABLE inventory.store (
    store_id uuid PRIMARY KEY
);

-- Retail catalog rows can refer to an inventory item in the same store.
CREATE TABLE inventory.inventory_item (
    item_id uuid PRIMARY KEY,
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    UNIQUE (store_id, item_id)
);

CREATE TABLE inventory.menu_item (
    menu_id uuid PRIMARY KEY,
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    kind text NOT NULL,
    name text NOT NULL CHECK (btrim(name) <> ''),
    category text NOT NULL,
    price numeric NOT NULL CHECK (price BETWEEN 1 AND 999999999999 AND price = trunc(price)),
    sale_status text NOT NULL CHECK (sale_status IN ('selling', 'sold_out')),
    inventory_item_id uuid,
    deleted_at timestamptz,
    UNIQUE (store_id, menu_id),
    FOREIGN KEY (store_id, inventory_item_id) REFERENCES inventory.inventory_item (store_id, item_id),
    CHECK (
        (kind = 'menu' AND category IN ('drink', 'dessert') AND inventory_item_id IS NULL)
        OR (kind = 'retail' AND category = 'retail' AND inventory_item_id IS NOT NULL)
    )
);

CREATE INDEX menu_item_inventory_item_fk_idx ON inventory.menu_item (store_id, inventory_item_id)
WHERE inventory_item_id IS NOT NULL;

ALTER TABLE inventory.store ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.store FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON inventory.store TO inventory_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

ALTER TABLE inventory.inventory_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.inventory_item FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON inventory.inventory_item TO inventory_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

ALTER TABLE inventory.menu_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.menu_item FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON inventory.menu_item TO inventory_mig, inventory_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));

GRANT SELECT ON inventory.menu_item TO inventory_run;

-- Down Migration
DROP TABLE inventory.menu_item;
DROP TABLE inventory.inventory_item;
DROP TABLE inventory.store;
