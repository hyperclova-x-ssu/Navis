-- Up Migration
ALTER TABLE pos.member_account_entry ALTER COLUMN settlement_id DROP NOT NULL;
ALTER TABLE pos.member_account_entry DROP CONSTRAINT member_account_entry_kind_check;
ALTER TABLE pos.member_account_entry ADD CONSTRAINT member_account_entry_kind_check
    CHECK (kind IN ('opening', 'topup', 'use', 'sale', 'collection', 'reversal'));
ALTER TABLE pos.member_account_entry DROP CONSTRAINT member_account_entry_check;
ALTER TABLE pos.member_account_entry ADD CONSTRAINT member_account_entry_check
    CHECK ((kind IN ('opening', 'topup', 'sale') AND amount > 0)
        OR (kind IN ('use', 'collection') AND amount < 0) OR kind = 'reversal');
ALTER TABLE pos.member_account_entry ADD CONSTRAINT member_account_entry_settlement_required
    CHECK ((kind = 'opening' AND settlement_id IS NULL AND original_txn_id IS NULL AND correction_id IS NULL)
        OR (kind <> 'opening' AND settlement_id IS NOT NULL));

-- Down Migration
-- SET NOT NULL rejects rollback if any opening balance has been recorded.
ALTER TABLE pos.member_account_entry ALTER COLUMN settlement_id SET NOT NULL;
ALTER TABLE pos.member_account_entry DROP CONSTRAINT member_account_entry_settlement_required;
ALTER TABLE pos.member_account_entry DROP CONSTRAINT member_account_entry_check;
ALTER TABLE pos.member_account_entry ADD CONSTRAINT member_account_entry_check
    CHECK ((kind IN ('topup', 'sale') AND amount > 0)
        OR (kind IN ('use', 'collection') AND amount < 0) OR kind = 'reversal');
ALTER TABLE pos.member_account_entry DROP CONSTRAINT member_account_entry_kind_check;
ALTER TABLE pos.member_account_entry ADD CONSTRAINT member_account_entry_kind_check
    CHECK (kind IN ('topup', 'use', 'sale', 'collection', 'reversal'));
