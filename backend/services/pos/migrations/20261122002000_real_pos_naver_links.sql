-- Up Migration
ALTER TABLE pos.payment
    ADD COLUMN source text CONSTRAINT payment_connect_source
        CHECK (source IS NULL OR (source = 'connect' AND channel = 'terminal_record'));

CREATE TABLE pos.naver_order_link (
    store_id uuid NOT NULL REFERENCES pos.store,
    order_ref text NOT NULL CHECK (order_ref ~ '^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,159}$'),
    payment_id uuid,
    naver_pay_payment_id text CHECK (naver_pay_payment_id ~ '^[A-Za-z0-9_~-][A-Za-z0-9_.~-]{0,49}$'),
    smartstore_product_order_id text CHECK (smartstore_product_order_id ~ '^[0-9]{1,32}$'),
    PRIMARY KEY (store_id, order_ref),
    UNIQUE (store_id, payment_id),
    FOREIGN KEY (store_id, payment_id) REFERENCES pos.payment,
    CHECK (num_nonnulls(naver_pay_payment_id, smartstore_product_order_id) > 0)
);
ALTER TABLE pos.naver_order_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.naver_order_link FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON pos.naver_order_link TO pos_mig, pos_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT ON pos.naver_order_link TO pos_run;

-- Down Migration
DO $migration$
BEGIN
    RAISE EXCEPTION 'This migration preserves provider links and Connect provenance. Roll back the application instead.';
END
$migration$;
