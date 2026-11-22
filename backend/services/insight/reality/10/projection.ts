import { PermanentStreamError, type StreamHandler } from '../../../../packages/streams/index.ts';
import { isUuid } from '../../scope.ts';
import { appendObservationEvent } from './commands.ts';

export const posTableChanged: StreamHandler = async (db, event) => {
  const { storeId, scopeKey, aggregateId, payload: { tableId, revision, state } } = event;
  if (!isUuid(storeId) || storeId !== scopeKey || !isUuid(tableId) || tableId !== aggregateId
      || typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1 || revision > 2_147_483_647
      || typeof state !== 'string' || !['empty', 'occupied', 'cleaning', 'archived'].includes(state)) {
    throw new PermanentStreamError('INVALID_POS_TABLE');
  }
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('insight.observations:' || $1, 0))", [storeId]);
  const result = await db.query(`
    INSERT INTO insight.pos_table_source (store_id, table_id, revision, archived) VALUES ($1,$2,$3,$4)
    ON CONFLICT (store_id, table_id) DO UPDATE SET revision=EXCLUDED.revision, archived=EXCLUDED.archived
    WHERE insight.pos_table_source.revision < EXCLUDED.revision`, [storeId, tableId, revision, state === 'archived']);
  if (state !== 'archived' || !result.rowCount) return;
  const { rows: [link] } = await db.query<{ zoneId: string; revision: number }>(`
    UPDATE insight.zone_table_link SET table_id=NULL, revision=revision+1 WHERE store_id=$1 AND table_id=$2
    RETURNING zone_id AS "zoneId", revision`, [storeId, tableId]);
  if (link) await appendObservationEvent(db, storeId, new Date(event.occurredAt), 'insight.zone_changed.v1', link.zoneId,
    { zoneId: link.zoneId, tableId: null, revision: link.revision });
};
