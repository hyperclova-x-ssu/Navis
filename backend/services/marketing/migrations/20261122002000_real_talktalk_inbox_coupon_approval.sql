-- Up Migration
CREATE TABLE marketing.talktalk_inbox_candidate (
    store_id uuid NOT NULL,
    inquiry_id uuid NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    provider_user text NOT NULL CHECK (provider_user ~ '^[A-Za-z0-9_-]{1,200}$'),
    received_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, inquiry_id),
    FOREIGN KEY (store_id, inquiry_id) REFERENCES marketing.reply_notice_record (store_id, id)
);
CREATE INDEX talktalk_inbox_redelivery ON marketing.talktalk_inbox_candidate (store_id, fingerprint, received_at DESC);

CREATE TABLE marketing.naver_coupon_approval (
    store_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision >= 0),
    fingerprint text NOT NULL,
    expires_at timestamptz NOT NULL,
    confirmed_at timestamptz,
    consumed_at timestamptz,
    PRIMARY KEY (store_id, approval_id)
);
ALTER TABLE marketing.naver_coupon_action ADD COLUMN approval_id uuid,
    ADD FOREIGN KEY (store_id, approval_id) REFERENCES marketing.naver_coupon_approval (store_id, approval_id),
    ADD UNIQUE (store_id, approval_id);
CREATE INDEX naver_coupon_action_pending ON marketing.naver_coupon_action (store_id)
    WHERE state = 'pending' AND approval_id IS NOT NULL;

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['talktalk_inbox_candidate', 'naver_coupon_approval'] LOOP
        EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE marketing.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY marketing_scope ON marketing.%I TO marketing_mig, marketing_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', table_name);
    END LOOP;
END $$;
GRANT SELECT, INSERT ON marketing.talktalk_inbox_candidate, marketing.naver_coupon_approval TO marketing_run;
GRANT UPDATE (confirmed_at, consumed_at) ON marketing.naver_coupon_approval TO marketing_run;

-- Down Migration
-- Roll back the application image and retain this schema after recording candidate recipients or approvals.
ALTER TABLE marketing.talktalk_inbox_candidate NO FORCE ROW LEVEL SECURITY;
ALTER TABLE marketing.naver_coupon_approval NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM marketing.talktalk_inbox_candidate) OR EXISTS (SELECT FROM marketing.naver_coupon_approval) THEN
        RAISE EXCEPTION 'TalkTalk candidates or coupon approvals exist; revert the app image and retain the migration';
    END IF;
END $$;
DROP INDEX marketing.naver_coupon_action_pending;
ALTER TABLE marketing.naver_coupon_action DROP COLUMN approval_id;
DROP TABLE marketing.talktalk_inbox_candidate, marketing.naver_coupon_approval;
