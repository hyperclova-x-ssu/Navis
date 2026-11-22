import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore, selectWidget, TODAY } from '../../../data/widget-data';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend } from '../../../data/reality/00/testing';
import { couponsAdapter } from '../../../data/reality/14/adapter';
import { renderWithKit } from '../../../ui/test-utils';
import { SlotCouponDetail } from './slot-coupon';

afterEach(cleanup);

// FIX-PKG-C T-29 (W24-D7): a slot nobody matches says "받는 사람이 없어요" once (the list), not again under the send button.
it('says there are no recipients once when the picked slot has nobody', async () => {
  const store = createWidgetDataStore();
  const condition = { kind: 'default' } as const;
  const slots = selectWidget(store.getSnapshot(), 'slot-coupon', condition, 'normal');
  const status = selectWidget(store.getSnapshot(), 'coupon-status', condition, 'normal');
  const expiry = selectWidget(store.getSnapshot(), 'expiry-coupon', condition, 'normal');
  if (slots.status !== 'ready' || status.status !== 'ready' || expiry.status !== 'ready') throw new Error('Expected coupon views');
  const backend = fakeBackend();
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [{
    ...couponsAdapter,
    tables: ['realCoupons'],
    async load() {
      return { tables: { realCoupons: { coupons: [], businessDate: TODAY, localAt: `${TODAY}T15:45`, status: status.model, naver: null, missing: [],
        slots: { ...slots.model, recipients: [] }, expiry: expiry.model } }, asOf: `${TODAY}T06:45:00Z`, sourceRevision: 1, complete: true };
    },
  }] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify() {}, acknowledgeBriefing() {} };
  renderWithKit(<SlotCouponDetail featureId="slot-coupon" condition={condition} detailRef={{ featureId: 'slot-coupon' }} host={host} />, { store });
  await screen.findAllByText('받는 사람이 없어요');
  expect(screen.getAllByText('받는 사람이 없어요')).toHaveLength(1);
});
