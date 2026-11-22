-- Up Migration
CREATE TABLE marketing.community_cafe_post (
  store_id uuid NOT NULL, actor_id uuid NOT NULL, action_key text NOT NULL, fingerprint text NOT NULL,
  id uuid NOT NULL, receipt_id uuid NOT NULL, subject text NOT NULL,
  revision integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'pending-reconciliation',
  article_id bigint, article_url text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, id), UNIQUE (store_id, actor_id, action_key),
  CHECK (state IN ('pending-reconciliation', 'published', 'rejected')),
  CHECK ((state = 'published') = (article_id IS NOT NULL AND article_url IS NOT NULL))
);
ALTER TABLE marketing.community_cafe_post ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.community_cafe_post FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_post_scope ON marketing.community_cafe_post TO marketing_mig, marketing_run
  USING (store_id = nullif(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (store_id = nullif(current_setting('app.store_id', true), '')::uuid);
GRANT SELECT, INSERT ON marketing.community_cafe_post TO marketing_run;
GRANT UPDATE (state, article_id, article_url, revision, updated_at) ON marketing.community_cafe_post TO marketing_run;

-- Down Migration
DROP TABLE marketing.community_cafe_post;
