-- Up Migration
-- B14 Navis coupon records. Coupons are campaigns, codes are the issued or posted units, and redemptions are
-- POS-bound use claims. NAVER coupons (PN05) keep their own provider lifecycle in naver_coupon_action.
CREATE TABLE marketing.coupon (
    store_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    origin text NOT NULL CHECK (origin IN ('slot', 'expiry', 'group', 'manual')),
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    benefit_type text NOT NULL CHECK (benefit_type IN ('free_item', 'percent', 'amount', 'set_price')),
    benefit_value integer NOT NULL CHECK (benefit_value >= 0),
    target_ref text CHECK (target_ref IS NULL OR char_length(target_ref) BETWEEN 1 AND 80),
    valid_hours jsonb CHECK (valid_hours IS NULL OR jsonb_typeof(valid_hours) = 'array'),
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
    origin_ref jsonb NOT NULL CHECK (jsonb_typeof(origin_ref) = 'object'),
    basis jsonb CHECK (basis IS NULL OR jsonb_typeof(basis) = 'object'),
    future_issue_count integer CHECK (future_issue_count IS NULL OR future_issue_count > 0),
    lot_key text CHECK (lot_key IS NULL OR char_length(lot_key) BETWEEN 1 AND 80),
    business_date date NOT NULL,
    created_at timestamptz NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, coupon_id),
    CHECK (ends_on >= starts_on),
    CHECK ((origin = 'expiry') = (lot_key IS NOT NULL)),
    CHECK (benefit_type <> 'percent' OR benefit_value BETWEEN 1 AND 100)
);
-- One sell-today coupon per lot and business day (AC-292 duplicate lot/day guard).
CREATE UNIQUE INDEX coupon_expiry_lot_day ON marketing.coupon (store_id, lot_key, business_date) WHERE origin = 'expiry';
CREATE INDEX coupon_status_end ON marketing.coupon (store_id, status, ends_on, coupon_id);

CREATE TABLE marketing.coupon_code (
    store_id uuid NOT NULL,
    code_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    code text NOT NULL CHECK (code ~ '^[A-Z0-9]{6,16}$'),
    route text NOT NULL CHECK (route IN ('sms', 'place_news', 'blog', 'clip')),
    issue_count integer NOT NULL CHECK (issue_count > 0),
    activated_at timestamptz,
    unpublished_at timestamptz,
    issued_terms jsonb CHECK (issued_terms IS NULL OR jsonb_typeof(issued_terms) = 'object'),
    created_at timestamptz NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, code_id),
    UNIQUE (store_id, code),
    FOREIGN KEY (store_id, coupon_id) REFERENCES marketing.coupon (store_id, coupon_id),
    CHECK (unpublished_at IS NULL OR (activated_at IS NOT NULL AND route <> 'sms'))
);
CREATE INDEX coupon_code_coupon ON marketing.coupon_code (store_id, coupon_id);

CREATE TABLE marketing.coupon_message (
    store_id uuid NOT NULL,
    message_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('coupon', 'reminder')),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
    scheduled_at timestamptz NOT NULL,
    is_night boolean NOT NULL,
    -- R1 records the intent only. The approved SENS worker (A6) accepts and reports delivery separately.
    status text NOT NULL CHECK (status IN ('queued', 'cancelled')),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, message_id),
    FOREIGN KEY (store_id, coupon_id) REFERENCES marketing.coupon (store_id, coupon_id)
);
CREATE INDEX coupon_message_coupon ON marketing.coupon_message (store_id, coupon_id, kind);

CREATE TABLE marketing.coupon_target (
    store_id uuid NOT NULL,
    code_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    reason text NOT NULL CHECK (reason IN ('slot-regular', 'regular', 'churn-risk')),
    message_id uuid NOT NULL,
    PRIMARY KEY (store_id, code_id, customer_id),
    FOREIGN KEY (store_id, code_id) REFERENCES marketing.coupon_code (store_id, code_id),
    FOREIGN KEY (store_id, message_id) REFERENCES marketing.coupon_message (store_id, message_id)
);

CREATE TABLE marketing.coupon_reminder (
    store_id uuid NOT NULL,
    reminder_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    recipients integer NOT NULL CHECK (recipients > 0),
    queued_at timestamptz NOT NULL,
    PRIMARY KEY (store_id, reminder_id),
    FOREIGN KEY (store_id, coupon_id) REFERENCES marketing.coupon (store_id, coupon_id)
);

CREATE TABLE marketing.coupon_redemption (
    store_id uuid NOT NULL,
    redemption_id uuid NOT NULL,
    code_id uuid NOT NULL,
    coupon_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    request_key text NOT NULL CHECK (char_length(request_key) BETWEEN 1 AND 160),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    command_key text CHECK (command_key IS NULL OR char_length(command_key) BETWEEN 1 AND 160),
    bill_id uuid NOT NULL,
    customer_id uuid,
    discount integer NOT NULL CHECK (discount > 0),
    scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
    terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
    business_date date NOT NULL,
    state text NOT NULL CHECK (state IN ('held', 'committed', 'released', 'reversed')),
    held_at timestamptz NOT NULL,
    hold_until timestamptz NOT NULL,
    settlement_id uuid,
    order_id uuid,
    committed_at timestamptz,
    release_reason text CHECK (release_reason IN ('aborted', 'rejected', 'owner_released')),
    released_at timestamptz,
    correction_id uuid,
    reversed_at timestamptz,
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, redemption_id),
    UNIQUE (store_id, actor_id, request_key),
    FOREIGN KEY (store_id, code_id) REFERENCES marketing.coupon_code (store_id, code_id),
    CHECK ((state IN ('committed', 'reversed')) = (settlement_id IS NOT NULL AND committed_at IS NOT NULL)),
    CHECK ((state = 'released') = (release_reason IS NOT NULL AND released_at IS NOT NULL)),
    CHECK ((state = 'reversed') = (correction_id IS NOT NULL AND reversed_at IS NOT NULL))
);
-- One live coupon per POS bill: the bill's whole-bill discount equals that coupon's claimed discount.
CREATE UNIQUE INDEX coupon_redemption_bill ON marketing.coupon_redemption (store_id, bill_id)
    WHERE state IN ('held', 'committed');
CREATE UNIQUE INDEX coupon_redemption_sale ON marketing.coupon_redemption (store_id, settlement_id, code_id)
    WHERE settlement_id IS NOT NULL;
CREATE INDEX coupon_redemption_code ON marketing.coupon_redemption (store_id, code_id, state);
CREATE INDEX coupon_redemption_held ON marketing.coupon_redemption (store_id, hold_until) WHERE state = 'held';

CREATE TABLE marketing.coupon_command (
    store_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    command_key text NOT NULL CHECK (char_length(command_key) BETWEEN 1 AND 160),
    command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
    receipt_id uuid NOT NULL,
    recorded_at timestamptz NOT NULL,
    receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
    inverse jsonb CHECK (inverse IS NULL OR jsonb_typeof(inverse) = 'array'),
    undo_until timestamptz,
    undone_at timestamptz,
    PRIMARY KEY (store_id, actor_id, command_key),
    UNIQUE (store_id, receipt_id),
    CHECK ((inverse IS NULL) = (undo_until IS NULL))
);

CREATE TABLE marketing.coupon_revision (
    store_id uuid NOT NULL,
    source text NOT NULL CHECK (source IN ('coupons', 'redemptions', 'naver')),
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, source)
);

-- PN05 Place coupon, Order promotion and named membership actions. A pending row with no settled result is
-- reconciled by its attempt key before any retry (unknown provider outcome).
CREATE TABLE marketing.naver_coupon_action (
    store_id uuid NOT NULL,
    action_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    command_key text NOT NULL CHECK (char_length(command_key) BETWEEN 1 AND 160),
    command_hash text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
    operation text NOT NULL CHECK (operation IN ('place.create', 'place.delete', 'issue.usage',
        'promotion.create', 'promotion.extend', 'promotion.end', 'membership.visibility')),
    target_ref text CHECK (target_ref IS NULL OR char_length(target_ref) BETWEEN 1 AND 200),
    state text NOT NULL CHECK (state IN ('pending', 'applied', 'failed')),
    request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    created_at timestamptz NOT NULL,
    settled_at timestamptz,
    PRIMARY KEY (store_id, action_id),
    UNIQUE (store_id, actor_id, command_key),
    CHECK ((state = 'pending') = (settled_at IS NULL)),
    CHECK ((state = 'applied') = (result IS NOT NULL)),
    CHECK ((state = 'failed') = (error_code IS NOT NULL))
);
CREATE INDEX naver_coupon_action_recent ON marketing.naver_coupon_action (store_id, created_at DESC);

DO $migration$
DECLARE scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY[
        'coupon', 'coupon_code', 'coupon_message', 'coupon_target', 'coupon_reminder', 'coupon_redemption',
        'coupon_command', 'coupon_revision', 'naver_coupon_action'
    ] LOOP
        EXECUTE format('ALTER TABLE marketing.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE marketing.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('CREATE POLICY coupon_store_scope ON marketing.%I TO marketing_mig, marketing_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
    END LOOP;
END
$migration$;

GRANT SELECT, INSERT ON marketing.coupon, marketing.coupon_code, marketing.coupon_message, marketing.coupon_target,
    marketing.coupon_reminder, marketing.coupon_redemption, marketing.coupon_command, marketing.coupon_revision,
    marketing.naver_coupon_action TO marketing_run;
GRANT UPDATE (name, benefit_value, ends_on, status, future_issue_count, revision) ON marketing.coupon TO marketing_run;
GRANT UPDATE (issue_count, activated_at, unpublished_at, issued_terms, revision) ON marketing.coupon_code TO marketing_run;
GRANT UPDATE (status) ON marketing.coupon_message TO marketing_run;
GRANT UPDATE (state, settlement_id, order_id, committed_at, release_reason, released_at, correction_id, reversed_at, revision)
    ON marketing.coupon_redemption TO marketing_run;
GRANT UPDATE (inverse, undo_until, undone_at) ON marketing.coupon_command TO marketing_run;
GRANT UPDATE (revision) ON marketing.coupon_revision TO marketing_run;
GRANT UPDATE (state, result, error_code, settled_at) ON marketing.naver_coupon_action TO marketing_run;
GRANT DELETE ON marketing.coupon_code, marketing.coupon TO marketing_run;

-- Down Migration
-- Roll back the application image while retaining coupon records once any exist.
ALTER TABLE marketing.coupon NO FORCE ROW LEVEL SECURITY;
ALTER TABLE marketing.naver_coupon_action NO FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
    IF EXISTS (SELECT FROM marketing.coupon) OR EXISTS (SELECT FROM marketing.naver_coupon_action) THEN
        RAISE EXCEPTION 'Coupon records exist; roll back the application and retain the migration';
    END IF;
END
$migration$;
DROP TABLE marketing.naver_coupon_action, marketing.coupon_revision, marketing.coupon_command,
    marketing.coupon_redemption, marketing.coupon_reminder, marketing.coupon_target, marketing.coupon_message,
    marketing.coupon_code, marketing.coupon;
