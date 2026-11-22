-- Up Migration
ALTER TABLE pos.customer_claim
    ADD COLUMN reservation_actor_id uuid,
    ADD COLUMN reservation_table_id uuid,
    ADD COLUMN reservation_expires_at timestamptz,
    ADD CONSTRAINT pos_claim_reservation_table_fk FOREIGN KEY (store_id, reservation_table_id) REFERENCES pos.store_table,
    ADD CONSTRAINT pos_claim_reservation_binding CHECK (
        (reservation_actor_id IS NULL AND reservation_table_id IS NULL AND reservation_expires_at IS NULL)
        OR (kind = 'reservation_first_order' AND reservation_actor_id IS NOT NULL AND reservation_expires_at IS NOT NULL)
    );
CREATE INDEX pos_claim_reservation_table ON pos.customer_claim (store_id, reservation_table_id) WHERE reservation_table_id IS NOT NULL;

-- Down Migration
ALTER TABLE pos.customer_claim NO FORCE ROW LEVEL SECURITY;
DO $migration$
BEGIN
    IF EXISTS (SELECT FROM pos.customer_claim WHERE reservation_actor_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Operating reservation claims exist; roll back the application while retaining the schema';
    END IF;
END
$migration$;
ALTER TABLE pos.customer_claim FORCE ROW LEVEL SECURITY;
ALTER TABLE pos.customer_claim DROP COLUMN reservation_actor_id, DROP COLUMN reservation_table_id, DROP COLUMN reservation_expires_at;
