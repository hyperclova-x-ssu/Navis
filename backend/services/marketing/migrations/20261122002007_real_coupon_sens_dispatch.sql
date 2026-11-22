-- Up Migration
ALTER TABLE marketing.coupon_message
    ADD COLUMN dispatch_state text CHECK (dispatch_state IN
        ('ready', 'sending', 'accepted', 'delivered', 'failed', 'blocked', 'not_sent_test_mode', 'unknown')),
    ADD COLUMN provider_id text,
    ADD COLUMN dispatch_started_at timestamptz;
CREATE INDEX coupon_message_dispatch ON marketing.coupon_message (store_id, dispatch_state, scheduled_at)
    WHERE dispatch_state IS NOT NULL;
CREATE POLICY coupon_sens_worker_scope ON marketing.coupon_message TO marketing_wrk
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT ON marketing.coupon_message TO marketing_wrk;
GRANT UPDATE (dispatch_state, provider_id, dispatch_started_at) ON marketing.coupon_message TO marketing_wrk;
CREATE POLICY coupon_sens_worker_read ON marketing.coupon FOR SELECT TO marketing_wrk
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT (store_id, coupon_id, status, ends_on) ON marketing.coupon TO marketing_wrk;

-- Down Migration
DROP POLICY coupon_sens_worker_scope ON marketing.coupon_message;
DROP POLICY coupon_sens_worker_read ON marketing.coupon;
REVOKE SELECT (store_id, coupon_id, status, ends_on) ON marketing.coupon FROM marketing_wrk;
REVOKE SELECT ON marketing.coupon_message FROM marketing_wrk;
DROP INDEX marketing.coupon_message_dispatch;
ALTER TABLE marketing.coupon_message
    DROP COLUMN dispatch_state, DROP COLUMN provider_id, DROP COLUMN dispatch_started_at;
