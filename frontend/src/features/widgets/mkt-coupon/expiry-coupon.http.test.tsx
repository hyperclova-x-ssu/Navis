import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore, selectWidget, TODAY } from '../../../data/widget-data';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { couponsAdapter } from '../../../data/reality/14/adapter';
import { renderWithKit } from '../../../ui/test-utils';
import { ExpiryCouponDetail, ExpiryCouponPanel } from './expiry-coupon';

afterEach(cleanup);

it('keeps the original panel action, default SMS choice and two detail columns in both modes', async () => {
  const condition = { kind: 'default' } as const;
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify() {}, acknowledgeBriefing() {} };
  async function structure(http: boolean) {
    const store = createWidgetDataStore();
    const expiry = selectWidget(store.getSnapshot(), 'expiry-coupon', condition, 'normal');
    const status = selectWidget(store.getSnapshot(), 'coupon-status', condition, 'normal');
    if (expiry.status !== 'ready' || status.status !== 'ready') throw new Error('Expected coupon views');
    if (http) store.bindReal(createRealPort({ store, source: () => 'http', fetch: fakeBackend().fetch, adapters: [{
      ...couponsAdapter, tables: ['realCoupons'],
      async load() {
        return { tables: { realCoupons: { coupons: [], businessDate: TODAY, localAt: `${TODAY}T15:45`, status: status.model, expiry: expiry.model, slots: null, naver: null, missing: [] } },
          asOf: `${TODAY}T06:45:00Z`, sourceRevision: 1, complete: true };
      },
    }] }));
    const { container } = renderWithKit(<>
      <ExpiryCouponPanel featureId="expiry-coupon" condition={condition} width={3} height={3} shape="S" presetId="A" editing={false} host={host} />
      <ExpiryCouponDetail featureId="expiry-coupon" condition={condition} detailRef={{ featureId: 'expiry-coupon' }} host={host} />
    </>, { store });
    await screen.findByRole('radio', { name: /단골 문자/ });
    const result = { headings: screen.getAllByRole('heading').map(el => el.textContent),
      selected: screen.getAllByRole('radio', { checked: true }).map(el => el.textContent),
      columns: Array.from(container.querySelectorAll('[data-slot="expiry-coupon.detail"] > div'), el => el.className),
      actions: screen.getAllByRole('button', { name: /쿠폰 만들기/ }).map(el => el.className) };
    cleanup();
    return result;
  }
  const fixture = await structure(false);
  expect(fixture.selected).toEqual(expect.arrayContaining([expect.stringContaining('단골 문자')]));
  expect(await structure(true)).toEqual(fixture);
});

it('keeps HTTP publication in the same expiry coupon column and attests on the second press', async () => {
  const store = createWidgetDataStore();
  const snapshot = store.getSnapshot();
  const condition = { kind: 'default' } as const;
  const expiry = selectWidget(snapshot, 'expiry-coupon', condition, 'normal');
  const status = selectWidget(snapshot, 'coupon-status', condition, 'normal');
  if (expiry.status !== 'ready' || status.status !== 'ready') throw new Error('Expected coupon views');

  const backend = fakeBackend();
  const path = '/marketing/coupon-codes/place-code/mark-posted';
  let posted = false;
  backend.on('POST', path, () => {
    posted = true;
    return { resourceId: 'place-code', revision: 2, receiptId: 'receipt', affectedSources: ['coupons'] };
  });
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [{
    ...couponsAdapter,
    tables: ['realCoupons'],
    async load() {
      return { tables: { realCoupons: { coupons: [], businessDate: TODAY, localAt: `${TODAY}T15:45`,
        status: status.model, slots: null, naver: null, missing: [],
        expiry: { ...expiry.model, pendingPosts: posted ? [] : [{
          codeId: 'place-code', couponId: 'place-coupon', code: 'TODAY', route: 'place_news', post: { raw: '오늘의 쿠폰 코드를 보여 주세요' },
        }] } } },
        asOf: `${TODAY}T06:45:00Z`, sourceRevision: posted ? 2 : 1, complete: true };
    },
  }] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify() {}, acknowledgeBriefing() {} };
  renderWithKit(<ExpiryCouponDetail featureId="expiry-coupon" condition={condition} detailRef={{ featureId: 'expiry-coupon' }} host={host} />, { store });

  const attest = await screen.findByRole('button', { name: '올렸다고 표시하기' });
  expect(attest.closest('.mkt-col-side')).toBeInTheDocument();
  fireEvent.click(attest);
  expect(backend.callsTo('POST', path)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '변경 한 번 더 확인하기' }));
  await waitFor(() => expect(screen.queryByText('오늘의 쿠폰 코드를 보여 주세요')).toBeNull());
  expect(backend.callsTo('POST', path)).toHaveLength(1);
});

// FIX-PKG-C T-29 (W25-D7): once the coupon of the picked lot exists, its generated post is the only "게시 문구" (no second title with the generic hint).
it('shows the 게시 문구 title once when the picked lot already has its post', async () => {
  const store = createWidgetDataStore();
  const condition = { kind: 'default' } as const;
  const expiry = selectWidget(store.getSnapshot(), 'expiry-coupon', condition, 'normal');
  const status = selectWidget(store.getSnapshot(), 'coupon-status', condition, 'normal');
  if (expiry.status !== 'ready' || status.status !== 'ready' || !expiry.model.target) throw new Error('Expected coupon views');
  const handled = { ...expiry.model.target, handled: true };
  const backend = fakeBackend();
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [{
    ...couponsAdapter,
    tables: ['realCoupons'],
    async load() {
      return { tables: { realCoupons: { coupons: [], businessDate: TODAY, localAt: `${TODAY}T15:45`, status: status.model, slots: null, naver: null, missing: [],
        expiry: { ...expiry.model, items: [handled], target: handled, pendingPosts: [{
          codeId: 'place-code', couponId: 'place-coupon', code: 'TODAY', route: 'place_news', post: { raw: '오늘의 쿠폰 코드를 보여 주세요' },
        }] } } }, asOf: `${TODAY}T06:45:00Z`, sourceRevision: 1, complete: true };
    },
  }] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify() {}, acknowledgeBriefing() {} };
  renderWithKit(<ExpiryCouponDetail featureId="expiry-coupon" condition={condition} detailRef={{ featureId: 'expiry-coupon' }} host={host} />, { store });
  await screen.findByText('오늘의 쿠폰 코드를 보여 주세요');
  fireEvent.click(screen.getByRole('radio', { name: /플레이스 소식/ }));
  expect(screen.getAllByRole('heading', { name: '게시 문구' })).toHaveLength(1);
  expect(screen.queryByText(/쿠폰을 만들면 게시 문구와 쿠폰 코드가 함께/)).toBeNull();
});

// FIX-PKG-C T-07 (W25-K9): the attempt key follows the submitted values: a retry of the same values keeps it, changed values or a reopened form get their own.
it('keeps the create attempt key for equal submits and uses a new one for changed values or a reopened form', async () => {
  const condition = { kind: 'default' } as const;
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify() {}, acknowledgeBriefing() {} };
  const backend = fakeBackend();
  backend.on('POST', '/marketing/coupons/expiry', () => reply(409, { code: 'CONFLICT' }));
  const mount = async () => {
    const store = createWidgetDataStore();
    const expiry = selectWidget(store.getSnapshot(), 'expiry-coupon', condition, 'normal');
    const status = selectWidget(store.getSnapshot(), 'coupon-status', condition, 'normal');
    if (expiry.status !== 'ready' || status.status !== 'ready') throw new Error('Expected coupon views');
    const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [{
      ...couponsAdapter, tables: ['realCoupons'],
      async load() {
        return { tables: { realCoupons: { coupons: [], businessDate: TODAY, localAt: `${TODAY}T15:45`, status: status.model, slots: null, naver: null, missing: [], expiry: expiry.model } },
          asOf: `${TODAY}T06:45:00Z`, sourceRevision: 1, complete: true };
      },
    }] });
    store.bindReal(port);
    renderWithKit(<ExpiryCouponDetail featureId="expiry-coupon" condition={condition} detailRef={{ featureId: 'expiry-coupon' }} host={host} />, { store });
    await screen.findByRole('button', { name: '쿠폰 만들기' });
    fireEvent.click(screen.getByRole('radio', { name: /플레이스 소식/ }));
  };
  const press = async (count: number) => {
    fireEvent.click(screen.getByRole('button', { name: '쿠폰 만들기' }));
    fireEvent.click(await screen.findByRole('button', { name: '쿠폰 만들기' }));
    await waitFor(() => expect(backend.callsTo('POST', '/marketing/coupons/expiry')).toHaveLength(count));
    await screen.findByRole('button', { name: '쿠폰 만들기' }); // back on the form after the refusal
  };
  const keys = () => backend.callsTo('POST', '/marketing/coupons/expiry').map(call => call.headers.get('idempotency-key'));
  await mount();
  await press(1);
  await press(2);
  const [first, again] = keys();
  expect(first).toMatch(/^expiry:[0-9a-f-]{36}$/);
  expect(again).toBe(first);
  fireEvent.change(screen.getByRole('spinbutton', { name: /할인율/ }), { target: { value: '12' } });
  await press(3);
  const changed = keys()[2];
  expect(changed).not.toBe(first);
  cleanup();
  await mount();
  await press(4);
  const reopened = keys()[3];
  expect(reopened).not.toBe(first);
  expect(reopened).not.toBe(changed);
}, 30_000);
