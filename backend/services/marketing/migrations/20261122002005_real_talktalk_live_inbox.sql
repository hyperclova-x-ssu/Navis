-- Up Migration
ALTER TABLE marketing.talktalk_inbox_candidate ADD COLUMN is_live boolean NOT NULL DEFAULT false;

CREATE INDEX talktalk_live_conversation ON marketing.talktalk_inbox_candidate
    (store_id, provider_user, received_at DESC, inquiry_id DESC) WHERE is_live;

-- Down Migration
-- Retain provenance after accepting live data. Otherwise the prior app could route it to the virtual provider.
ALTER TABLE marketing.talktalk_inbox_candidate NO FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT FROM marketing.talktalk_inbox_candidate WHERE is_live) THEN
        RAISE EXCEPTION 'Live TalkTalk inbox rows exist; retain their provenance';
    END IF;
END $$;
ALTER TABLE marketing.talktalk_inbox_candidate FORCE ROW LEVEL SECURITY;
DROP INDEX marketing.talktalk_live_conversation;
ALTER TABLE marketing.talktalk_inbox_candidate DROP COLUMN is_live;
