-- Up Migration
ALTER TABLE customer.pos_claim ADD COLUMN operating_day date;
ALTER TABLE customer.pos_claim ADD CONSTRAINT operating_claim_is_membership CHECK (operating_day IS NULL OR membership_id IS NOT NULL);
CREATE UNIQUE INDEX operating_membership_one_held ON customer.pos_claim (store_id, membership_id)
    WHERE operating_day IS NOT NULL AND state = 'held';
CREATE INDEX operating_membership_claim_day ON customer.pos_claim (store_id, membership_id, operating_day)
    WHERE operating_day IS NOT NULL;

-- Down Migration
DROP INDEX customer.operating_membership_claim_day, customer.operating_membership_one_held;
ALTER TABLE customer.pos_claim DROP COLUMN operating_day;
