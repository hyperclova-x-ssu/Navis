-- Up Migration
ALTER TABLE marketing.notice_sms_dispatch ADD COLUMN provider_live boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE marketing.notice_sms_dispatch DROP COLUMN provider_live;
