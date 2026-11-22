-- Up Migration
CREATE TABLE customer.pn11_calendar_receipt (
    receipt_seq bigint GENERATED ALWAYS AS IDENTITY,
    store_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    target_key text NOT NULL,
    operation text NOT NULL CHECK (operation IN ('calendar.add', 'works.create', 'works.update', 'works.delete')),
    resource_id uuid NOT NULL,
    fingerprint text NOT NULL,
    receipt jsonb NOT NULL,
    sent_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, approval_id)
);
CREATE INDEX pn11_calendar_receipt_source ON customer.pn11_calendar_receipt
    (store_id, actor_id, target_key, resource_id, receipt_seq DESC);
ALTER TABLE customer.pn11_calendar_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer.pn11_calendar_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON customer.pn11_calendar_receipt TO customer_mig, customer_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON customer.pn11_calendar_receipt TO customer_run;

-- Down Migration
ALTER TABLE customer.pn11_calendar_receipt NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM customer.pn11_calendar_receipt) THEN
        RAISE EXCEPTION 'PN11 receipt records exist. Revert the application and retain the audit data.';
    END IF;
END $$;
DROP TABLE customer.pn11_calendar_receipt;
