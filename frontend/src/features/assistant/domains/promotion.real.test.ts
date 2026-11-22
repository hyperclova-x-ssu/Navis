import { expect, it } from 'vitest';
import { groupsService, groupsSession, perf } from '../../../data/reality/19/testing';
import { couponsDomain } from './coupons';
import { promotionDomain } from './promotion';

const condition = { kind: 'default' } as const;

/**
 * D-365: the 마케팅 성과 widget is gone. The real-mode performance data (channels, POS payments, return rate) stays in the data layer,
 * but the promotion domain no longer serves it as a widget's facts, and what the coupon domain still says about coupon use is
 * attributed to 진행 중인 쿠폰, never to the removed widget.
 */
async function session() {
  const { store, port } = groupsSession(groupsService({ performance: { 'this-month': perf() } }));
  await port.load('groups');
  return store;
}

it('does not claim or project the removed widget any more', async () => {
  const store = await session();
  expect(promotionDomain.featureIds).not.toContain('marketing-performance');
  expect(promotionDomain.projectWidget?.(store.getSnapshot(), 'marketing-performance', condition, 'ko')).toBeUndefined();
});

it('keeps the coupon use facts of 진행 중인 쿠폰 without citing the removed widget as their source', async () => {
  const store = await session();
  const projected = couponsDomain.projectWidget?.(store.getSnapshot(), 'coupon-status', condition, 'ko');
  if (!projected || !('facts' in projected)) throw new Error('Missing coupon status facts');
  const performance = projected.facts.filter(fact => fact.key.startsWith('coupons.performance.'));
  expect(performance.length).toBeGreaterThan(0);
  expect(performance.map(fact => fact.source)).not.toContain('marketing-performance');
});
