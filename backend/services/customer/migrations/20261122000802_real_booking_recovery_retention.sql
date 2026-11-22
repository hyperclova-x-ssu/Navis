-- Up Migration
ALTER TABLE customer.booking_command DROP CONSTRAINT booking_command_outcome,
    ADD COLUMN provider_expires_at timestamptz,
    ADD COLUMN provider_expired_at timestamptz;
ALTER TABLE customer.reservation NO FORCE ROW LEVEL SECURITY;
ALTER TABLE customer.booking_command NO FORCE ROW LEVEL SECURITY;

UPDATE customer.booking_command SET provider_expires_at = clock_timestamp()
WHERE receipt IS NULL;
ALTER TABLE customer.booking_command ALTER COLUMN provider_expires_at SET DEFAULT (now() + interval '5 minutes');
ALTER TABLE customer.booking_command ADD CONSTRAINT booking_pending_expiry
CHECK (receipt IS NOT NULL OR (provider_ref IS NOT NULL AND provider_expires_at IS NOT NULL)
    OR (provider_ref IS NULL AND provider_expired_at IS NOT NULL));
GRANT UPDATE (provider_expired_at) ON customer.booking_command TO customer_run;

UPDATE customer.reservation SET guest_phone = NULL
WHERE guest_phone IS NOT NULL AND (first_order_id IS NOT NULL OR status IN ('canceled', 'completed', 'no-show'));

UPDATE customer.booking_command c SET inverse = jsonb_set(c.inverse, '{before,guestPhone}', 'null')
FROM customer.reservation r
WHERE c.store_id = r.store_id AND c.inverse #>> '{before,reservationId}' = r.reservation_id::text
  AND c.inverse #>> '{before,guestPhone}' IS NOT NULL
  AND (r.first_order_id IS NOT NULL OR r.status IN ('canceled', 'completed', 'no-show'));

ALTER TABLE customer.booking_command FORCE ROW LEVEL SECURITY;
ALTER TABLE customer.reservation FORCE ROW LEVEL SECURITY;

-- Down Migration
-- Removed phone numbers are intentionally unrecoverable.
ALTER TABLE customer.booking_command NO FORCE ROW LEVEL SECURITY;
DELETE FROM customer.booking_command WHERE provider_expired_at IS NOT NULL;
ALTER TABLE customer.booking_command DROP COLUMN provider_expires_at, DROP COLUMN provider_expired_at,
    ADD CONSTRAINT booking_command_outcome CHECK (receipt IS NOT NULL OR provider_ref IS NOT NULL);
ALTER TABLE customer.booking_command FORCE ROW LEVEL SECURITY;
