-- Up Migration
ALTER TABLE inventory.owner_publication ADD COLUMN running_until timestamptz, ADD COLUMN local_snapshot text;
GRANT UPDATE (running_until, local_snapshot) ON inventory.owner_publication TO inventory_run;

-- Down Migration
ALTER TABLE inventory.owner_publication DROP COLUMN running_until, DROP COLUMN local_snapshot;
