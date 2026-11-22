-- Up Migration
ALTER TABLE account.attachment ADD COLUMN object_key text;
ALTER TABLE account.attachment DROP CONSTRAINT attachment_check1;
ALTER TABLE account.attachment
  ADD CONSTRAINT attachment_object_scope_check CHECK (
    object_key IS NULL OR object_key = 'account/attachments/' || store_id::text || '/' || file_id::text || '/' || sha256
  ),
  ADD CONSTRAINT attachment_storage_state_check CHECK (
    (bytes IS NULL OR object_key IS NULL)
    AND (state <> 'complete' OR bytes IS NOT NULL OR object_key IS NOT NULL)
    AND (state <> 'revoked' OR bytes IS NULL)
  );
GRANT UPDATE (object_key) ON account.attachment TO account_run;

-- Down Migration
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM account.attachment WHERE object_key IS NOT NULL) THEN
    RAISE EXCEPTION 'Preserve object-backed attachments with an application rollback';
  END IF;
END
$guard$;
ALTER TABLE account.attachment
  DROP CONSTRAINT attachment_storage_state_check,
  DROP COLUMN object_key,
  ADD CONSTRAINT attachment_check1 CHECK (
    (state <> 'complete' OR bytes IS NOT NULL) AND (state <> 'revoked' OR bytes IS NULL)
  );
