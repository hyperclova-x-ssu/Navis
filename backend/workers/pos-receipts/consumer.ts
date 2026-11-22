import type { Pool, PoolClient } from 'pg';
import type { InventoryReceiptRecorded } from '../../packages/contracts/events.ts';
import { PermanentStreamError, StreamConsumer, type RedisStreams, type StreamEnvelope } from '../../packages/streams/index.ts';
import { recordReceiptExpenseCandidate, voidReceiptExpenseCandidate, type InventoryReceiptVoided } from '../../services/pos/expenses.ts';

const receiptType = 'inventory.receipt_recorded.v1';
const voidType = 'inventory.receipt_voided.v1';

async function applyReceipt(db: PoolClient, event: StreamEnvelope) {
  // The POS transaction handler validates this payload and deduplicates by business ID.
  try {
    await recordReceiptExpenseCandidate(db, event as unknown as InventoryReceiptRecorded);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Invalid inventory receipt envelope' || error.message === 'Invalid inventory receipt business date') {
        throw new PermanentStreamError('RECEIPT_EVENT_INVALID');
      }
      if (error.message === 'Receipt candidate payload changed') throw new PermanentStreamError('RECEIPT_EVENT_MISMATCH');
    }
    throw error;
  }
}

async function applyVoid(db: PoolClient, event: StreamEnvelope) {
  try {
    await voidReceiptExpenseCandidate(db, event as unknown as InventoryReceiptVoided);
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid inventory receipt envelope') {
      throw new PermanentStreamError('RECEIPT_EVENT_INVALID');
    }
    if (error instanceof Error && error.message === 'Receipt candidate cannot be voided') {
      throw new PermanentStreamError('RECEIPT_VOID_CONFLICT');
    }
    throw error;
  }
}

export function createPosReceiptConsumer(database: Pool, redis: RedisStreams, name: string) {
  return new StreamConsumer({
    database, service: 'pos', producer: 'inventory', group: 'pos', redis, name,
    handlers: { [receiptType]: applyReceipt, [voidType]: applyVoid },
  });
}
