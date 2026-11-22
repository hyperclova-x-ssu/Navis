-- Up Migration
ALTER TABLE marketing.promo_job_media DROP CONSTRAINT promo_job_media_check;
ALTER TABLE marketing.promo_job_media ADD CONSTRAINT promo_job_media_purpose CHECK (
    (purpose = 'promo_output' AND content_type = 'video/mp4')
    OR (purpose = 'promo_checkpoint' AND content_type IN ('application/json', 'application/octet-stream'))
    OR (purpose = 'promo_poster' AND content_type = 'image/jpeg')
    OR (purpose = 'promo_scene' AND content_type = 'application/octet-stream')
);

-- Down Migration
ALTER TABLE marketing.promo_job_media DROP CONSTRAINT promo_job_media_purpose;
ALTER TABLE marketing.promo_job_media ADD CONSTRAINT promo_job_media_check CHECK (
    (purpose = 'promo_output' AND content_type = 'video/mp4')
    OR (purpose = 'promo_checkpoint' AND content_type IN ('application/json', 'application/octet-stream'))
) NOT VALID;
