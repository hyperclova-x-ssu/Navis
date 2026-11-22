-- Up Migration
CREATE TABLE marketing.notice_reply_approval (
    store_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('inquiry.attest','inquiry.post','inquiry.editReply','inquiry.deleteReply',
      'notice.attest','notice.deleteDraft','notice.send','notice.deleteNews')),
    revision integer NOT NULL CHECK (revision > 0),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    confirmed_at timestamptz CHECK (confirmed_at >= created_at AND confirmed_at < expires_at),
    PRIMARY KEY (store_id, approval_id),
    FOREIGN KEY (store_id, resource_id) REFERENCES marketing.reply_notice_record (store_id, id)
);
ALTER TABLE marketing.notice_reply_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.notice_reply_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON marketing.notice_reply_approval TO marketing_mig, marketing_run
  USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON marketing.notice_reply_approval TO marketing_run;
GRANT UPDATE (confirmed_at) ON marketing.notice_reply_approval TO marketing_run;

-- Down Migration
DROP TABLE marketing.notice_reply_approval;
