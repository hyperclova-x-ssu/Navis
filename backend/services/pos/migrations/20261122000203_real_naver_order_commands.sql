-- Up Migration
-- Owner commands for NAVER linked-POS orders (PN02 prepare/pickup). The journal row is committed before
-- the provider call so an uncertain outcome can be reconciled by the same Idempotency-Key.
CREATE TABLE pos.naver_order_command (
    store_id uuid NOT NULL REFERENCES pos.store,
    command_key text NOT NULL CHECK (command_key ~ '^[A-Za-z0-9_:.~-]{1,160}$'),
    actor_id uuid NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    receipt_id uuid NOT NULL,
    order_ref text NOT NULL CHECK (order_ref ~ '^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,159}$'),
    action text NOT NULL CHECK (action IN ('prepare', 'pickup')),
    preparation_minutes integer CHECK (preparation_minutes BETWEEN 1 AND 2147483647),
    before_revision bigint NOT NULL CHECK (before_revision > 0),
    state text NOT NULL CHECK (state IN ('pending', 'settled', 'refused', 'expired')),
    pending_until timestamptz NOT NULL,
    failure text CHECK (failure ~ '^[A-Z_]{1,64}$'),
    receipt jsonb CHECK (jsonb_typeof(receipt) = 'object'),
    created_at timestamptz NOT NULL,
    settled_at timestamptz,
    PRIMARY KEY (store_id, command_key),
    UNIQUE (store_id, receipt_id),
    CHECK ((action = 'prepare') = (preparation_minutes IS NOT NULL)),
    CHECK ((state = 'settled') = (receipt IS NOT NULL AND settled_at IS NOT NULL)),
    CHECK ((state IN ('refused', 'expired')) = (failure IS NOT NULL))
);
-- One provider command per order may be in flight; a second press waits for its reconciliation.
CREATE UNIQUE INDEX naver_order_command_pending ON pos.naver_order_command (store_id, order_ref) WHERE state = 'pending';
CREATE INDEX naver_order_command_history ON pos.naver_order_command (store_id, order_ref, settled_at) WHERE state = 'settled';
ALTER TABLE pos.naver_order_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.naver_order_command FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON pos.naver_order_command TO pos_mig, pos_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON pos.naver_order_command TO pos_run;
GRANT UPDATE (state, failure, receipt, settled_at) ON pos.naver_order_command TO pos_run;

-- Down Migration
ALTER TABLE pos.naver_order_command NO FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
    IF EXISTS (SELECT 1 FROM pos.naver_order_command) THEN
        RAISE EXCEPTION 'NAVER order command receipts exist; roll back the application instead';
    END IF;
END
$migration$;
DROP TABLE pos.naver_order_command;
