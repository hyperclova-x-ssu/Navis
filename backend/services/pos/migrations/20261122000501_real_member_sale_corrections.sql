-- Up Migration
ALTER TABLE pos.member_sale ADD COLUMN has_pass boolean NOT NULL DEFAULT false;
ALTER TABLE pos.payment_correction ALTER COLUMN payment_id DROP NOT NULL;
ALTER TABLE pos.payment_correction DROP CONSTRAINT payment_correction_amount_check;
ALTER TABLE pos.payment_correction ADD COLUMN member_sale_settlement_id uuid;
ALTER TABLE pos.payment_correction ADD COLUMN member_sale_amount bigint;
ALTER TABLE pos.payment_correction ADD CONSTRAINT member_sale_correction_fk
    FOREIGN KEY (store_id, member_sale_settlement_id) REFERENCES pos.member_sale;
ALTER TABLE pos.payment ADD CONSTRAINT payment_settlement_identity UNIQUE (store_id, settlement_id, payment_id);
ALTER TABLE pos.payment_correction ADD CONSTRAINT member_sale_correction_payment_fk
    FOREIGN KEY (store_id, member_sale_settlement_id, payment_id) REFERENCES pos.payment (store_id, settlement_id, payment_id);
ALTER TABLE pos.payment_correction ADD CONSTRAINT payment_correction_amount_check CHECK (
    amount BETWEEN 0 AND 9007199254740991
    AND ((payment_id IS NULL AND amount=0) OR (payment_id IS NOT NULL AND amount>0))
    AND ((member_sale_settlement_id IS NULL AND member_sale_amount IS NULL AND payment_id IS NOT NULL) OR
        (member_sale_settlement_id IS NOT NULL AND member_sale_amount IS NOT NULL AND member_sale_amount BETWEEN amount AND 9007199254740991))
);
CREATE UNIQUE INDEX member_sale_one_correction ON pos.payment_correction (store_id, member_sale_settlement_id)
    WHERE member_sale_settlement_id IS NOT NULL;

-- Down Migration
ALTER TABLE pos.member_sale DROP COLUMN has_pass;
DROP INDEX pos.member_sale_one_correction;
ALTER TABLE pos.payment_correction DROP CONSTRAINT member_sale_correction_payment_fk;
ALTER TABLE pos.payment DROP CONSTRAINT payment_settlement_identity;
ALTER TABLE pos.payment_correction DROP CONSTRAINT payment_correction_amount_check;
ALTER TABLE pos.payment_correction DROP COLUMN member_sale_amount, DROP COLUMN member_sale_settlement_id;
ALTER TABLE pos.payment_correction ADD CONSTRAINT payment_correction_amount_check CHECK (amount BETWEEN 1 AND 9007199254740991);
ALTER TABLE pos.payment_correction ALTER COLUMN payment_id SET NOT NULL;
