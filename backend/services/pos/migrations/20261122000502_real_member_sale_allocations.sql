-- Up Migration
ALTER TABLE pos.member_sale ADD COLUMN allocations jsonb CHECK (jsonb_typeof(allocations) = 'array');

-- Down Migration
ALTER TABLE pos.member_sale DROP COLUMN allocations;
