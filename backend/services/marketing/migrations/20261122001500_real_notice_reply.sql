-- Up Migration
CREATE TABLE marketing.reply_notice_record (
    store_id uuid NOT NULL,
    id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('inquiry', 'notice')),
    revision integer NOT NULL CHECK (revision > 0),
    status text NOT NULL CHECK (status IN ('waiting', 'draft_ready', 'draft', 'done', 'deleted')),
    source text CHECK (source IN ('manual', 'review', 'talktalk')),
    provider_ref text,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, id),
    UNIQUE (store_id, source, provider_ref),
    CHECK ((kind = 'inquiry') = (source IS NOT NULL)),
    CHECK (COALESCE(source IN ('review', 'talktalk'), false) = (provider_ref IS NOT NULL))
);
CREATE INDEX reply_notice_listing ON marketing.reply_notice_record (store_id, kind, id);

CREATE TABLE marketing.reply_notice_command (
    store_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action_key text NOT NULL,
    resource_id uuid NOT NULL,
    approval_id uuid,
    fingerprint text NOT NULL,
    receipt_id uuid NOT NULL,
    receipt jsonb,
    PRIMARY KEY (store_id, actor_id, action_key),
    UNIQUE (store_id, approval_id),
    UNIQUE (store_id, receipt_id),
    FOREIGN KEY (store_id, resource_id) REFERENCES marketing.reply_notice_record (store_id, id)
);
CREATE UNIQUE INDEX reply_notice_pending ON marketing.reply_notice_command (store_id, resource_id) WHERE receipt IS NULL;

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['reply_notice_record', 'reply_notice_command'] LOOP
        EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE marketing.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY marketing_scope ON marketing.%I TO marketing_mig, marketing_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', table_name);
    END LOOP;
END $$;
GRANT SELECT, INSERT ON marketing.reply_notice_record, marketing.reply_notice_command TO marketing_run;
GRANT UPDATE (revision, status, data, updated_at) ON marketing.reply_notice_record TO marketing_run;
GRANT UPDATE (receipt) ON marketing.reply_notice_command TO marketing_run;

-- Changes to the same inquiry or notice are independent ordered outbox events.
CREATE UNIQUE INDEX marketing_outbox_singleton ON marketing.outbox (store_id, event_type, aggregate_id)
    WHERE event_type NOT IN ('marketing.inquiry_changed.v1', 'marketing.message_status_changed.v1');
CREATE UNIQUE INDEX marketing_outbox_notice_reply_revision ON marketing.outbox
    (store_id, event_type, aggregate_id, ((payload->>'revision')::integer))
    WHERE event_type IN ('marketing.inquiry_changed.v1', 'marketing.message_status_changed.v1');
ALTER TABLE marketing.outbox DROP CONSTRAINT outbox_store_id_event_type_aggregate_id_key;

-- Down Migration
-- After any owner records exist, roll back the app image and retain the schema.
ALTER TABLE marketing.reply_notice_record NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM marketing.reply_notice_record) THEN
        RAISE EXCEPTION 'Notice or reply records exist; revert the app image and retain the migration';
    END IF;
END $$;
DROP INDEX marketing.marketing_outbox_notice_reply_revision;
DROP INDEX marketing.marketing_outbox_singleton;
ALTER TABLE marketing.outbox ADD UNIQUE (store_id, event_type, aggregate_id);
DROP TABLE marketing.reply_notice_command, marketing.reply_notice_record;
