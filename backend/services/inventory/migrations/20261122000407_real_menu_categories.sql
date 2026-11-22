-- Up Migration
-- This change follows the installed Inventory migrations so existing volumes can upgrade in order.
ALTER TABLE inventory.menu_item
    DROP CONSTRAINT menu_item_check,
    ADD CONSTRAINT menu_item_category_check CHECK (
        (kind = 'menu' AND category IN ('coffee', 'tea', 'beverage', 'dessert', 'drink') AND inventory_item_id IS NULL)
        OR (kind = 'retail' AND category = 'retail' AND inventory_item_id IS NOT NULL)
    ),
    ADD COLUMN seasonal text CHECK (seasonal IS NULL OR (kind = 'menu' AND btrim(seasonal) <> ''));

-- Down Migration
-- Refuse a rollback that would lose persisted categorizations or seasonal markers.
ALTER TABLE inventory.menu_item ADD CONSTRAINT menu_item_legacy_category_check CHECK (
    ((kind = 'menu' AND category IN ('drink', 'dessert') AND inventory_item_id IS NULL)
      OR (kind = 'retail' AND category = 'retail' AND inventory_item_id IS NOT NULL))
    AND seasonal IS NULL
);
ALTER TABLE inventory.menu_item DROP CONSTRAINT menu_item_category_check, DROP CONSTRAINT menu_item_legacy_category_check, DROP COLUMN seasonal;
ALTER TABLE inventory.menu_item ADD CONSTRAINT menu_item_check CHECK (
    (kind = 'menu' AND category IN ('drink', 'dessert') AND inventory_item_id IS NULL)
    OR (kind = 'retail' AND category = 'retail' AND inventory_item_id IS NOT NULL)
);
