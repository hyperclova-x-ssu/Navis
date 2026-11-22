-- Up Migration
ALTER TABLE customer.calendar_projection DROP CONSTRAINT calendar_projection_source_check;
ALTER TABLE customer.calendar_projection ADD CONSTRAINT calendar_projection_source_check CHECK (
    source IN ('purchase-order', 'reservation', 'custom-pickup', 'custom-production', 'community-offer', 'notice', 'tax-due', 'grant-deadline')
);

-- Down Migration
ALTER TABLE customer.calendar_projection DROP CONSTRAINT calendar_projection_source_check;
ALTER TABLE customer.calendar_projection ADD CONSTRAINT calendar_projection_source_check CHECK (
    source IN ('purchase-order', 'reservation', 'custom-pickup', 'community-offer', 'notice', 'tax-due', 'grant-deadline')
);
