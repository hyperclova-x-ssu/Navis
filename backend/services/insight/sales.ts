import type { Pool, PoolClient } from 'pg';
import { PermanentStreamError, StreamConsumer, type RedisStreams, type StreamEnvelope } from '../../packages/streams/index.ts';
import { fingerprint, InsightError, inStore, isDate, isUuid } from './scope.ts';

const saleType = 'pos.sale_recognized.v1';
const correctionType = 'pos.sale_corrected.v1';
const localSaleHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23' });
const badEvent = (code = 'INVALID_POS_SALE') => new PermanentStreamError(code);
type Line = { allocationId: string; menuId: string; quantity: number };
type Sale = { storeId: string; settlementId: string; businessDate: string; lines: Line[] };

function parseSale(event: StreamEnvelope): Sale {
  const { storeId, payload: { settlementId, businessDate, lines } } = event;
  if (!isUuid(storeId) || storeId !== event.scopeKey || !isUuid(settlementId) || !isDate(businessDate)
      || !Array.isArray(lines) || !lines.length) throw badEvent();
  const parsed = lines.map((line: unknown): Line => {
    if (!line || typeof line !== 'object') throw badEvent();
    const { allocationId, menuId, quantity } = line as Partial<Line>;
    if (!isUuid(allocationId) || !isUuid(menuId) || typeof quantity !== 'number'
        || !Number.isSafeInteger(quantity) || quantity < 0) throw badEvent();
    return { allocationId, menuId, quantity };
  });
  if (new Set(parsed.map(line => line.allocationId)).size !== parsed.length) throw badEvent();
  return { storeId, settlementId, businessDate, lines: parsed.sort((a, b) => a.allocationId.localeCompare(b.allocationId)) };
}

async function recognize(db: PoolClient, event: StreamEnvelope) {
  const { storeId, settlementId, businessDate, lines } = parseSale(event);
  const { amount } = event.payload;
  if (event.aggregateId !== settlementId || typeof amount !== 'number' || !Number.isSafeInteger(amount)
      || amount < 0 || lines.some(line => line.quantity < 1)) throw badEvent();
  const saleHour = Number(localSaleHour.format(new Date(event.occurredAt)));
  const key = fingerprint({ businessDate, saleHour, amount, lines });
  const result = await db.query(`
    INSERT INTO insight.sales_recognition (store_id, settlement_id, business_date, sale_hour, amount, fingerprint)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [storeId, settlementId, businessDate, saleHour, amount, key]);
  if (!result.rowCount) {
    const { rows: [prior] } = await db.query<{ fingerprint: string }>(
      'SELECT fingerprint FROM insight.sales_recognition WHERE store_id=$1 AND settlement_id=$2', [storeId, settlementId]);
    if (prior?.fingerprint !== key) throw badEvent('SALE_REPLAY_CONFLICT');
    return;
  }
  await db.query(`
    INSERT INTO insight.sales_line (store_id, settlement_id, allocation_id, menu_id, quantity)
    SELECT $1, $2, line."allocationId", line."menuId", line.quantity
    FROM jsonb_to_recordset($3::jsonb) AS line("allocationId" uuid, "menuId" uuid, quantity bigint)`,
  [storeId, settlementId, JSON.stringify(lines)]);
}

async function correct(db: PoolClient, event: StreamEnvelope) {
  const { storeId, settlementId, businessDate, lines } = parseSale(event);
  const { correctionId, kind, target, usageEffect, amountDelta } = event.payload;
  const cancel = kind === 'cancel' && usageEffect === 'restore';
  if (!isUuid(correctionId) || event.aggregateId !== correctionId || target !== 'recognized_sale'
      || (!cancel && !(kind === 'refund' && usageEffect === 'keep'))
      || typeof amountDelta !== 'number' || !Number.isSafeInteger(amountDelta) || amountDelta >= 0
      || lines.some(line => cancel ? line.quantity === 0 : line.quantity !== 0)) throw badEvent();
  const key = fingerprint({ settlementId, businessDate, kind, amountDelta, lines });
  const { rows: [prior] } = await db.query<{ fingerprint: string }>(
    'SELECT fingerprint FROM insight.sales_correction WHERE store_id=$1 AND correction_id=$2', [storeId, correctionId]);
  if (prior) {
    if (prior.fingerprint !== key) throw badEvent('SALE_REPLAY_CONFLICT');
    return;
  }
  const { rows: [original] } = await db.query<{ business_date: string; remaining: string }>(`
    SELECT s.business_date::text, (s.amount + coalesce(sum(c.amount_delta), 0))::text AS remaining
    FROM insight.sales_recognition s
    LEFT JOIN insight.sales_correction c USING (store_id, settlement_id)
    WHERE s.store_id=$1 AND s.settlement_id=$2
    GROUP BY s.store_id, s.settlement_id`, [storeId, settlementId]);
  if (!original) throw badEvent('ORIGINAL_SALE_MISSING');
  if (original.business_date !== businessDate || BigInt(original.remaining) + BigInt(amountDelta) < 0n) {
    throw badEvent('INVALID_SALE_CORRECTION');
  }
  const input = JSON.stringify(lines);
  const invalidAllocations = await db.query(`
    SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS changes("allocationId" uuid, "menuId" uuid, quantity bigint)
    LEFT JOIN insight.sales_line sl
      ON sl.store_id=$1 AND sl.settlement_id=$2 AND sl.allocation_id=changes."allocationId" AND sl.menu_id=changes."menuId"
    WHERE sl.allocation_id IS NULL OR changes.quantity > sl.quantity - coalesce((
      SELECT sum(quantity) FROM insight.sales_restoration sr
      WHERE (sr.store_id, sr.settlement_id, sr.allocation_id) = (sl.store_id, sl.settlement_id, sl.allocation_id)
    ), 0)
    LIMIT 1`, [storeId, settlementId, input]);
  if (invalidAllocations.rowCount) throw badEvent('INVALID_SALE_CORRECTION');
  await db.query(`
    INSERT INTO insight.sales_correction (store_id, correction_id, settlement_id, amount_delta, fingerprint)
    VALUES ($1, $2, $3, $4, $5)`, [storeId, correctionId, settlementId, amountDelta, key]);
  if (cancel) await db.query(`
    INSERT INTO insight.sales_restoration (store_id, settlement_id, correction_id, allocation_id, quantity)
    SELECT $1, $2, $3, line."allocationId", line.quantity
    FROM jsonb_to_recordset($4::jsonb) AS line("allocationId" uuid, quantity bigint)`,
  [storeId, settlementId, correctionId, input]);
}

export function createInsightSalesConsumer(
  database: Pool, redis: RedisStreams, name: string,
  hooks: { reclaimIdleMs?: number; afterCommit?: (event: StreamEnvelope) => Promise<void> } = {},
) {
  return new StreamConsumer({
    database, redis, service: 'insight', producer: 'pos', group: 'insight', name,
    handlers: { [saleType]: recognize, [correctionType]: correct }, ...hooks,
  });
}

function exactNumber(value: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Sales projection exceeds the safe integer range');
  return result;
}

export function readSales(pool: Pool, storeId: string, from: string, to: string) {
  if (!isDate(from) || !isDate(to) || to < from || Date.parse(to) - Date.parse(from) >= 28 * 86_400_000) {
    throw new InsightError(400, 'INVALID_REQUEST');
  }
  return inStore(pool, storeId, async db => {
    const { rows: hourRows } = await db.query<{ businessDate: string; saleHour: number; netSales: string }>(`
      SELECT s.business_date::text AS "businessDate", s.sale_hour AS "saleHour",
        sum(s.amount + coalesce((SELECT sum(c.amount_delta) FROM insight.sales_correction c
          WHERE (c.store_id, c.settlement_id) = (s.store_id, s.settlement_id)), 0))::text AS "netSales"
      FROM insight.sales_recognition s
      WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 GROUP BY s.business_date, s.sale_hour
      ORDER BY s.business_date, s.sale_hour`, [storeId, from, to]);
    const { rows: menuRows } = await db.query<{ businessDate: string; menuId: string; quantity: string }>(`
      SELECT s.business_date::text AS "businessDate", sl.menu_id AS "menuId",
        sum(sl.quantity - coalesce((SELECT sum(sr.quantity) FROM insight.sales_restoration sr
          WHERE (sr.store_id, sr.settlement_id, sr.allocation_id) = (sl.store_id, sl.settlement_id, sl.allocation_id)), 0))::text AS quantity
      FROM insight.sales_recognition s JOIN insight.sales_line sl USING (store_id, settlement_id)
      WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 GROUP BY s.business_date, sl.menu_id
      ORDER BY s.business_date, sl.menu_id`, [storeId, from, to]);
    const days = new Map<string, { businessDate: string; netSales: number; menu: { menuId: string; quantity: number }[] }>();
    const hours = hourRows.map(({ businessDate, saleHour, netSales }) => {
      const day = days.get(businessDate) ?? { businessDate, netSales: 0, menu: [] };
      const amount = exactNumber(netSales);
      day.netSales = exactNumber(String(BigInt(day.netSales) + BigInt(amount)));
      days.set(businessDate, day);
      return { businessDate, saleHour, netSales: amount };
    });
    for (const { businessDate, menuId, quantity } of menuRows) {
      days.get(businessDate)!.menu.push({ menuId, quantity: exactNumber(quantity) });
    }
    return { days: [...days.values()], hours };
  }, true);
}
