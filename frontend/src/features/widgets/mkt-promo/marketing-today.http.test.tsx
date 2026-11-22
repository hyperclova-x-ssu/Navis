import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { CellSpan, ContentShape } from '../../../contracts';
import { groupsService, groupsSession, ids, person } from '../../../data/reality/19/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { MarketingTodayPanel } from './marketing-today';
import { makeHost } from './test-helpers';

afterEach(cleanup);
const seed = { customers: { 'churn-risk': [person(ids.stale)] } };
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
const panel = (session: ReturnType<typeof groupsSession>, w = 4, h = 2, host = makeHost()) => {
  renderWithKit(<MarketingTodayPanel featureId="marketing-today" condition={{ kind: 'default' }} width={w as CellSpan} height={h as CellSpan} shape={shapeOf(w, h)} presetId="A" editing={false} host={host} />, { store: session.store });
  return host;
};
const slot = (name: string) => document.querySelector(`[data-slot="marketing-today.slot.${name}"]`) as HTMLElement;

const quiet = { slot: 'now', kind: 'quiet-hours', sourceFeatureId: 'slot-coupon', params: { regulars: 3 }, quietSlot: { slotId: 'slot-2026-11-22-14', date: '2026-11-22', weekday: 7, startHour: 14, endHour: 16 }, ref: { featureId: 'slot-coupon', view: 'send', itemId: 'slot-2026-11-22-14', focus: 'action' } } as const;
const replies = (drafted: number) => ({ slot: 'today', kind: 'replies', sourceFeatureId: 'ai-response', params: { count: 2, drafted }, ref: { featureId: 'ai-response', itemId: 'inquiry-1', focus: 'action' } }) as const;
const video = { slot: 'week', kind: 'video', sourceFeatureId: 'promo-video', params: { photos: 7 }, ref: { featureId: 'promo-video', view: 'create', focus: 'action' } } as const;
const expiry = { slot: 'now', kind: 'expiry', sourceFeatureId: 'expiry-coupon', params: { count: 6, itemName: '크루아상' }, ref: { featureId: 'expiry-coupon', itemId: 'lot-1', focus: 'action' } } as const;

it('shows the service cells in order and opens each one at its own record with the action focused', async () => {
  const service = groupsService({ ...seed, today: { state: 'ready', cells: [quiet, replies(1), video] as never, folded: [], tapTarget: { featureId: 'slot-coupon', view: 'send' } } });
  const host = panel(groupsSession(service));
  await waitFor(() => expect(slot('now')).not.toBeNull());
  expect(slot('now')).toHaveTextContent(/일요일 14~16시가 한산해요/u);
  expect(slot('now')).toHaveTextContent(/단골이 3명 있어요/u);
  expect(slot('today')).toHaveTextContent('기록한 문의 2건이 답변을 기다려요');
  expect(slot('today')).toHaveTextContent('답변 초안을 써 뒀어요');
  expect(slot('week')).toHaveTextContent(/사진 7장이 있어요/u);
  fireEvent.click(slot('now').querySelector('button') as HTMLElement);
  expect(host.openDetail).toHaveBeenLastCalledWith({ featureId: 'slot-coupon', view: 'send', itemId: 'slot-2026-11-22-14', focus: 'action' });
  fireEvent.click(slot('today').querySelector('button') as HTMLElement);
  expect(host.openDetail).toHaveBeenLastCalledWith({ featureId: 'ai-response', itemId: 'inquiry-1', focus: 'action' });
  fireEvent.click(slot('week').querySelector('button') as HTMLElement);
  expect(host.openDetail).toHaveBeenLastCalledWith({ featureId: 'promo-video', view: 'create', focus: 'action' });
});

it('shows the next actionable suggestion when the quiet slot has nobody to send to', async () => {
  const noAudience = { ...quiet, params: { regulars: 0 } };
  panel(groupsSession(groupsService({ ...seed, today: { state: 'ready', cells: [noAudience, replies(0), video] as never } })), 1, 1);
  await waitFor(() => expect(slot('today')).not.toBeNull());
  expect(slot('now')).toBeNull();
  expect(screen.queryByRole('button', { name: /쿠폰 보내기/ })).toBeNull();
});

it('does not say drafts are ready when none was written, and names the lot by its own item name', async () => {
  const service = groupsService({ ...seed, today: { state: 'ready', cells: [expiry, replies(0)] as never, folded: ['week'], tapTarget: { featureId: 'expiry-coupon' } } });
  panel(groupsSession(service));
  await waitFor(() => expect(slot('now')).not.toBeNull());
  expect(slot('now')).toHaveTextContent('크루아상');
  expect(slot('now')).toHaveTextContent(/6/u);
  expect(slot('today')).not.toHaveTextContent('답변 초안을 써 뒀어요');
});

it('names a source that is not available yet next to the cells it did build', async () => {
  const service = groupsService({ ...seed, today: { state: 'partial', missing: ['coupons', 'assets'], cells: [replies(0)] as never, folded: ['now', 'week'], tapTarget: { featureId: 'ai-response' } } });
  panel(groupsSession(service));
  await waitFor(() => expect(slot('today')).not.toBeNull());
  expect(document.body.textContent).toMatch(/쿠폰 자료는 아직 볼 수 없어요/u);
  expect(document.body.textContent).toMatch(/사진 자료는 아직 볼 수 없어요/u);
  expect(document.body.textContent).not.toMatch(/오늘은 할 홍보가 없어요|할 일이 없어요/u);
});

it('says "not available yet", not "nothing to do", when no cell exists and a source is missing', async () => {
  const service = groupsService({ ...seed, today: { state: 'partial', missing: ['coupons', 'replies', 'assets'] } });
  panel(groupsSession(service));
  expect(await screen.findByText('일부 자료를 아직 볼 수 없어서 오늘 할 홍보를 다 정하지 못했어요')).toBeInTheDocument();
  expect(document.querySelector('[data-slot="marketing-today.empty"]')).not.toBeNull();
});

it('names the one source that is missing when it is the only one', async () => {
  const service = groupsService({ ...seed, today: { state: 'partial', missing: ['assets'] } });
  panel(groupsSession(service));
  expect(await screen.findByText('사진 자료를 아직 볼 수 없어서 영상 홍보는 정하지 못했어요. 다른 할 일은 없어요')).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/오늘 할 일이 없어요/u);
});

it('keeps the "nothing to do" state only when nothing is missing', async () => {
  panel(groupsSession(groupsService(seed)));
  await waitFor(() => expect(document.querySelector('[data-slot="marketing-today.empty"]')).not.toBeNull());
  expect(document.body.textContent).not.toMatch(/아직 볼 수 없어요/u);
});

it('a failed section is an error that re-reads the service', async () => {
  const service = groupsService({ ...seed, today: { state: 'ready', cells: [quiet] as never, folded: [], tapTarget: { featureId: 'slot-coupon', view: 'send' } } });
  service.control.fail.add('today');
  panel(groupsSession(service));
  expect(await screen.findByText(/자료를 불러오지 못했어요/u)).toBeInTheDocument();
  const reads = service.backend.callsTo('GET', '/marketing/recommendations').length;
  service.control.fail.clear();
  fireEvent.click(screen.getByRole('button', { name: /다시 시도/u }));
  await waitFor(() => expect(slot('now')).not.toBeNull());
  expect(service.backend.callsTo('GET', '/marketing/recommendations').length).toBeGreaterThan(reads);
});
