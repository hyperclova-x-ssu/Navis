-- Up Migration
CREATE TABLE account.credential (
  login_id text PRIMARY KEY CHECK (login_id = lower(login_id) AND length(login_id) BETWEEN 1 AND 254),
  user_id uuid NOT NULL UNIQUE REFERENCES account.app_user ON DELETE CASCADE,
  salt bytea NOT NULL CHECK (octet_length(salt) = 16),
  password_hash bytea NOT NULL CHECK (octet_length(password_hash) = 32)
);
ALTER TABLE account.credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE account.credential FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_migrate ON account.credential TO account_mig USING (true) WITH CHECK (true);
CREATE POLICY credential_login ON account.credential FOR SELECT TO account_run
  USING (login_id = current_setting('app.login_id', true));
GRANT SELECT ON account.credential TO account_run;

ALTER TABLE account.store
  ALTER COLUMN business_type DROP NOT NULL,
  ADD COLUMN onboarding_done boolean NOT NULL DEFAULT false,
  ADD COLUMN table_layout jsonb CHECK (jsonb_typeof(table_layout) = 'object'),
  ADD COLUMN pos_preferences jsonb CHECK (jsonb_typeof(pos_preferences) = 'object'),
  ADD COLUMN cctv_pos_links jsonb CHECK (jsonb_typeof(cctv_pos_links) = 'array');

-- The account transaction binds the user after credential or live session checks.
CREATE POLICY member_account_read ON account.store_member FOR SELECT TO account_run
  USING (user_id = (SELECT NULLIF(current_setting('app.user_id', true), '')::uuid));
CREATE POLICY store_account_read ON account.store FOR SELECT TO account_run
  USING (EXISTS (SELECT 1 FROM account.store_member m WHERE m.store_id = store.store_id
    AND m.user_id = (SELECT NULLIF(current_setting('app.user_id', true), '')::uuid)));
GRANT SELECT ON account.store TO account_run;
GRANT UPDATE (business_type, payment_style, pos_start_tab, table_layout, pos_preferences, cctv_pos_links,
  onboarding_done, settings_revision, updated_at) ON account.store TO account_run;
GRANT INSERT (created_at, expires_at) ON account.auth_session TO account_run;

CREATE TABLE account.preference (
  store_id uuid NOT NULL,
  user_id uuid NOT NULL,
  theme text NOT NULL CHECK (theme IN ('light', 'dark')),
  text_scale smallint NOT NULL CHECK (text_scale IN (100, 125)),
  locale text NOT NULL CHECK (locale IN ('ko', 'en', 'zh-Hans', 'zh-Hant')),
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (store_id, user_id),
  FOREIGN KEY (store_id, user_id) REFERENCES account.store_member ON DELETE CASCADE
);

CREATE TABLE account.board (
  store_id uuid NOT NULL REFERENCES account.store ON DELETE CASCADE,
  board_id text NOT NULL CHECK (board_id IN ('management', 'marketing')),
  revision integer NOT NULL CHECK (revision > 0),
  current_page smallint NOT NULL CHECK (current_page BETWEEN 0 AND 4),
  PRIMARY KEY (store_id, board_id)
);

CREATE TABLE account.board_page (
  store_id uuid NOT NULL,
  board_id text NOT NULL,
  page_id text NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 4),
  PRIMARY KEY (store_id, board_id, page_id),
  UNIQUE (store_id, board_id, position),
  FOREIGN KEY (store_id, board_id) REFERENCES account.board ON DELETE CASCADE
);

CREATE TABLE account.board_panel (
  store_id uuid NOT NULL,
  board_id text NOT NULL,
  page_id text NOT NULL,
  feature_id text NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 39),
  column_no smallint NOT NULL CHECK (column_no >= 0 AND column_no < 8),
  row_no smallint NOT NULL CHECK (row_no >= 0 AND row_no < 5),
  width smallint NOT NULL CHECK (width BETWEEN 1 AND 4 AND column_no + width <= 8),
  height smallint NOT NULL CHECK (height BETWEEN 1 AND 4 AND row_no + height <= 5),
  condition jsonb CHECK (jsonb_typeof(condition) = 'object'),
  PRIMARY KEY (store_id, board_id, page_id, feature_id),
  UNIQUE (store_id, board_id, feature_id),
  UNIQUE (store_id, board_id, page_id, position),
  FOREIGN KEY (store_id, board_id, page_id) REFERENCES account.board_page ON DELETE CASCADE
);

CREATE TABLE account.command_receipt (
  store_id uuid NOT NULL REFERENCES account.store ON DELETE CASCADE,
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  receipt_id uuid NOT NULL UNIQUE,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  PRIMARY KEY (store_id, user_id, idempotency_key)
);

CREATE TABLE account.attachment (
  store_id uuid NOT NULL REFERENCES account.store ON DELETE CASCADE,
  file_id uuid NOT NULL,
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('menu-photo', 'promo-photo', 'receipt-evidence', 'tax-evidence', 'manual-evidence', 'grant-evidence')),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp', 'application/pdf')),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 4194304),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bytea CHECK (bytes IS NULL OR octet_length(bytes) = size),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'complete', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (store_id, file_id),
  UNIQUE (store_id, user_id, idempotency_key),
  CHECK ((state <> 'complete' OR bytes IS NOT NULL) AND (state <> 'revoked' OR bytes IS NULL))
);

CREATE TABLE account.outbox_scope (
  scope_key text PRIMARY KEY,
  last_seq bigint NOT NULL CHECK (last_seq > 0)
);

CREATE TABLE account.outbox (
  event_id uuid PRIMARY KEY,
  producer text NOT NULL DEFAULT 'account' CHECK (producer = 'account'),
  store_id uuid NOT NULL REFERENCES account.store ON DELETE CASCADE,
  scope_key text NOT NULL REFERENCES account.outbox_scope,
  store_seq bigint NOT NULL CHECK (store_seq > 0),
  event_type text NOT NULL CHECK (event_type IN ('account.store_changed.v1', 'account.store_membership_changed.v1',
    'account.preferences_changed.v1', 'account.panel_changed.v1', 'account.widget_changed.v1', 'account.file_changed.v1')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  aggregate_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  UNIQUE (scope_key, store_seq),
  CHECK (scope_key = store_id::text)
);
CREATE INDEX account_outbox_pending ON account.outbox (occurred_at, event_id) WHERE published_at IS NULL;

DO $policies$
DECLARE
  relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['preference', 'board', 'board_page', 'board_panel', 'command_receipt', 'attachment', 'outbox']
  LOOP
    EXECUTE format('ALTER TABLE account.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE account.%I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY migration ON account.%I TO account_mig USING (true) WITH CHECK (true)', relation);
    EXECUTE format('CREATE POLICY store_scope ON account.%I TO account_run
      USING (store_id = (SELECT NULLIF(current_setting(''app.store_id'', true), '''')::uuid))
      WITH CHECK (store_id = (SELECT NULLIF(current_setting(''app.store_id'', true), '''')::uuid))', relation);
  END LOOP;
END
$policies$;

CREATE POLICY preference_actor ON account.preference AS RESTRICTIVE TO account_run
  USING (user_id = (SELECT NULLIF(current_setting('app.user_id', true), '')::uuid))
  WITH CHECK (user_id = (SELECT NULLIF(current_setting('app.user_id', true), '')::uuid));

ALTER TABLE account.outbox_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE account.outbox_scope FORCE ROW LEVEL SECURITY;
CREATE POLICY migration ON account.outbox_scope TO account_mig USING (true) WITH CHECK (true);
CREATE POLICY store_scope ON account.outbox_scope TO account_run
  USING (scope_key = (SELECT current_setting('app.store_id', true)))
  WITH CHECK (scope_key = (SELECT current_setting('app.store_id', true)));

GRANT SELECT, INSERT, UPDATE ON account.preference, account.board TO account_run;
GRANT SELECT, INSERT, DELETE ON account.board_page, account.board_panel TO account_run;
GRANT SELECT, INSERT ON account.command_receipt TO account_run;
GRANT SELECT, INSERT, UPDATE (bytes, state) ON account.attachment TO account_run;
GRANT SELECT, INSERT, UPDATE (last_seq) ON account.outbox_scope TO account_run;
GRANT INSERT ON account.outbox TO account_run;

-- Down Migration
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM account.outbox) OR EXISTS (SELECT 1 FROM account.credential)
    OR EXISTS (SELECT 1 FROM account.attachment) THEN
    RAISE EXCEPTION 'Account operating records require an application rollback';
  END IF;
END
$guard$;
DROP TABLE account.outbox, account.outbox_scope, account.attachment, account.command_receipt,
  account.board_panel, account.board_page, account.board, account.preference, account.credential;
REVOKE INSERT (created_at, expires_at) ON account.auth_session FROM account_run;
REVOKE SELECT, UPDATE ON account.store FROM account_run;
REVOKE UPDATE (business_type, payment_style, pos_start_tab, table_layout, pos_preferences, cctv_pos_links,
  onboarding_done, settings_revision, updated_at) ON account.store FROM account_run;
DROP POLICY store_account_read ON account.store;
DROP POLICY member_account_read ON account.store_member;
ALTER TABLE account.store DROP COLUMN onboarding_done, DROP COLUMN table_layout,
  DROP COLUMN pos_preferences, DROP COLUMN cctv_pos_links, ALTER COLUMN business_type SET NOT NULL;
