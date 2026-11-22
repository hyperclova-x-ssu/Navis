-- Up Migration
-- An opaque recipient group ID names one B19 semantic group of this store for notice SMS. The browser only ever
-- holds the opaque ID; members are classified and consent is read from Customer at preview, press and send.
CREATE TABLE marketing.notice_recipient_group (
    store_id uuid NOT NULL,
    recipient_group_id uuid NOT NULL,
    group_id text NOT NULL CHECK (group_id IN ('churn-risk', 'first-visit', 'regular')),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, recipient_group_id),
    UNIQUE (store_id, group_id)
);
ALTER TABLE marketing.notice_recipient_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.notice_recipient_group FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_scope ON marketing.notice_recipient_group TO marketing_mig, marketing_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON marketing.notice_recipient_group TO marketing_run;

-- Scheduled owner notice SMS stay in Marketing's own ledger until the scheduled minute (RV-GAP-B-3).
-- marketing-worker claims a due row through the private dispatch routes; Marketing re-checks consent and the
-- closure revision at claim time and returns the batch numbers in memory only. No phone number is stored here.
CREATE TABLE marketing.notice_sms_dispatch (
    store_id uuid NOT NULL,
    dispatch_id uuid NOT NULL,
    notice_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    scheduled_at timestamptz NOT NULL,
    scheduled_local text NOT NULL CHECK (scheduled_local ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d$'),
    content text NOT NULL,
    message_type text NOT NULL CHECK (message_type IN ('SMS', 'LMS')),
    recipient_group_id uuid NOT NULL,
    closure jsonb,
    period jsonb,
    state text NOT NULL CHECK (state IN ('scheduled', 'canceled', 'dispatching', 'sent', 'skipped', 'failed', 'uncertain')),
    reason text CHECK (reason ~ '^[A-Z0-9_]{1,64}$'),
    batches jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(batches) = 'array'),
    recipient_count integer CHECK (recipient_count >= 0),
    claimed_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, dispatch_id),
    FOREIGN KEY (store_id, notice_id) REFERENCES marketing.reply_notice_record (store_id, id),
    FOREIGN KEY (store_id, recipient_group_id) REFERENCES marketing.notice_recipient_group (store_id, recipient_group_id)
);
CREATE UNIQUE INDEX notice_sms_dispatch_active ON marketing.notice_sms_dispatch (store_id, notice_id)
    WHERE state IN ('scheduled', 'dispatching');
CREATE INDEX notice_sms_dispatch_due ON marketing.notice_sms_dispatch (store_id, state, scheduled_at);

ALTER TABLE marketing.notice_sms_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.notice_sms_dispatch FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_scope ON marketing.notice_sms_dispatch TO marketing_mig, marketing_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON marketing.notice_sms_dispatch TO marketing_run;
GRANT UPDATE (state, reason, batches, recipient_count, claimed_at, finished_at)
    ON marketing.notice_sms_dispatch TO marketing_run;

-- A definitive pre-network rejection finishes the attempt with a `rejected` receipt instead of a pending one
-- (RV-GAP-B-5). The receipt column already accepts JSON, so no column change is needed.

-- Down Migration
-- After any dispatch exists, roll back the app image and retain the ledger.
ALTER TABLE marketing.notice_sms_dispatch NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM marketing.notice_sms_dispatch) THEN
        RAISE EXCEPTION 'Notice SMS dispatches exist; revert the app image and retain the migration';
    END IF;
END $$;
DROP TABLE marketing.notice_sms_dispatch, marketing.notice_recipient_group;
