import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { createSeedContext } from '../../../../packages/db/seed-context.ts';
import { demoIdentity } from '../../../account/identity.ts';
import { withCustomerStore } from '../../../customer/claims.ts';
import { memberships } from '../../../customer/reality/05/passes.ts';
import { seed as seedCustomer } from '../../../customer/seed.ts';
import { registerManualsGrants } from '../../../insight/reality/11/routes.ts';
import { seed as seedInsight } from '../../../insight/seed.ts';
import { seed as seedInventory } from '../../../inventory/seed.ts';
import { withStoreTransaction as inventoryScope } from '../../../inventory/store-transaction.ts';
import { couponLedger } from '../../../marketing/coupon-ledger.ts';
import { registerLocalMarketingRoutes } from '../../../marketing/reality/13/routes.ts';
import { registerCouponRoutes } from '../../../marketing/reality/14/routes.ts';
import { registerNoticeReplyRoutes } from '../../../marketing/reality/15/routes.ts';
import { slotRegulars } from '../../../marketing/reality/19/groups.ts';
import { registerGroupsPerformanceRoutes } from '../../../marketing/reality/19/routes.ts';
import { seed as seedMarketing } from '../../../marketing/seed.ts';
import { inStore as marketingScope } from '../../../marketing/transaction.ts';
import { seed as seedPos } from '../../seed.ts';
import { withStoreTransaction } from '../../transaction.ts';
import { readCouponSales } from '../02/coupon-sales.ts';
import { balances, entries } from '../05/accounts.ts';
import { listMargins } from '../09/finance.ts';
import { listOrders } from './records.ts';

const services = ['pos', 'customer', 'insight', 'inventory', 'marketing'] as const;
const seeders = [seedPos, seedCustomer, seedInsight, seedInventory, seedMarketing] as const;
const migrators = services.map(service => dbPool(service, 'migrate', 'test'));
const [pos, customer, insight, inventory, marketing] = services.map(service => dbPool(service, 'runtime', 'test'));
const context = createSeedContext();
const { storeId, userId: actorId } = demoIdentity;
const at = new Date(context.cutoff);
const scope = { storeId, actorId, at, day: context.businessDate };
const token = 'rv2-in-process-test';
const app = Fastify();
const owner = { 'authorization': 'Bearer ' + token, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId,
  'x-navis-store-role': 'owner', 'x-navis-store-timezone': 'Asia/Seoul', 'x-navis-business-day-start': '05:00' };

beforeAll(async () => {
  for (const [index, service] of services.entries()) {
    await runMigrations(service, fileURLToPath(new URL(`../../../${service}/migrations/`, import.meta.url)), 'test');
    await seeders[index](migrators[index], context);
    await seeders[index](migrators[index], context);
  }
  registerLocalMarketingRoutes(app, marketing, { readToken: token, commandToken: token + '-command', now: () => at });
  const unexpectedSource = async () => { throw new Error('Seeded reads do not consult external sources'); };
  registerCouponRoutes(app, marketing, { gatewayToken: token, now: () => at,
    sources: { recipients: unexpectedSource, regulars: unexpectedSource, expiryLot: unexpectedSource, menuForItem: unexpectedSource } });
  registerNoticeReplyRoutes(app, marketing, { gatewayToken: token, now: () => at });
  registerGroupsPerformanceRoutes(app, marketing, { gatewayToken: token, now: () => at, coupons: couponLedger });
  registerManualsGrants(app, insight, { gatewayToken: token, now: () => at });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([...migrators, pos, customer, insight, inventory, marketing].map(pool => pool.end()));
});

async function get(service: string, path: string) {
  const response = await app.inject({ url: `/internal/v1/${service}/stores/${storeId}${path}`, headers: owner });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

it('reads two custom orders and the linked pickup in the customer projection after seed retry', async () => {
  const orders = await withStoreTransaction(pos, storeId, db => listOrders({ ...scope, db }, {}));
  expect(orders.items.map(row => row.stage).sort()).toEqual(['in_production', 'received']);
  const pickup = await withCustomerStore(customer, storeId, db => db.query('SELECT pickup FROM customer.booking_pickup'));
  expect(pickup.rows).toEqual([{ pickup: orders.items.find(row => row.stage === 'in_production')!.pickup }]);
});

it('reads opening balances and keeps historical member sales tied to existing settlements', async () => {
  await withStoreTransaction(pos, storeId, async db => {
    const tx = { ...scope, db };
    const funded = [];
    let cursor: string | null = null;
    do {
      const page = await balances(tx, { limit: '200', ...(cursor && { cursor }) });
      funded.push(...page.items.filter(row => row.hasEntries));
      cursor = page.nextCursor;
    } while (cursor);
    expect(funded).toHaveLength(3);
    expect(funded.reduce((total, row) => total + row.chargeBalance, 0)).toBe(37_000);
    expect(funded.reduce((total, row) => total + row.receivableBalance, 0)).toBe(21_400);
    expect((await entries(tx, funded[0].memberId, { kind: 'opening' })).items[0])
      .toMatchObject({ kind: 'opening', settlementId: null, sourceRef: null });
    expect((await db.query('SELECT 1 FROM pos.member_sale LIMIT 1')).rowCount).toBe(1);
  });
});

it('reads the same sales units for the menu and margin and includes historical member visits', async () => {
  await withStoreTransaction(pos, storeId, async db => {
    const tx = { ...scope, db, clock: { timezone: 'Asia/Seoul', dayStart: '05:00' } };
    const aggregate = await readCouponSales(tx, { businessDate: context.businessDate });
    const margins = await listMargins(tx, { from: context.businessDate, to: context.businessDate, limit: '50' });
    expect(margins.nextCursor).toBeNull();
    const quantity = aggregate.soldToday.reduce((total, row) => total + row.quantity, 0);
    expect(quantity).toBeGreaterThan(0);
    expect(quantity).toBe(margins.items.reduce((total, row) => total + row.quantity, 0));
    expect(aggregate.visits.length).toBeGreaterThan(0);
  });
  const regulars = await marketingScope(marketing, storeId, db => slotRegulars(db, storeId, {
    day: '2026-11-16', weekday: 3, startHour: 19, endHour: 21, timezone: 'Asia/Seoul',
  }));
  expect(regulars).toEqual([]);
});

it('keeps the expired historical passes and shows the three active café passes', async () => {
  const passes = await withCustomerStore(customer, storeId, db => memberships({ ...scope, db }, { status: 'active' }));
  expect(passes.items).toHaveLength(3);
});

it('reads local owner records, recorded inquiries and real coupon payment figures', async () => {
  expect(await get('marketing', '/local-changes?from=2026-11-16&to=2026-11-22')).toMatchObject({ unreadCount: 3 });
  const inbox = await get('marketing', '/inquiries');
  expect(inbox.items).toHaveLength(15);
  expect(inbox.waitingCount).toBe(8);
  const running = await get('marketing', '/coupons?status=active');
  expect(running.items).toHaveLength(1);
  expect(running.items[0]).toMatchObject({ status: 'active', messagesQueued: 0 });
  const performance = await get('marketing', '/performance');
  expect(performance.state).toBe('ready');
  expect(performance.coupons.used).toBeGreaterThan(0);
  expect(performance.coupons.payment.paidAmount).toBeGreaterThan(0);
  expect(performance.coupons.payment.pendingSettlements).toBe(0);
  expect(performance.coupons.rate).toBeCloseTo(100 * performance.coupons.used / performance.coupons.issued, 0);
  const { rowCount } = await marketingScope(marketing, storeId, db => db.query(`
    SELECT 1 FROM marketing.coupon_redemption r JOIN marketing.r19_sale s USING (store_id, settlement_id)
    WHERE r.customer_id IS DISTINCT FROM s.member_id
  `));
  expect(rowCount).toBe(0);
});

it('publishes the store guide and exposes only actual notices, if present', async () => {
  const manuals = await get('insight', '/insight/manuals');
  expect(manuals.items.filter((row: { section: string }) => row.section === 'store-info')).toHaveLength(1);
  expect(await get('insight', '/insight/grant-notices')).toMatchObject({ items: [] });
});

it('preserves the two operating-day expiry lots', async () => {
  const lots = await inventoryScope(inventory, storeId, db => db.query(
    'SELECT remaining_base::integer FROM inventory.stock_batch WHERE expires_on=$1 ORDER BY remaining_base', [context.businessDate]));
  expect(lots.rows.map(row => row.remaining_base)).toEqual([8, 12]);
});
