-- Up Migration
ALTER TABLE customer.outbox ADD CONSTRAINT outbox_contact_name_initial CHECK (
    event_type NOT IN ('customer.member_changed.v1', 'customer.contact_state_changed.v1')
    OR NOT (payload ? 'nameInitial')
    OR (
        jsonb_typeof(payload->'nameInitial') = 'string'
        AND char_length(payload->>'nameInitial') = 1
        AND payload @> '{"active":true,"contactAllowed":true,"marketingAllowed":true}'::jsonb
    ) IS TRUE
);

-- Down Migration
ALTER TABLE customer.outbox DROP CONSTRAINT outbox_contact_name_initial;
