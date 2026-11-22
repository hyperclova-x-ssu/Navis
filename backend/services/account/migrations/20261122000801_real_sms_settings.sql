-- Up Migration
ALTER TABLE account.store
    ADD COLUMN sms_sender_number text CHECK (sms_sender_number ~ '^[0-9]{8,11}$'),
    ADD COLUMN sms_opt_out_number text CHECK (sms_opt_out_number ~ '^080[0-9]{7,8}$');
GRANT UPDATE (sms_sender_number, sms_opt_out_number) ON account.store TO account_run;

-- Down Migration
ALTER TABLE account.store
    DROP COLUMN sms_sender_number,
    DROP COLUMN sms_opt_out_number;
