-- Up Migration
ALTER TABLE inventory.inventory_item
    ADD COLUMN recipe_key text,
    ADD COLUMN base_unit text CHECK (base_unit IN ('g', 'mL', 'pcs')),
    ADD UNIQUE (store_id, recipe_key);

CREATE TABLE inventory.business_day (
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    business_date date NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    closed_at timestamptz,
    PRIMARY KEY (store_id, business_date),
    UNIQUE (store_id, starts_at)
);

CREATE TABLE inventory.recipe_version (
    store_id uuid NOT NULL,
    menu_id uuid NOT NULL,
    -- Base recipes use the menu ID. Options use their own ID, scoped to the parent menu.
    component_id uuid NOT NULL,
    version text NOT NULL CHECK (version ~ '^[0-9a-f]{64}$'),
    ingredients jsonb NOT NULL CHECK (jsonb_typeof(ingredients) = 'array'),
    PRIMARY KEY (store_id, menu_id, component_id, version),
    FOREIGN KEY (store_id, menu_id) REFERENCES inventory.menu_item (store_id, menu_id)
);

CREATE TABLE inventory.recipe_current (
    store_id uuid NOT NULL,
    menu_id uuid NOT NULL,
    component_id uuid NOT NULL,
    version text NOT NULL,
    PRIMARY KEY (store_id, menu_id, component_id),
    FOREIGN KEY (store_id, menu_id, component_id, version)
        REFERENCES inventory.recipe_version (store_id, menu_id, component_id, version)
);

CREATE TABLE inventory.sale_usage (
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    settlement_id uuid NOT NULL,
    business_date date NOT NULL,
    sale jsonb NOT NULL,
    PRIMARY KEY (store_id, settlement_id)
);
CREATE INDEX sale_usage_day ON inventory.sale_usage (store_id, business_date);

CREATE TABLE inventory.sale_usage_line (
    store_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    allocation_id uuid NOT NULL,
    line_identity jsonb NOT NULL,
    recognized_quantity integer NOT NULL CHECK (recognized_quantity > 0),
    restored_quantity integer NOT NULL DEFAULT 0 CHECK (restored_quantity BETWEEN 0 AND recognized_quantity),
    ingredients jsonb NOT NULL CHECK (jsonb_typeof(ingredients) = 'array'),
    PRIMARY KEY (store_id, settlement_id, allocation_id),
    FOREIGN KEY (store_id, settlement_id) REFERENCES inventory.sale_usage (store_id, settlement_id)
);

CREATE TABLE inventory.sale_usage_correction (
    store_id uuid NOT NULL,
    correction_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    correction jsonb NOT NULL,
    PRIMARY KEY (store_id, correction_id),
    FOREIGN KEY (store_id, settlement_id) REFERENCES inventory.sale_usage (store_id, settlement_id)
);
CREATE INDEX sale_usage_correction_settlement ON inventory.sale_usage_correction (store_id, settlement_id);

CREATE TABLE inventory.supplier (
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    supplier_id uuid NOT NULL,
    name text NOT NULL CHECK (btrim(name) <> ''),
    PRIMARY KEY (store_id, supplier_id)
);

CREATE TABLE inventory.purchase_order (
    store_id uuid NOT NULL,
    po_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    ordered_on date NOT NULL,
    canceled_at timestamptz,
    PRIMARY KEY (store_id, po_id),
    FOREIGN KEY (store_id, supplier_id) REFERENCES inventory.supplier (store_id, supplier_id)
);
CREATE INDEX purchase_order_supplier ON inventory.purchase_order (store_id, supplier_id);

CREATE TABLE inventory.purchase_order_line (
    store_id uuid NOT NULL,
    pol_id uuid NOT NULL,
    po_id uuid NOT NULL,
    item_id uuid NOT NULL,
    qty_ordered bigint NOT NULL CHECK (qty_ordered BETWEEN 1 AND 9007199254740991),
    unit_snapshot text NOT NULL CHECK (btrim(unit_snapshot) <> ''),
    base_per_unit bigint NOT NULL CHECK (base_per_unit > 0),
    unit_price bigint NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (store_id, pol_id),
    FOREIGN KEY (store_id, po_id) REFERENCES inventory.purchase_order (store_id, po_id),
    FOREIGN KEY (store_id, item_id) REFERENCES inventory.inventory_item (store_id, item_id)
);
CREATE INDEX purchase_order_line_order ON inventory.purchase_order_line (store_id, po_id);
CREATE INDEX purchase_order_line_item ON inventory.purchase_order_line (store_id, item_id);

CREATE TABLE inventory.goods_receipt (
    store_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    pol_id uuid NOT NULL,
    qty bigint NOT NULL CHECK (qty > 0),
    qty_remaining bigint NOT NULL CHECK (qty_remaining >= 0),
    received_at timestamptz NOT NULL,
    idempotency_key text NOT NULL,
    PRIMARY KEY (store_id, receipt_id),
    UNIQUE (store_id, idempotency_key),
    FOREIGN KEY (store_id, pol_id) REFERENCES inventory.purchase_order_line (store_id, pol_id)
);
CREATE INDEX goods_receipt_line ON inventory.goods_receipt (store_id, pol_id);

CREATE TABLE inventory.stock_daily_opening (
    store_id uuid NOT NULL,
    business_date date NOT NULL,
    item_id uuid NOT NULL,
    channel text NOT NULL CHECK (channel IN ('store', 'online')),
    quantity_base bigint NOT NULL,
    PRIMARY KEY (store_id, business_date, item_id, channel),
    FOREIGN KEY (store_id, business_date) REFERENCES inventory.business_day (store_id, business_date),
    FOREIGN KEY (store_id, item_id) REFERENCES inventory.inventory_item (store_id, item_id)
);
CREATE INDEX stock_daily_opening_item ON inventory.stock_daily_opening (store_id, item_id);

CREATE TABLE inventory.stock_movement (
    store_id uuid NOT NULL,
    movement_id uuid NOT NULL,
    item_id uuid NOT NULL,
    business_date date NOT NULL,
    kind text NOT NULL CHECK (kind IN ('receive', 'adjust', 'waste', 'transfer')),
    delta_base bigint NOT NULL CHECK (delta_base <> 0),
    channel text NOT NULL CHECK (channel IN ('store', 'online')),
    receipt_id uuid,
    at timestamptz NOT NULL,
    PRIMARY KEY (store_id, movement_id),
    UNIQUE (store_id, receipt_id),
    FOREIGN KEY (store_id, business_date) REFERENCES inventory.business_day (store_id, business_date),
    FOREIGN KEY (store_id, item_id) REFERENCES inventory.inventory_item (store_id, item_id),
    FOREIGN KEY (store_id, receipt_id) REFERENCES inventory.goods_receipt (store_id, receipt_id),
    CHECK ((kind = 'receive') = (receipt_id IS NOT NULL)),
    CHECK (kind <> 'receive' OR delta_base > 0)
);
CREATE INDEX stock_movement_items ON inventory.stock_movement (store_id, item_id, business_date, channel);
CREATE INDEX stock_movement_days ON inventory.stock_movement (store_id, business_date);

CREATE TABLE inventory.outbox_scope (
    scope_key text PRIMARY KEY,
    last_seq bigint NOT NULL CHECK (last_seq > 0)
);

CREATE TABLE inventory.outbox (
    event_id uuid PRIMARY KEY,
    producer text NOT NULL DEFAULT 'inventory' CHECK (producer = 'inventory'),
    store_id uuid NOT NULL REFERENCES inventory.store (store_id),
    scope_key text NOT NULL CHECK (scope_key = store_id::text),
    store_seq bigint NOT NULL CHECK (store_seq > 0),
    event_type text NOT NULL,
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
    aggregate_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    published_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz,
    UNIQUE (scope_key, store_seq),
    UNIQUE (store_id, event_type, aggregate_id)
);
CREATE INDEX outbox_pending ON inventory.outbox (scope_key, store_seq) WHERE published_at IS NULL;

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY[
        'business_day', 'recipe_version', 'recipe_current', 'sale_usage',
        'sale_usage_line', 'sale_usage_correction', 'supplier', 'purchase_order', 'purchase_order_line',
        'goods_receipt', 'stock_daily_opening', 'stock_movement', 'outbox', 'outbox_scope'
    ] LOOP
        EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY', name);
        EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY', name);
        EXECUTE format(
            'CREATE POLICY stock_scope ON inventory.%I TO inventory_mig, inventory_run USING (%s)',
            name,
            CASE WHEN name = 'outbox_scope'
                THEN 'scope_key = (SELECT current_setting(''app.store_id'', true))'
                ELSE 'store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid)'
            END
        );
    END LOOP;
END
$$;

GRANT SELECT ON inventory.business_day, inventory.recipe_version, inventory.recipe_current,
    inventory.sale_usage, inventory.sale_usage_line, inventory.sale_usage_correction, inventory.purchase_order,
    inventory.purchase_order_line, inventory.goods_receipt, inventory.stock_daily_opening,
    inventory.stock_movement, inventory.outbox, inventory.outbox_scope TO inventory_run;
GRANT INSERT ON inventory.sale_usage, inventory.sale_usage_line, inventory.sale_usage_correction,
    inventory.goods_receipt, inventory.stock_movement, inventory.outbox, inventory.outbox_scope TO inventory_run;
GRANT UPDATE (restored_quantity) ON inventory.sale_usage_line TO inventory_run;
GRANT UPDATE (last_seq) ON inventory.outbox_scope TO inventory_run;

-- Down Migration
DROP TABLE inventory.outbox, inventory.outbox_scope;
DROP TABLE inventory.stock_movement, inventory.stock_daily_opening, inventory.goods_receipt;
DROP TABLE inventory.purchase_order_line, inventory.purchase_order, inventory.supplier;
DROP TABLE inventory.sale_usage_correction, inventory.sale_usage_line, inventory.sale_usage;
DROP TABLE inventory.recipe_current, inventory.recipe_version, inventory.business_day;
ALTER TABLE inventory.inventory_item DROP COLUMN recipe_key, DROP COLUMN base_unit;
