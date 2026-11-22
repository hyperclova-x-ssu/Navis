-- Up Migration
-- The service database bootstrap creates the dedicated worker login and grants CONNECT.
GRANT USAGE ON SCHEMA inventory TO inventory_wrk;
GRANT SELECT ON inventory.recipe_version TO inventory_wrk;
GRANT SELECT, INSERT ON inventory.sale_usage, inventory.sale_usage_line,
    inventory.sale_usage_correction, inventory.stock_batch_usage TO inventory_wrk;
GRANT UPDATE (restored_quantity) ON inventory.sale_usage_line TO inventory_wrk;
GRANT UPDATE (restored_base) ON inventory.stock_batch_usage TO inventory_wrk;
GRANT SELECT (store_id, item_id, revision, updated_at),
    UPDATE (revision, updated_at) ON inventory.inventory_item TO inventory_wrk;
GRANT SELECT (store_id, batch_id, item_id, expires_on, received_at, discarded_at, remaining_base, revision),
    UPDATE (remaining_base, revision) ON inventory.stock_batch TO inventory_wrk;
GRANT SELECT, INSERT, UPDATE (last_seq) ON inventory.outbox_scope TO inventory_wrk;
GRANT INSERT (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
    ON inventory.outbox TO inventory_wrk;

CREATE POLICY stock_worker_scope ON inventory.recipe_version FOR SELECT TO inventory_wrk
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY stock_worker_scope ON inventory.outbox FOR INSERT TO inventory_wrk
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid)
        AND event_type = 'inventory.stock_changed.v1');
CREATE POLICY stock_worker_scope ON inventory.outbox_scope TO inventory_wrk
    USING (scope_key = (SELECT nullif(current_setting('app.store_id', true), '')))
    WITH CHECK (scope_key = (SELECT nullif(current_setting('app.store_id', true), '')));

DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY[
        'sale_usage', 'sale_usage_line', 'sale_usage_correction', 'inventory_item', 'stock_batch', 'stock_batch_usage'
    ] LOOP
        EXECUTE format(
            'CREATE POLICY stock_worker_scope ON inventory.%I TO inventory_wrk
              USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
              WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))',
            name
        );
    END LOOP;
END
$$;

-- Down Migration
DO $$
DECLARE name text;
BEGIN
    FOREACH name IN ARRAY ARRAY[
        'recipe_version', 'outbox', 'outbox_scope', 'sale_usage', 'sale_usage_line',
        'sale_usage_correction', 'inventory_item', 'stock_batch', 'stock_batch_usage'
    ] LOOP
        EXECUTE format('DROP POLICY stock_worker_scope ON inventory.%I', name);
    END LOOP;
END
$$;
REVOKE ALL ON inventory.recipe_version, inventory.sale_usage, inventory.sale_usage_line,
    inventory.sale_usage_correction, inventory.stock_batch_usage, inventory.outbox_scope FROM inventory_wrk;
REVOKE UPDATE (restored_quantity) ON inventory.sale_usage_line FROM inventory_wrk;
REVOKE UPDATE (restored_base) ON inventory.stock_batch_usage FROM inventory_wrk;
REVOKE SELECT (store_id, item_id, revision, updated_at),
    UPDATE (revision, updated_at) ON inventory.inventory_item FROM inventory_wrk;
REVOKE SELECT (store_id, batch_id, item_id, expires_on, received_at, discarded_at, remaining_base, revision),
    UPDATE (remaining_base, revision) ON inventory.stock_batch FROM inventory_wrk;
REVOKE UPDATE (last_seq) ON inventory.outbox_scope FROM inventory_wrk;
REVOKE INSERT (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
    ON inventory.outbox FROM inventory_wrk;
