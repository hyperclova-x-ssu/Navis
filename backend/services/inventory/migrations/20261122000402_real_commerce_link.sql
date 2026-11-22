-- Up Migration
CREATE TABLE inventory.commerce_link (
    store_id uuid NOT NULL,
    item_id uuid NOT NULL,
    origin_product_no bigint NOT NULL CHECK (origin_product_no BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (store_id, item_id),
    UNIQUE (store_id, origin_product_no),
    FOREIGN KEY (store_id, item_id) REFERENCES inventory.inventory_item (store_id, item_id)
);
ALTER TABLE inventory.commerce_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.commerce_link FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_link_scope ON inventory.commerce_link TO inventory_run, inventory_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT ON inventory.commerce_link TO inventory_run;

-- Down Migration
ALTER TABLE inventory.commerce_link NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM inventory.commerce_link) THEN
        RAISE EXCEPTION 'Commerce links exist; revert the application and retain the data';
    END IF;
END $$;
DROP TABLE inventory.commerce_link;
