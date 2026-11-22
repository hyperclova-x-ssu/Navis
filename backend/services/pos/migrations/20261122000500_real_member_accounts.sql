-- Up Migration
ALTER TABLE pos.settlement ALTER COLUMN bill_id DROP NOT NULL;
ALTER TABLE pos.settlement DROP CONSTRAINT settlement_purpose_check;
ALTER TABLE pos.settlement ADD CONSTRAINT settlement_purpose_check
    CHECK (purpose IN ('sale','charge_topup','receivable_collection','membership_sale','custom_order'));
ALTER TABLE pos.settlement ADD CONSTRAINT settlement_sale_bill CHECK ((purpose='sale') = (bill_id IS NOT NULL));
ALTER TABLE pos.settlement DROP CONSTRAINT settlement_amount_check;
ALTER TABLE pos.settlement ADD CONSTRAINT settlement_amount_check CHECK (
    amount BETWEEN 0 AND 9007199254740991 AND (amount>0 OR purpose='sale'));
ALTER TABLE pos.outbox DROP CONSTRAINT outbox_event_type_check;
ALTER TABLE pos.outbox ADD CONSTRAINT outbox_event_type_check CHECK (event_type LIKE 'pos.%.v1');

CREATE TABLE pos.member_account (
    store_id uuid NOT NULL REFERENCES pos.store,
    member_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    PRIMARY KEY (store_id, member_id)
);
CREATE TABLE pos.member_funding (
    store_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    member_id uuid NOT NULL,
    business_date date NOT NULL,
    membership_id uuid,
    product_id uuid,
    expires_on date,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    PRIMARY KEY (store_id, settlement_id),
    UNIQUE (store_id, membership_id),
    FOREIGN KEY (store_id, settlement_id) REFERENCES pos.settlement,
    FOREIGN KEY (store_id, member_id) REFERENCES pos.member_account,
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day,
    CHECK (num_nonnulls(membership_id, product_id, expires_on) IN (0,3))
);
CREATE INDEX member_funding_member ON pos.member_funding (store_id, member_id);
CREATE INDEX member_funding_day ON pos.member_funding (store_id, business_date, settlement_id);

CREATE TABLE pos.member_sale (
    store_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    member_id uuid NOT NULL,
    cash_amount bigint NOT NULL CHECK (cash_amount BETWEEN 0 AND 9007199254740991),
    contains_member_value boolean NOT NULL,
    PRIMARY KEY (store_id, settlement_id),
    FOREIGN KEY (store_id, settlement_id) REFERENCES pos.settlement,
    FOREIGN KEY (store_id, member_id) REFERENCES pos.member_account
);
CREATE INDEX member_sale_member ON pos.member_sale (store_id, member_id);

CREATE TABLE pos.member_account_entry (
    store_id uuid NOT NULL,
    txn_id uuid NOT NULL,
    member_id uuid NOT NULL,
    settlement_id uuid NOT NULL,
    account text NOT NULL CHECK (account IN ('charge','receivable')),
    kind text NOT NULL CHECK (kind IN ('topup','use','sale','collection','reversal')),
    amount bigint NOT NULL CHECK (amount <> 0 AND abs(amount) <= 9007199254740991),
    business_date date NOT NULL,
    at timestamptz NOT NULL,
    original_txn_id uuid,
    correction_id uuid,
    PRIMARY KEY (store_id, txn_id),
    UNIQUE (store_id, member_id, account, txn_id),
    FOREIGN KEY (store_id, member_id) REFERENCES pos.member_account,
    FOREIGN KEY (store_id, settlement_id) REFERENCES pos.settlement,
    FOREIGN KEY (store_id, member_id, account, original_txn_id) REFERENCES pos.member_account_entry (store_id, member_id, account, txn_id),
    FOREIGN KEY (store_id, correction_id) REFERENCES pos.payment_correction,
    FOREIGN KEY (store_id, business_date) REFERENCES pos.business_day,
    CHECK ((kind IN ('topup','sale') AND amount>0) OR (kind IN ('use','collection') AND amount<0) OR kind='reversal')
);
CREATE INDEX member_entry_member ON pos.member_account_entry (store_id, member_id, at, txn_id);
CREATE INDEX member_entry_day ON pos.member_account_entry (store_id, business_date, txn_id);
CREATE INDEX member_entry_settlement ON pos.member_account_entry (store_id, settlement_id);
CREATE INDEX member_entry_correction ON pos.member_account_entry (store_id, correction_id);
CREATE INDEX member_entry_original ON pos.member_account_entry (store_id, original_txn_id);
CREATE TABLE pos.member_entry_source (
    store_id uuid NOT NULL,
    member_id uuid NOT NULL,
    account text NOT NULL,
    txn_id uuid NOT NULL,
    source_id uuid NOT NULL,
    consumed bigint NOT NULL CHECK (consumed <> 0 AND abs(consumed) <= 9007199254740991),
    PRIMARY KEY (store_id, txn_id, source_id),
    FOREIGN KEY (store_id, member_id, account, txn_id) REFERENCES pos.member_account_entry (store_id, member_id, account, txn_id),
    FOREIGN KEY (store_id, member_id, account, source_id) REFERENCES pos.member_account_entry (store_id, member_id, account, txn_id)
);
CREATE INDEX member_entry_source_ref ON pos.member_entry_source (store_id, source_id);

DO $migration$
DECLARE scoped_table text;
BEGIN
    FOREACH scoped_table IN ARRAY ARRAY['member_account','member_funding','member_sale','member_account_entry','member_entry_source'] LOOP
        EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('ALTER TABLE pos.%I FORCE ROW LEVEL SECURITY', scoped_table);
        EXECUTE format('CREATE POLICY store_scope ON pos.%I TO pos_mig, pos_run
            USING (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))
            WITH CHECK (store_id = (SELECT nullif(current_setting(''app.store_id'', true), '''')::uuid))', scoped_table);
        EXECUTE format('GRANT SELECT, INSERT ON pos.%I TO pos_run', scoped_table);
    END LOOP;
END
$migration$;
GRANT UPDATE (revision) ON pos.member_account, pos.member_funding TO pos_run;

-- Down Migration
DROP TABLE pos.member_entry_source, pos.member_account_entry, pos.member_sale, pos.member_funding, pos.member_account;
ALTER TABLE pos.settlement DROP CONSTRAINT settlement_sale_bill;
ALTER TABLE pos.settlement DROP CONSTRAINT settlement_purpose_check;
ALTER TABLE pos.settlement ADD CONSTRAINT settlement_purpose_check CHECK (purpose='sale');
ALTER TABLE pos.settlement DROP CONSTRAINT settlement_amount_check;
ALTER TABLE pos.settlement ADD CONSTRAINT settlement_amount_check CHECK (amount BETWEEN 1 AND 9007199254740991);
ALTER TABLE pos.settlement ALTER COLUMN bill_id SET NOT NULL;
ALTER TABLE pos.outbox DROP CONSTRAINT outbox_event_type_check;
ALTER TABLE pos.outbox ADD CONSTRAINT outbox_event_type_check CHECK (event_type IN
    ('pos.sale_recognized.v1','pos.sale_corrected.v1','pos.table_changed.v1','pos.table_session_changed.v1'));
