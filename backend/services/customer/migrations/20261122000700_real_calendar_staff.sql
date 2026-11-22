-- Up Migration
CREATE TABLE customer.staff (
    store_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    archived_at timestamptz,
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, staff_id)
);

CREATE TABLE customer.staff_shift (
    store_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    staff_id uuid NOT NULL,
    shift_date date NOT NULL,
    kind text NOT NULL CHECK (kind IN ('work', 'off')),
    start_minute integer,
    end_minute integer,
    break_minutes integer NOT NULL CHECK (break_minutes >= 0),
    archived_at timestamptz,
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, schedule_id),
    FOREIGN KEY (store_id, staff_id) REFERENCES customer.staff (store_id, staff_id),
    CHECK ((kind = 'off' AND start_minute IS NULL AND end_minute IS NULL AND break_minutes = 0)
       OR (kind = 'work' AND start_minute IS NOT NULL AND end_minute IS NOT NULL
           AND start_minute >= 0 AND end_minute <= 1439 AND end_minute - start_minute > break_minutes))
);
CREATE INDEX staff_shift_person ON customer.staff_shift (store_id, staff_id, shift_date);
CREATE INDEX staff_shift_day ON customer.staff_shift (store_id, shift_date) WHERE archived_at IS NULL;

CREATE TABLE customer.staff_schedule_history (
    store_id uuid NOT NULL,
    change_id uuid NOT NULL,
    changed_at timestamptz NOT NULL,
    entity_id uuid NOT NULL,
    operation text NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
    before_row jsonb,
    after_row jsonb,
    PRIMARY KEY (store_id, change_id),
    CHECK ((before_row IS NULL) = (operation = 'create')),
    CHECK ((after_row IS NULL) = (operation = 'delete'))
);

CREATE TABLE customer.calendar_event (
    store_id uuid NOT NULL,
    event_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('event', 'todo')),
    category_id text NOT NULL CHECK (category_id IN ('store-operations', 'purchasing', 'tax-admin')),
    title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    title_key text NOT NULL,
    starts_on date NOT NULL,
    start_minute integer CHECK (start_minute BETWEEN 0 AND 1439),
    memo text CHECK (char_length(memo) <= 2000),
    closure_kind text CHECK (closure_kind IN ('regular', 'temporary')),
    closure_ends_on date,
    archived_at timestamptz,
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, event_id),
    CHECK (kind = 'event' OR start_minute IS NULL),
    CHECK ((closure_kind IS NULL) = (closure_ends_on IS NULL)),
    CHECK (closure_ends_on IS NULL OR (kind = 'event' AND category_id = 'store-operations' AND closure_ends_on >= starts_on))
);
CREATE INDEX calendar_event_day_title ON customer.calendar_event (store_id, starts_on, kind, title_key) WHERE archived_at IS NULL;

CREATE TABLE customer.calendar_preferences (
    store_id uuid PRIMARY KEY,
    source_visibility jsonb NOT NULL CHECK (jsonb_typeof(source_visibility) = 'object'),
    category_visibility jsonb NOT NULL CHECK (jsonb_typeof(category_visibility) = 'object'),
    revision integer NOT NULL CHECK (revision > 0)
);

CREATE TABLE customer.calendar_projection (
    store_id uuid NOT NULL,
    source text NOT NULL CHECK (source IN ('purchase-order', 'reservation', 'custom-pickup', 'community-offer', 'notice', 'tax-due', 'grant-deadline')),
    source_id uuid NOT NULL,
    source_revision integer NOT NULL CHECK (source_revision > 0),
    starts_on date,
    ends_on date,
    start_minute integer CHECK (start_minute BETWEEN 0 AND 1439),
    PRIMARY KEY (store_id, source, source_id),
    CHECK ((starts_on IS NULL) = (ends_on IS NULL)),
    CHECK (starts_on IS NOT NULL OR start_minute IS NULL),
    CHECK (ends_on >= starts_on)
);
CREATE INDEX calendar_projection_day ON customer.calendar_projection (store_id, starts_on, ends_on) WHERE starts_on IS NOT NULL;

CREATE TABLE customer.calendar_staff_revision (
    store_id uuid NOT NULL,
    source text NOT NULL CHECK (source IN ('staff', 'shifts', 'calendar', 'projections')),
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, source)
);

CREATE TABLE customer.calendar_staff_command (
    store_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    command_key text NOT NULL CHECK (char_length(command_key) BETWEEN 1 AND 160),
    command_hash text NOT NULL CHECK (char_length(command_hash) = 64),
    receipt_id uuid NOT NULL,
    recorded_at timestamptz NOT NULL,
    receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
    domain text NOT NULL CHECK (domain IN ('calendar', 'staff')),
    inverse jsonb CHECK (jsonb_typeof(inverse) = 'array'),
    undone_at timestamptz,
    PRIMARY KEY (store_id, actor_id, command_key),
    UNIQUE (store_id, receipt_id)
);

DO $migration$
DECLARE scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY[
        'staff', 'staff_shift', 'staff_schedule_history', 'calendar_event',
        'calendar_preferences', 'calendar_projection', 'calendar_staff_revision', 'calendar_staff_command'
    ] LOOP
        EXECUTE format('ALTER TABLE customer.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE customer.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('CREATE POLICY store_scope ON customer.%I TO customer_mig, customer_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
    END LOOP;
END
$migration$;

GRANT SELECT, INSERT ON customer.staff, customer.staff_shift, customer.staff_schedule_history, customer.calendar_event,
    customer.calendar_preferences, customer.calendar_projection, customer.calendar_staff_revision, customer.calendar_staff_command TO customer_run;
GRANT UPDATE (name, archived_at, revision) ON customer.staff TO customer_run;
GRANT UPDATE (staff_id, shift_date, kind, start_minute, end_minute, break_minutes, archived_at, revision) ON customer.staff_shift TO customer_run;
GRANT UPDATE (category_id, title, title_key, starts_on, start_minute, memo, closure_kind, closure_ends_on, archived_at, revision) ON customer.calendar_event TO customer_run;
GRANT UPDATE (source_visibility, category_visibility, revision) ON customer.calendar_preferences TO customer_run;
GRANT UPDATE (source_revision, starts_on, ends_on, start_minute) ON customer.calendar_projection TO customer_run;
GRANT UPDATE (revision) ON customer.calendar_staff_revision TO customer_run;
GRANT UPDATE (inverse, undone_at) ON customer.calendar_staff_command TO customer_run;

-- Down Migration
ALTER TABLE customer.calendar_staff_revision NO FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
    IF EXISTS (SELECT FROM customer.calendar_staff_revision) THEN
        RAISE EXCEPTION 'Calendar and staff records exist; roll back the application while retaining the schema';
    END IF;
END
$migration$;
DROP TABLE customer.calendar_staff_command, customer.calendar_staff_revision, customer.calendar_projection,
    customer.calendar_preferences, customer.calendar_event, customer.staff_schedule_history, customer.staff_shift, customer.staff;
