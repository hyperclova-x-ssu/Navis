-- Up Migration
ALTER TABLE pos.bill ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE pos.store_table ADD COLUMN layout_table_id text
    CHECK (layout_table_id ~ '^[A-Za-z0-9_-]{1,80}$');
CREATE UNIQUE INDEX store_table_active_layout_id ON pos.store_table (store_id, layout_table_id)
    WHERE layout_table_id IS NOT NULL AND state <> 'archived';

ALTER TABLE pos.table_session ADD COLUMN session_id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN open_ordinal bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE pos.table_session DROP CONSTRAINT table_session_pkey, ADD PRIMARY KEY (store_id, session_id);
CREATE INDEX table_session_bill_history ON pos.table_session (store_id, bill_id, open_ordinal DESC);
CREATE INDEX table_session_table_history ON pos.table_session (store_id, table_id, open_ordinal DESC);
CREATE UNIQUE INDEX table_session_active_bill ON pos.table_session (store_id, bill_id) WHERE ended_at IS NULL;

ALTER TABLE pos.pos_order DROP CONSTRAINT pos_order_store_id_origin_bill_id_key,
    ADD COLUMN preparing_at timestamptz,
    ADD COLUMN completed_at timestamptz,
    ADD COLUMN status_history jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(status_history) = 'array');
CREATE INDEX pos_order_origin_bill ON pos.pos_order (store_id, origin_bill_id);
GRANT UPDATE (revision) ON pos.bill TO pos_run;
GRANT UPDATE (bill_id, quantity) ON pos.bill_allocation TO pos_run;
GRANT DELETE ON pos.bill_allocation TO pos_run;
GRANT UPDATE (preparing_at, completed_at, status_history) ON pos.pos_order TO pos_run;

-- Down Migration
-- Refuse destructive downgrade once postpaid state or its history exists.
ALTER TABLE pos.bill NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pos.pos_order NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pos.store_table NO FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
    IF EXISTS (SELECT 1 FROM pos.bill WHERE draft->>'postpaid' = 'true')
        OR EXISTS (SELECT 1 FROM pos.pos_order WHERE preparing_at IS NOT NULL OR completed_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM pos.store_table WHERE layout_table_id IS NOT NULL) THEN
        RAISE EXCEPTION 'POS postpaid records exist; roll back the application instead';
    END IF;
END
$migration$;
ALTER TABLE pos.bill FORCE ROW LEVEL SECURITY;
ALTER TABLE pos.pos_order FORCE ROW LEVEL SECURITY;
ALTER TABLE pos.store_table FORCE ROW LEVEL SECURITY;
REVOKE UPDATE (revision) ON pos.bill FROM pos_run;
REVOKE UPDATE (bill_id, quantity) ON pos.bill_allocation FROM pos_run;
REVOKE DELETE ON pos.bill_allocation FROM pos_run;
REVOKE UPDATE (preparing_at, completed_at, status_history) ON pos.pos_order FROM pos_run;
DROP INDEX pos.pos_order_origin_bill, pos.table_session_bill_history, pos.table_session_table_history,
    pos.table_session_active_bill, pos.store_table_active_layout_id;
ALTER TABLE pos.pos_order ADD UNIQUE (store_id, origin_bill_id),
    DROP COLUMN preparing_at, DROP COLUMN completed_at, DROP COLUMN status_history;
ALTER TABLE pos.table_session DROP CONSTRAINT table_session_pkey,
    ADD PRIMARY KEY (store_id, bill_id), DROP COLUMN session_id, DROP COLUMN open_ordinal;
ALTER TABLE pos.store_table DROP COLUMN layout_table_id;
ALTER TABLE pos.bill DROP COLUMN revision;
