-- Up Migration
CREATE TABLE customer.pn11_calendar_pending (
    store_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    target_key text NOT NULL,
    resource_id uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('calendar.add', 'works.create', 'works.update', 'works.delete')),
    fingerprint text NOT NULL,
    receipt jsonb,
    list_window text[],
    running_until timestamptz,
    PRIMARY KEY (store_id, approval_id),
    UNIQUE (store_id, target_key, resource_id)
);
ALTER TABLE customer.pn11_calendar_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer.pn11_calendar_pending FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON customer.pn11_calendar_pending TO customer_mig, customer_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT, DELETE, UPDATE (running_until) ON customer.pn11_calendar_pending TO customer_run;

-- Down Migration
ALTER TABLE customer.pn11_calendar_pending NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM customer.pn11_calendar_pending) THEN
        RAISE EXCEPTION 'PN11 pending records exist. Revert the application and retain the audit data.';
    END IF;
END $$;
DROP TABLE customer.pn11_calendar_pending;
