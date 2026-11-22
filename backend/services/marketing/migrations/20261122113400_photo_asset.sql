-- Up Migration
CREATE TABLE marketing.photo_asset (
    id uuid PRIMARY KEY,
    store_id uuid NOT NULL,
    menu_id text CHECK (menu_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    object_key text NOT NULL UNIQUE,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
    bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 4194304),
    width integer NOT NULL CHECK (width BETWEEN 1 AND 16384),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 16384),
    source text NOT NULL CHECK (source IN ('menu-primary', 'menu-bundle', 'promo-bundle', 'owner-upload')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (store_id, id),
    UNIQUE (store_id, sha256),
    CHECK (object_key = 'photos/' || store_id::text || '/' || sha256)
);
CREATE INDEX photo_asset_catalog_order ON marketing.photo_asset (store_id, (source <> 'menu-primary'), id);

CREATE TABLE marketing.photo_asset_alias (
    store_id uuid NOT NULL,
    legacy_id text NOT NULL CHECK (legacy_id ~ '^[a-z0-9-]{1,32}$'),
    photo_id uuid NOT NULL,
    PRIMARY KEY (store_id, legacy_id),
    FOREIGN KEY (store_id, photo_id) REFERENCES marketing.photo_asset (store_id, id)
);
CREATE INDEX photo_asset_alias_photo_fk ON marketing.photo_asset_alias (store_id, photo_id);

ALTER TABLE marketing.promo_asset ADD COLUMN photo_id uuid,
    ADD CONSTRAINT promo_asset_photo_fk FOREIGN KEY (store_id, photo_id) REFERENCES marketing.photo_asset (store_id, id);
CREATE INDEX promo_asset_photo_fk ON marketing.promo_asset (store_id, photo_id) WHERE photo_id IS NOT NULL;

ALTER TABLE marketing.photo_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.photo_asset FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_scope ON marketing.photo_asset TO marketing_mig, marketing_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
ALTER TABLE marketing.photo_asset_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.photo_asset_alias FORCE ROW LEVEL SECURITY;
CREATE POLICY marketing_scope ON marketing.photo_asset_alias TO marketing_mig, marketing_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON marketing.photo_asset, marketing.photo_asset_alias TO marketing_run;

-- Down Migration
ALTER TABLE marketing.promo_asset DROP COLUMN photo_id;
DROP TABLE marketing.photo_asset_alias, marketing.photo_asset;
