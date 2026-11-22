-- Up Migration
-- Enumerate store IDs as the migrator, then use ordinary per-store policies for all other tables.
CREATE POLICY pickup_backfill_stores ON pos.store FOR SELECT TO pos_mig USING (true);

DO $backfill$
DECLARE
    scoped_store uuid;
BEGIN
    FOR scoped_store IN SELECT store_id FROM pos.store ORDER BY store_id LOOP
        PERFORM set_config('app.store_id', scoped_store::text, true);

        WITH snapshots AS (
            SELECT o.custom_order_id, o.revision, o.stage, o.production_at,
                p.reservation_id, p.scheduled_at, p.status, p.updated_at,
                md5('pos:pickup-projection-backfill:v1:' || o.store_id || ':' || o.custom_order_id)::uuid AS event_id
            FROM pos.custom_order o
            JOIN pos.custom_pickup p USING (store_id, custom_order_id)
            WHERE o.store_id = scoped_store
        ), missing AS (
            SELECT s.*, row_number() OVER (ORDER BY s.custom_order_id) AS offset_in_store
            FROM snapshots s
            WHERE NOT EXISTS (SELECT 1 FROM pos.outbox e WHERE e.event_id = s.event_id)
        ), sequence_range AS (
            INSERT INTO pos.outbox_scope (store_id, last_seq)
                SELECT scoped_store, count(*) FROM missing HAVING count(*) > 0
            ON CONFLICT (store_id) DO UPDATE SET last_seq = pos.outbox_scope.last_seq + EXCLUDED.last_seq
            RETURNING last_seq
        )
        INSERT INTO pos.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
        SELECT event_id, scoped_store, scoped_store::text,
            last_seq - (SELECT count(*) FROM missing) + offset_in_store,
            'pos.custom_pickup_changed.v1', custom_order_id, statement_timestamp(),
            jsonb_build_object(
                'revision', revision, 'stage', stage,
                'pickupProjection', jsonb_build_object(
                    'kind', 'pickup', 'reservationId', reservation_id, 'customOrderId', custom_order_id,
                    'date', to_char(scheduled_at, 'YYYY-MM-DD'), 'time', to_char(scheduled_at, 'HH24:MI'),
                    'status', status, 'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ),
                'calendarProjection', jsonb_build_object(
                    'source', 'custom-pickup', 'sourceId', custom_order_id, 'revision', revision,
                    'entry', CASE WHEN status = 'confirmed' THEN jsonb_build_object(
                        'date', to_char(scheduled_at, 'YYYY-MM-DD'), 'time', to_char(scheduled_at, 'HH24:MI')
                    ) END
                ),
                'productionProjection', jsonb_build_object(
                    'source', 'custom-production', 'sourceId', custom_order_id, 'revision', revision,
                    'entry', CASE WHEN status = 'confirmed' AND production_at IS NOT NULL THEN jsonb_build_object(
                        'date', to_char(production_at, 'YYYY-MM-DD'), 'time', to_char(production_at, 'HH24:MI')
                    ) END
                )
            )
        FROM missing CROSS JOIN sequence_range;
    END LOOP;
    PERFORM set_config('app.store_id', '', true);
END
$backfill$;

DROP POLICY pickup_backfill_stores ON pos.store;

-- Down Migration
-- Preserve emitted events and producer sequence continuity.
SELECT 1;
