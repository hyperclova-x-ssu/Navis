-- Up Migration
CREATE TABLE account.app_user (
  user_id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  last_login_at timestamptz
);

CREATE TABLE account.store (
  store_id uuid PRIMARY KEY,
  display_name text NOT NULL,
  business_type text NOT NULL CHECK (business_type IN ('cafe', 'restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other')),
  payment_style text NOT NULL CHECK (payment_style IN ('prepaid', 'postpaid')),
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  business_day_start time NOT NULL DEFAULT '00:00',
  pos_start_tab text NOT NULL CHECK (pos_start_tab IN ('order', 'status', 'tables')),
  area_key text,
  lat numeric,
  lng numeric,
  settings_revision integer NOT NULL CHECK (settings_revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE account.store_member (
  store_id uuid NOT NULL REFERENCES account.store (store_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES account.app_user (user_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'staff')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (store_id, user_id)
);
CREATE INDEX store_member_user_id_idx ON account.store_member (user_id);

CREATE TABLE account.auth_session (
  store_id uuid NOT NULL,
  sid uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (statement_timestamp() + interval '8 hours'),
  revoked_at timestamptz,
  PRIMARY KEY (store_id, sid),
  -- Membership removal permanently revokes all its session families in the same transaction.
  FOREIGN KEY (store_id, user_id) REFERENCES account.store_member (store_id, user_id) ON DELETE CASCADE,
  CHECK (expires_at = created_at + interval '8 hours')
);
CREATE INDEX auth_session_member_idx ON account.auth_session (store_id, user_id);

CREATE TABLE account.refresh_token (
  store_id uuid NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  sid uuid NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (store_id, token_hash),
  FOREIGN KEY (store_id, sid) REFERENCES account.auth_session (store_id, sid) ON DELETE CASCADE
);
CREATE INDEX refresh_token_family_idx ON account.refresh_token (store_id, sid);
CREATE UNIQUE INDEX refresh_token_active_family_idx ON account.refresh_token (store_id, sid) WHERE consumed_at IS NULL;

ALTER TABLE account.store ENABLE ROW LEVEL SECURITY;
ALTER TABLE account.store FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON account.store TO account_runtime, account_migrate
  USING (current_user = 'account_migrate' OR store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

ALTER TABLE account.store_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE account.store_member FORCE ROW LEVEL SECURITY;
CREATE POLICY store_member_scope ON account.store_member TO account_runtime, account_migrate
  USING (current_user = 'account_migrate' OR store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

ALTER TABLE account.auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE account.auth_session FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_session_scope ON account.auth_session TO account_runtime, account_migrate
  USING (current_user = 'account_migrate' OR store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

ALTER TABLE account.refresh_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE account.refresh_token FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_token_scope ON account.refresh_token TO account_runtime, account_migrate
  USING (current_user = 'account_migrate' OR store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

GRANT SELECT ON account.store_member TO account_runtime;
GRANT SELECT, INSERT (store_id, sid, user_id), UPDATE (revoked_at) ON account.auth_session TO account_runtime;
GRANT SELECT, INSERT (store_id, token_hash, sid), UPDATE (consumed_at) ON account.refresh_token TO account_runtime;

-- Down Migration
DROP TABLE account.refresh_token;
DROP TABLE account.auth_session;
DROP TABLE account.store_member;
DROP TABLE account.store;
DROP TABLE account.app_user;
