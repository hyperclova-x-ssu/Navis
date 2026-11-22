-- Up Migration
CREATE TABLE pos.custom_pickup_recognition (
    store_id uuid NOT NULL,
    custom_order_id uuid NOT NULL,
    recognition_id uuid NOT NULL,
    settlement_id uuid,
    business_date date NOT NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 9007199254740991),
    at timestamptz NOT NULL,
    PRIMARY KEY (store_id, custom_order_id),
    UNIQUE (store_id, recognition_id),
    FOREIGN KEY (store_id, settlement_id) REFERENCES pos.settlement,
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day
);
CREATE INDEX custom_pickup_recognition_day ON pos.custom_pickup_recognition (store_id, business_date);
CREATE INDEX custom_pickup_recognition_settlement ON pos.custom_pickup_recognition (store_id, settlement_id);
ALTER TABLE pos.custom_pickup_recognition ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos.custom_pickup_recognition FORCE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON pos.custom_pickup_recognition TO pos_mig, pos_run
    USING (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid))
    WITH CHECK (store_id = (SELECT nullif(current_setting('app.store_id', true), '')::uuid));
GRANT SELECT, INSERT ON pos.custom_pickup_recognition TO pos_run;

-- Down Migration
DROP TABLE pos.custom_pickup_recognition;
