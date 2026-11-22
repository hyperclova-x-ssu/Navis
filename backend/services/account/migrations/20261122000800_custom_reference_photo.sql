-- Up Migration
ALTER TABLE account.attachment DROP CONSTRAINT attachment_purpose_check;
ALTER TABLE account.attachment ADD CONSTRAINT attachment_purpose_check CHECK (
    purpose IN ('menu-photo', 'promo-photo', 'receipt-evidence', 'tax-evidence', 'manual-evidence', 'grant-evidence')
    OR (purpose = 'custom-reference-photo' AND content_type IN ('image/png', 'image/jpeg', 'image/webp'))
);

-- Down Migration
ALTER TABLE account.attachment DROP CONSTRAINT attachment_purpose_check;
ALTER TABLE account.attachment ADD CONSTRAINT attachment_purpose_check CHECK (
    purpose IN ('menu-photo', 'promo-photo', 'receipt-evidence', 'tax-evidence', 'manual-evidence', 'grant-evidence')
);
