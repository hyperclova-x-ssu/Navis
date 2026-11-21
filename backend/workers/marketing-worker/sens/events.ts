import { PermanentStreamError, type StreamHandler } from '../../../packages/streams/consumer.ts';

export { messageQueued } from '../../../services/marketing/sens/ledger.ts';

export const dispatchTestSms: StreamHandler = async (db, event) => {
  if (!event.storeId || event.payload.receiptId !== event.aggregateId || Object.keys(event.payload).length !== 1) {
    throw new PermanentStreamError('INVALID_TEST_SMS_EVENT');
  }
  const result = await db.query(`
    UPDATE marketing.sens_attempt SET dispatched_at = coalesce(dispatched_at, clock_timestamp())
    WHERE store_id = $1 AND receipt_id = $2`, [event.storeId, event.aggregateId]);
  if (!result.rowCount) throw new PermanentStreamError('TEST_SMS_ATTEMPT_NOT_FOUND');
};
