import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const briefingReadPaths = {
  customer: ['/calendar/events', '/calendar/projections', '/shifts', '/reservations'],
  inventory: ['/stock-batches', '/purchase-orders'],
  pos: ['/ledger', '/closings/:id', '/custom-pickups', '/tax-payments'],
  marketing: ['/local-changes', '/inquiries', '/notices', '/channel-reports', '/recommendations', '/coupons'],
} as const;

export const couponReadPaths = {
  customer: ['/customers'],
  inventory: ['/items/:itemId', '/stock-batches', '/menu', '/menu/:menuId', '/coupon-expiring-lots'],
  pos: ['/bills/:id'],
} as const;

export function allowWorkloadReads(app: FastifyInstance, ownerToken: string, readToken: string, prefix: string,
  paths: readonly string[], otherTokens: readonly (string | undefined)[]) {
  if (!readToken || [ownerToken, ...otherTokens].includes(readToken)) throw new Error('Read workload credential must be distinct');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const expected = hash(`Bearer ${readToken}`);
  const allowed = new Set(paths.map(path => prefix + path));
  app.addHook('onRequest', async req => {
    if (req.method !== 'GET' || !allowed.has(req.routeOptions.url ?? '')) return;
    const credential = req.headers.authorization;
    // Reuse the route's owner, store and operating-clock validation on the permitted reads.
    if (credential && timingSafeEqual(expected, hash(credential))) req.headers.authorization = `Bearer ${ownerToken}`;
  });
}
