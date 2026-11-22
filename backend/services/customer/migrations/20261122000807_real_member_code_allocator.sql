-- Up Migration
-- The counter is private to customer_mig, which owns the SECURITY DEFINER
-- trigger function. The function's upsert is keyed by NEW.store_id, including
-- for privileged inserts without app.store_id. Member rows enforce their own
-- store scope, and a rejected insert rolls back the counter update.
ALTER POLICY store_scope ON customer.member_code_counter
    TO customer_mig USING (true) WITH CHECK (true);
ALTER POLICY store_scope ON customer.member_code_counter RENAME TO member_code_allocator;

-- Down Migration
ALTER POLICY member_code_allocator ON customer.member_code_counter RENAME TO store_scope;
ALTER POLICY store_scope ON customer.member_code_counter
    TO customer_mig
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
