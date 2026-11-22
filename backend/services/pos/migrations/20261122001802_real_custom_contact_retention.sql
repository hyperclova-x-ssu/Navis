-- Up Migration
ALTER TABLE pos.custom_order NO FORCE ROW LEVEL SECURITY;
UPDATE pos.custom_order SET receipt = jsonb_set(receipt, '{guest,phone}', '""')
WHERE stage IN ('canceled', 'received_by_customer') AND coalesce(receipt #>> '{guest,phone}', '') <> '';
ALTER TABLE pos.custom_order FORCE ROW LEVEL SECURITY;

-- Down Migration
-- Removed phone numbers are intentionally unrecoverable.
SELECT 1;
