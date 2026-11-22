import { randomUUID } from 'node:crypto';
import { openDay } from '../../ledger.ts';
import { integer, PosError, uuid, type PosTx } from '../../wire.ts';
import { date, text } from './input.ts';

/** Call in the POS pickup command transaction, alongside the pickup and its outbox record. */
export async function recognizeCustomPickup(tx: PosTx, source: {
  customOrderId: string; businessDate: string; name: string; amount: number; settlementId?: string;
}) {
  const orderId = uuid(source.customOrderId);
  const day = date(source.businessDate);
  const name = text(source.name, 120);
  if (!name) throw new PosError(400, 'INVALID_TEXT');
  const amount = integer(source.amount, 1);
  const settlementId = source.settlementId === undefined ? null : uuid(source.settlementId);
  const bind = [tx.storeId, orderId, day, name, amount, settlementId];
  if (day !== await openDay(tx)) throw new PosError(409, 'DAY_CLOSED');
  if (settlementId) {
    const { rowCount } = await tx.db.query(`
      SELECT 1 FROM pos.settlement WHERE store_id = $1 AND settlement_id = $2 AND purpose = 'custom_order'
    `, [tx.storeId, settlementId]);
    if (!rowCount) throw new PosError(404, 'CUSTOM_SETTLEMENT_NOT_FOUND');
  }
  const { rows: [created] } = await tx.db.query<{ id: string }>(`
    INSERT INTO pos.custom_pickup_recognition (store_id, custom_order_id, business_date, name, amount, settlement_id, recognition_id, at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (store_id, custom_order_id) DO NOTHING RETURNING recognition_id AS id
  `, [...bind, randomUUID(), tx.at]);
  if (created) return created.id;
  const { rows: [previous] } = await tx.db.query<{ id: string }>(`
    SELECT recognition_id AS id FROM pos.custom_pickup_recognition
    WHERE store_id = $1 AND custom_order_id = $2 AND business_date = $3 AND name = $4 AND amount = $5
      AND settlement_id IS NOT DISTINCT FROM $6::uuid
  `, bind);
  if (!previous) throw new PosError(409, 'CUSTOM_PICKUP_ALREADY_RECOGNIZED');
  return previous.id;
}
