-- Up Migration
CREATE TABLE marketing.card_approval (
    store_id uuid NOT NULL, approval_id uuid NOT NULL, actor_id uuid NOT NULL,
    operation text NOT NULL, target_ref text, revision integer NOT NULL CHECK (revision >= 0),
    fingerprint text NOT NULL, expires_at timestamptz NOT NULL, confirmed_at timestamptz, consumed_at timestamptz,
    requires_confirmation boolean NOT NULL,
    PRIMARY KEY (store_id, approval_id)
);
CREATE INDEX card_approval_expiry ON marketing.card_approval (store_id, expires_at);
ALTER TABLE marketing.card_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.card_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON marketing.card_approval TO marketing_mig, marketing_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT, DELETE ON marketing.card_approval TO marketing_run;
GRANT UPDATE (confirmed_at, consumed_at) ON marketing.card_approval TO marketing_run;

-- Down Migration
DROP TABLE marketing.card_approval;
