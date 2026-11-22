-- Up Migration
DO $receipt_worker$
BEGIN
    IF to_regrole('pos_wrk') IS NOT NULL THEN
        CREATE POLICY receipt_worker_store ON pos.store TO pos_wrk
            USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
        GRANT SELECT (store_id), INSERT (store_id) ON pos.store TO pos_wrk;
    END IF;
END
$receipt_worker$;

-- Down Migration
DO $receipt_worker$
BEGIN
    IF to_regrole('pos_wrk') IS NOT NULL THEN
        REVOKE SELECT (store_id), INSERT (store_id) ON pos.store FROM pos_wrk;
    END IF;
END
$receipt_worker$;
DROP POLICY IF EXISTS receipt_worker_store ON pos.store;
