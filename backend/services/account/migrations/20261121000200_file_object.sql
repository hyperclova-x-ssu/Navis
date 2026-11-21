-- Up Migration
CREATE TABLE account.file_object (
  file_id uuid PRIMARY KEY,
  store_id uuid NOT NULL CONSTRAINT file_object_store_fk
    REFERENCES account.store (store_id) ON DELETE RESTRICT,
  resource_id text NOT NULL CHECK (resource_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  artifact_id text NOT NULL CHECK (artifact_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  purpose text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 16777216),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (store_id, purpose, resource_id, artifact_id),
  CHECK (
    (purpose = 'promo_input' AND mime IN ('image/jpeg', 'image/png', 'image/webp') AND size_bytes <= 4194304)
    OR (purpose = 'promo_checkpoint' AND mime IN ('application/json', 'application/octet-stream'))
    OR (purpose = 'promo_output' AND mime = 'video/mp4')
  )
);

CREATE INDEX file_object_abandoned_idx ON account.file_object (store_id, created_at, file_id)
  WHERE status = 'uploading';

ALTER TABLE account.file_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE account.file_object FORCE ROW LEVEL SECURITY;
CREATE POLICY file_object_store_scope ON account.file_object TO account_runtime
  USING (store_id = (SELECT NULLIF(current_setting('app.store_id', true), '')::uuid));
CREATE POLICY file_object_migration_scope ON account.file_object TO account_migrate USING (true);

GRANT SELECT, INSERT (file_id, store_id, resource_id, artifact_id, purpose, storage_key, mime, size_bytes, sha256),
  UPDATE (status, created_at) ON account.file_object TO account_runtime;

-- Down Migration
DROP TABLE account.file_object;
