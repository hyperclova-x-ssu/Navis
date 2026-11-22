import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { orderDetail } from '../02/reads.ts';
import { correctPayment, createReversalTokens, quoteReversal, receipt } from '../../reversals.ts';
import { insertBill, recognizeSale, setPreparation } from '../../sales.ts';
import { withStoreTransaction } from '../../transaction.ts';
import { quoteMemberCheckout, recordMemberCheckout } from './checkout.ts';

const pool = dbPool('pos', 'runtime', 'test');
const actorId = randomUUID();
const storeId = randomUUID();
const memberId = randomUUID();
const at = new Date('2026-11-17T06:45:00Z');
const work = (fn: Parameters<typeof withStoreTransaction>[2]) => withStoreTransaction(pool, storeId, fn, { write: true });
const tx = (db: Parameters<Parameters<typeof withStoreTransaction>[2]>[0]) => ({ db, storeId, actorId, at });
const customer = { async member() { return { memberId, active: true, product: null }; } };

beforeAll(async () => {
  await runMigrations('pos', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test');
  await work(async db => {
    await db.query('INSERT INTO pos.store VALUES ($1)', [storeId]);
    await db.query(`INSERT INTO pos.business_day (store_id,business_date,starts_at,ends_at)
      VALUES ($1, '2026-11-17', '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [storeId]);
  });
});

afterAll(() => pool.end());

it('records one terminal top-up without menu revenue and caps concurrent refunds', async () => {
  const { recordFunding, readFunding, refundFunding } = await import('./funding.ts');
  const input = { purpose: 'charge_topup', amount: 10000, expectedRevision: 0,
    splits: [{ method: 'card', amount: 7000 }, { method: 'cash', amount: 3000 }],
    terminal: { approvalNo: 'TOPUP-05', occurredAt: '2026-11-17T06:44:00Z' } };
  const key = randomUUID();
  const add = (db: Parameters<typeof tx>[0]) => recordFunding(tx(db), customer, key, memberId, input);
  const [receipt, duplicate] = await Promise.all([withStoreTransaction(pool, storeId, add, { write: true }), work(add)]);
  expect(duplicate).toEqual(receipt);
  const original = await work(db => readFunding(tx(db), receipt.paymentId));
  expect(original).toMatchObject({ paymentId: receipt.paymentId, settlementId: receipt.settlementId, remainingRefundable: 10000 });
  const refund = { amount: 7000, expectedRevision: 1, confirmed: true,
    terminal: { approvalNo: 'REFUND-05', occurredAt: '2026-11-17T06:45:00Z' } };
  const outcomes = await Promise.allSettled(Array.from({ length: 2 }, () => work(db =>
    refundFunding(tx(db), randomUUID(), receipt.settlementId, refund))));
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes).toContainEqual(expect.objectContaining({ reason: expect.objectContaining({ message: 'STALE_REVISION' }) }));
  expect(await work(db => readFunding(tx(db), receipt.settlementId))).toMatchObject({ remainingRefundable: 3000, revision: 2 });
  const { rows } = await withStoreTransaction(pool, storeId, db => db.query('SELECT order_id FROM pos.pos_order'));
  expect(rows).toEqual([]);
});

it('keeps the recorded walk-in cash order, receipt, and preparation contract', async () => {
  const walkInStore = randomUUID();
  const menuId = randomUUID();
  await withStoreTransaction(pool, walkInStore, async db => {
    const scope = { ...tx(db), storeId: walkInStore };
    await db.query('INSERT INTO pos.store VALUES ($1)', [walkInStore]);
    await db.query(`INSERT INTO pos.business_day (store_id,business_date,starts_at,ends_at)
      VALUES ($1, '2026-11-17', '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [walkInStore]);
    const { billId, quote } = await insertBill(scope, { type: 'takeout', discount: 0, lines: [{ menuId, qty: 1, optionIds: [] }] },
      async () => ({ items: [{ menuId, name: '라테', basePrice: 4500, baseCost: 1000, recipeVersion: 'a'.repeat(64),
        saleStatus: 'selling', groups: [] }] }));
    const splits = [{ method: 'cash' as const, amount: 4500 }];
    const { value: { paymentId, settlementId, orderIds: [orderId] } } = await recognizeSale(scope,
      { billId, businessDate: '2026-11-17', splits }, quote, { terminal: null });
    const order = await orderDetail(scope, orderId);
    expect(order).toMatchObject({ orderId, billId, paymentId, settlementId, amount: 4500, remaining: 4500, orderNo: 1,
      businessDate: '2026-11-17', preparation: 'accepted' });
    const paid = await receipt(scope, paymentId);
    expect(paid).toMatchObject({ paymentId, settlementId, billId, orderNos: [1], status: 'paid', channel: 'cash_record',
      amount: 4500, gross: 4500, discount: 0, remaining: 4500, splits, member: null, terminal: null, revision: 1 });
    expect(paid).not.toHaveProperty('memberId');
    expect(paid).not.toHaveProperty('realAmount');
    await setPreparation(scope, randomUUID(), orderId, 'preparing', order.revision);
    expect(await orderDetail(scope, orderId)).toMatchObject({ preparation: 'preparing', revision: 2, amount: 4500 });
  }, { write: true });
});

it('applies one pass use to one unit of a two-unit sale and returns only the cash on refund', async () => {
  const passStore = randomUUID();
  const menuId = randomUUID(), membershipId = randomUUID(), claimId = randomUUID(), productId = randomUUID();
  const client = {
    async member() {
      return { memberId, active: true, product: null, pass: {
        membershipId, memberId, startsOn: '2026-11-17', endsOn: '2026-12-17',
        status: 'active', usesLeft: 2, revision: 1, terms: {
          productId, name: '라테 횟수권', kind: 'count' as const, soldPrice: 8000,
          totalUses: 2, validDays: 30, dailyLimit: null, menuIds: [menuId], revision: 1,
        },
      } };
    },
    async reserve() { return { claimId, state: 'held', commandKey: 'claim' }; },
    async archive() { throw new Error('Unused'); },
  };
  const catalog = async () => ({ items: [{ menuId, name: '라테', basePrice: 4500, baseCost: 1000,
    recipeVersion: 'a'.repeat(64), saleStatus: 'selling' as const, groups: [] }] });
  await withStoreTransaction(pool, passStore, async db => {
    const scope = { ...tx(db), storeId: passStore };
    await db.query('INSERT INTO pos.store VALUES ($1)', [passStore]);
    await db.query(`INSERT INTO pos.business_day (store_id,business_date,starts_at,ends_at)
      VALUES ($1, '2026-11-17', '2026-11-16T20:00:00Z', '2026-11-17T20:00:00Z')`, [passStore]);
    const { billId, quote } = await insertBill(scope, { type: 'takeout', discount: 0, lines: [{ menuId, qty: 2, optionIds: [] }] }, catalog);
    const allocationId = quote.lines[0].allocationId;
    const selection = { memberId, allocations: [
      { kind: 'membership_count', membershipId, allocationId, quantity: 1 },
      { kind: 'method', method: 'cash', amount: 4500 },
    ] };
    const { quoteRevision, accountRevision } = await quoteMemberCheckout(scope, client, billId, selection, catalog);
    const key = randomUUID(), input = { ...selection, quoteRevision, accountRevision };
    const used = await recordMemberCheckout(scope, client, key, billId, input, catalog);
    expect(await recordMemberCheckout(scope, client, key, billId, input, catalog)).toEqual(used);
    expect(used.allocations[0]).toMatchObject({ quantity: 1, amount: 4000, membershipDiscount: 500 });
    const paid = await receipt(scope, used.settlementId);
    expect(paid).toMatchObject({ gross: 9000, discount: 500, realAmount: 4500, amount: 8500, splits: [{ method: 'cash', amount: 4500 }] });
    const placed = await orderDetail(scope, used.orderId);
    await setPreparation(scope, randomUUID(), used.orderId, 'preparing', placed.revision);
    const tokens = createReversalTokens(randomUUID());
    const reversal = await quoteReversal(scope, tokens, used.settlementId, { kind: 'refund' });
    expect(reversal).toMatchObject({ canSubmit: true, stockEffect: 'keep', membershipEffect: 'restore', methods: [{ method: 'cash', amount: 4500 }] });
    await correctPayment(scope, tokens, randomUUID(), reversal.quoteToken, { settlementId: used.settlementId, terminal: null });
    const { rows: events } = await db.query<{ event_type: string; payload: object }>(
      `SELECT event_type, payload FROM pos.outbox WHERE store_id=$1 AND event_type IN ('pos.sale_recognized.v1','pos.sale_corrected.v1') ORDER BY store_seq`, [passStore]);
    expect(events).toMatchObject([
      { event_type: 'pos.sale_recognized.v1', payload: { membershipContributions: [{ allocationId, quantity: 1 }] } },
      { event_type: 'pos.sale_corrected.v1', payload: { memberUseRestored: true, usageEffect: 'keep' } },
    ]);
    const { rows } = await db.query(`SELECT amount::int FROM pos.payment_correction WHERE store_id=$1`, [passStore]);
    expect(rows).toEqual([{ amount: 4500 }]);
  }, { write: true });
});
