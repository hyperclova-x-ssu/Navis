-- Up Migration
ALTER TABLE pos.payment_correction
    ADD COLUMN custom_order_settlement_id uuid,
    ADD COLUMN custom_order_amount bigint,
    ADD CONSTRAINT custom_order_correction_settlement_fk
        FOREIGN KEY (store_id, custom_order_settlement_id) REFERENCES pos.settlement (store_id, settlement_id),
    ADD CONSTRAINT custom_order_correction_payment_fk
        FOREIGN KEY (store_id, custom_order_settlement_id, payment_id) REFERENCES pos.payment (store_id, settlement_id, payment_id);
ALTER TABLE pos.payment_correction DROP CONSTRAINT payment_correction_amount_check;
ALTER TABLE pos.payment_correction ADD CONSTRAINT payment_correction_amount_check CHECK (
    amount BETWEEN 0 AND 9007199254740991
    AND ((payment_id IS NULL AND amount = 0) OR (payment_id IS NOT NULL AND amount > 0))
    AND (
        (custom_order_settlement_id IS NULL AND custom_order_amount IS NULL AND (
            (member_sale_settlement_id IS NULL AND member_sale_amount IS NULL AND payment_id IS NOT NULL)
            OR (member_sale_settlement_id IS NOT NULL AND member_sale_amount IS NOT NULL
                AND member_sale_amount BETWEEN amount AND 9007199254740991)
        ))
        OR (custom_order_settlement_id IS NOT NULL AND custom_order_amount IS NOT NULL
            AND member_sale_settlement_id IS NULL AND member_sale_amount IS NULL
            AND custom_order_amount BETWEEN greatest(amount, 1) AND 9007199254740991)
    )
);
CREATE INDEX custom_order_correction_settlement ON pos.payment_correction (store_id, custom_order_settlement_id);

-- Down Migration
ALTER TABLE pos.payment_correction ADD CONSTRAINT custom_order_correction_rollback_check CHECK (
    custom_order_settlement_id IS NULL AND custom_order_amount IS NULL
);
DROP INDEX pos.custom_order_correction_settlement;
ALTER TABLE pos.payment_correction
    DROP CONSTRAINT custom_order_correction_payment_fk,
    DROP CONSTRAINT custom_order_correction_settlement_fk,
    DROP CONSTRAINT payment_correction_amount_check,
    DROP CONSTRAINT custom_order_correction_rollback_check,
    DROP COLUMN custom_order_amount,
    DROP COLUMN custom_order_settlement_id;
ALTER TABLE pos.payment_correction ADD CONSTRAINT payment_correction_amount_check CHECK (
    amount BETWEEN 0 AND 9007199254740991
    AND ((payment_id IS NULL AND amount = 0) OR (payment_id IS NOT NULL AND amount > 0))
    AND ((member_sale_settlement_id IS NULL AND member_sale_amount IS NULL AND payment_id IS NOT NULL)
        OR (member_sale_settlement_id IS NOT NULL AND member_sale_amount IS NOT NULL
            AND member_sale_amount BETWEEN amount AND 9007199254740991))
);
