import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { beginDashboard } from '../../../app/test-session';
import { getRegistry } from '../../../catalog';
import type { FeatureId, WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { fakeBackend, TEST_STORE_ID } from '../../../data/reality/00/testing';
import { screenPresets } from '../../../layout';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import { createAgentActions } from '../../assistant/agent-actions';
import { widgets } from './index';

afterEach(cleanup);

const partner = '22222222-2222-4222-8222-222222222222';
const changeId = '33333333-3333-4333-8333-333333333333';
const offerId = '44444444-4444-4444-8444-444444444444';
const at = `${TODAY}T06:45:00.000Z`;
const base = '/marketing';
const emptyPage = { items: [], nextCursor: null, asOf: at, sourceRevision: 1 };
const coverage = { region: '동작구', kinds: ['festival'], referenceDate: TODAY };

function setup(backend = fakeBackend()) {
  backend.on('GET', `${base}/local-changes`, ({ query }) => ({ ...emptyPage, coverage, unreadCount: 0, period: { from: query.from, to: query.to } }));
  backend.on('GET', `${base}/trade-area`, ({ query }) => ({ asOf: at, period: query,
    population: { status: 'unavailable', items: [] }, sales: { status: 'available', items: [{ hour: 14, quantity: 9, settlementIds: ['sale-9'] }] } }));
  backend.on('GET', `${base}/local-trends`, ({ query }) => ({ asOf: at, period: query,
    search: query.keyword ? { status: 'available', query: { startDate: query.from, endDate: query.to, timeUnit: 'date', keywordGroups: [{ groupName: query.keyword, keywords: [query.keyword] }] }, items: [{ period: TODAY, ratio: 37.5 }] } : null,
    sales: { status: 'available', items: [{ menuId: 'menu-1', menuName: '카페라떼', businessDate: TODAY, quantity: 9 }] } }));
  backend.on('GET', `${base}/offers`, () => emptyPage);
  backend.on('GET', `${base}/offers/peers`, () => ({ status: 'available', items: [
    { storeId: backend.storeId === TEST_STORE_ID ? partner : TEST_STORE_ID, displayName: '참여 카페' },
  ] }));
  return backend;
}

function open(backend: ReturnType<typeof fakeBackend>, featureId: FeatureId) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'local' ? 'http' : 'fixture' });
  store.bindReal(port);
  const notify = vi.fn();
  const host: WidgetHost = {
    layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify, acknowledgeBriefing() {},
  };
  const Detail = widgets.find(widget => widget.id === featureId)!.Detail!;
  const rendered = renderWithKit(<Detail featureId={featureId} condition={{ kind: 'default' }} detailRef={{ featureId }} host={host} />, { modules: widgets, store });
  return { ...rendered, store, port, notify };
}

it('re-reads a sourced change and its acknowledgement in a fresh store', async () => {
  const backend = setup();
  let acknowledgedAt: string | null = null;
  backend.on('GET', `${base}/local-changes`, ({ query }) => ({ ...emptyPage, coverage, unreadCount: acknowledgedAt ? 0 : 1, period: query, items: [{
    id: changeId, revision: acknowledgedAt ? 2 : 1, kind: 'festival', title: '동작구 거리 축제', region: '동작구',
    authority: '동작구청', sourceUrl: 'https://www.dongjak.go.kr/notice', dateKind: 'event-date', referenceDate: TODAY, updatedAt: at, acknowledgedAt,
  }] }));
  const undoUntil = '2099-01-01T00:00:06.000Z';
  backend.on('POST', `${base}/local-changes/${changeId}/ack`, () => {
    acknowledgedAt = at;
    return { resourceId: changeId, revision: 2, receiptId: 'ack-1', undoUntil, affectedSources: ['local-changes', 'briefing'] };
  });
  const { store, notify } = open(backend, 'local-changes');
  expect(await screen.findByRole('heading', { name: '동작구 거리 축제' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '동작구 거리 축제' }).closest('ul')).toHaveAttribute('data-slot', 'local-changes.list');
  // FIX-RV3: whenever a change exists the window shows the original cards, never the empty sentence in their place.
  expect(screen.getByRole('heading', { name: '동작구 거리 축제' }).closest('li')).toHaveClass('mkt-card');
  expect(document.querySelector('.mkt-detail-state__message')).toBeNull();
  expect(screen.getByRole('link', { name: '원문 열기' })).toHaveAttribute('href', 'https://www.dongjak.go.kr/notice');
  expect(screen.getByText(/공식 공고와 직접 적은 변화만 보여요.*동작구/)).toBeInTheDocument();
  expect(screen.getByText(/행사일/)).toBeInTheDocument();
  expect(backend.callsTo('POST', /marketing/)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /확인 완료로 표시하기.*동작구 거리 축제/ }));
  await waitFor(() => expect(store.getSnapshot().tables.localChange.find(row => row.changeId === changeId)?.ackedAt).toBe(at));
  const [call] = backend.callsTo('POST', /\/ack$/u);
  expect(call.body).toEqual({ expectedRevision: 1 });
  expect(call.headers.get('idempotency-key')).toBeTruthy();
  await waitFor(() => expect(notify).toHaveBeenCalledWith({ kind: 'success', messageKey: 'data.notice.changeAcked', undoToken: 'real-undo:ack-1', undoUntil }));
  cleanup();
  open(backend, 'local-changes');
  fireEvent.click(await screen.findByRole('button', { name: /접어 둔 변화 1개/ }));
  expect(await screen.findByRole('heading', { name: '동작구 거리 축제' })).toBeInTheDocument();
});

it('requires a recipient card press to accept a bilateral offer and displays the receipt state in each store', async () => {
  const sender = setup();
  const recipient = setup(fakeBackend(partner));
  let status: null | 'pending' | 'accepted' = null;
  const offer = (canRespond: boolean) => ({ ...emptyPage, items: status ? [{ id: offerId, revision: status === 'pending' ? 1 : 2,
    title: '주말 공동 행사', terms: '서로의 안내 카드를 비치해요', senderStoreId: TEST_STORE_ID, recipientStoreId: partner,
    startsOn: TODAY, endsOn: TODAY, respondBy: TODAY, canRespond: canRespond && status === 'pending',
    status, interested: false, sharedContact: null, updatedAt: at, visibility: 'direct' }] : [] });
  sender.on('GET', `${base}/offers`, () => offer(false));
  recipient.on('GET', `${base}/offers`, () => offer(true));
  sender.on('POST', `${base}/offers`, () => {
    status = 'pending';
    return { resourceId: offerId, revision: 1, receiptId: 'sent-1', affectedSources: ['community', 'calendar', 'briefing'] };
  });
  recipient.on('POST', `${base}/offers/${offerId}/accept`, () => {
    status = 'accepted';
    return { resourceId: offerId, revision: 2, receiptId: 'accepted-1', affectedSources: ['community', 'calendar', 'briefing'] };
  });
  open(sender, 'community');
  fireEvent.click(await screen.findByRole('button', { name: '제휴 제안 만들기' }));
  fireEvent.change(screen.getByRole('combobox', { name: '받는 매장' }), { target: { value: partner } });
  fireEvent.change(screen.getByRole('textbox', { name: '제목' }), { target: { value: '주말 공동 행사' } });
  fireEvent.change(screen.getByRole('textbox', { name: '협업 방식' }), { target: { value: '서로의 안내 카드를 비치해요' } });
  fireEvent.click(screen.getByRole('button', { name: '제안 확인하기' }));
  expect(sender.callsTo('POST', /marketing/)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '이 제안 보내기' }));
  expect(await screen.findByRole('button', { name: /주말 공동 행사.*응답 대기/ })).toBeInTheDocument();
  expect(sender.callsTo('POST', `${base}/offers`).map(call => call.body)).toEqual([{
    recipientStoreId: partner, title: '주말 공동 행사', terms: '서로의 안내 카드를 비치해요', startsOn: TODAY, endsOn: TODAY, respondBy: TODAY,
  }]);
  expect(screen.queryByRole('button', { name: '수락하기' })).toBeNull();
  cleanup();
  open(recipient, 'community');
  const accept = await screen.findByRole('button', { name: '수락하기' });
  expect(screen.getByRole('heading', { name: '주말 공동 행사' }).closest('.mkt-detail')).toHaveAttribute('data-slot', 'community.card');
  expect(recipient.callsTo('POST', /marketing/)).toHaveLength(0);
  fireEvent.click(accept);
  fireEvent.click(accept);
  await waitFor(() => expect(screen.queryByRole('button', { name: '수락하기' })).toBeNull());
  expect(recipient.callsTo('POST', /\/accept$/u).map(call => call.body)).toEqual([{ expectedRevision: 1 }]);
  cleanup();
  open(sender, 'community');
  fireEvent.click(await screen.findByRole('tab', { name: '보낸 제안' }));
  expect(await screen.findByRole('button', { name: /주말 공동 행사.*진행 중/ })).toBeInTheDocument();
});

it('shows POS sales in the hour chart when Seoul data is missing', async () => {
  const backend = setup();
  open(backend, 'trade-area');
  expect(await screen.findByText('우리 매장 시간대별 판매')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: /시간대별/ }).querySelectorAll('.mkt-hour__track')).toHaveLength(1);
  expect(screen.getByText(/자료가 없어요/)).toBeInTheDocument();
  expect(screen.getByText(/판매 수량 9/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /14~15시, 9개/ })).toBeInTheDocument();
});

it('shows Seoul estimates in the original hourly chart and hour card with their unit and POS basis', async () => {
  const backend = setup();
  backend.on('GET', `${base}/trade-area`, ({ query }) => ({ asOf: at, period: query,
    population: { status: 'available', quarter: '2026-Q4', weekday: 1,
      items: Array.from({ length: 24 }, (_, hour) => ({ region: '서울 동작구 상도동', quarter: '2026-Q4', weekday: 1,
        startHour: hour, endHour: hour + 1, estimate: 100 + hour, referenceDate: TODAY, refreshedAt: at, sourceUrl: 'https://data.seoul.go.kr/' })) },
    sales: { status: 'available', items: [{ hour: 14, quantity: 9, settlementIds: ['sale-9'] }] } }));
  const { container } = open(backend, 'trade-area');
  const chart = await screen.findByRole('group', { name: '이동량(추정)' });
  expect(chart.querySelectorAll('.mkt-hour__track')).toHaveLength(14);
  expect(screen.queryByRole('button', { name: /^0~1시/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '14~15시, 114명' }));
  const card = container.querySelector('[data-slot="trade-area.metric.value"]');
  expect(card).toHaveClass('mkt-card');
  expect(card?.querySelector('.ui-master-detail')).toBeNull();
  expect(card?.querySelector('.mkt-card__meta')).toHaveTextContent('서울 공개 자료');
  // FIX-PKG-A T-27: the service's quarter code is written as the owner reads it.
  expect(card?.querySelector('.mkt-card__meta')).toHaveTextContent('2026년 4분기');
  expect(card?.textContent).not.toContain('2026-Q4');
  expect(screen.getByText(/판매 수량 9개/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '원문 열기' })).toHaveAttribute('href', 'https://data.seoul.go.kr/');
});

it('shows menu sales in the original expandable rows and treats a keyword lookup as a read', async () => {
  const backend = setup();
  open(backend, 'local-trends');
  // FIX-RV3: no second heading above the original keyword rows; the lookup comes after them.
  const row = await screen.findByRole('button', { name: /카페라떼.*9/ });
  expect(screen.queryByRole('heading', { name: '우리 메뉴 판매 추이' })).toBeNull();
  expect(row).toHaveAttribute('aria-expanded', 'true');
  expect(row.compareDocumentPosition(screen.getByRole('textbox', { name: '검색어' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: '검색어' }), { target: { value: '카페라떼' } });
  fireEvent.click(screen.getByRole('button', { name: '관심도 보기' }));
  expect(await screen.findByText('37.5')).toBeInTheDocument();
  expect(backend.callsTo('GET', `${base}/local-trends`).at(-1)?.query.keyword).toBe('카페라떼');
  expect(backend.callsTo('POST', /marketing/)).toHaveLength(0);
});

it('sends the Navis decline command only on the second card press', async () => {
  const backend = setup(fakeBackend(partner));
  let pending = true;
  backend.on('GET', `${base}/offers`, () => ({ ...emptyPage, items: [{ id: offerId, revision: pending ? 1 : 2,
    title: '주말 제휴', terms: '매장 안에서만 진행해요', senderStoreId: TEST_STORE_ID, recipientStoreId: partner, startsOn: TODAY, endsOn: TODAY,
    respondBy: TODAY, canRespond: pending, status: pending ? 'pending' : 'declined', interested: false, sharedContact: null }] }));
  backend.on('POST', `${base}/offers/${offerId}/decline`, () => {
    pending = false;
    return { resourceId: offerId, revision: 2, receiptId: 'declined-1', affectedSources: ['community', 'calendar', 'briefing'] };
  });
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
    clock: () => 0, theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe');
  run.actions.dismissCoach();
  run.actions.switchLayer('marketing');
  const runId = run.getState().runId;
  const store = createWidgetDataStore(undefined, { runId });
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'local' ? 'http' : 'fixture' });
  store.bindReal(port);
  await port.load('local');
  const snapshot = store.getSnapshot();
  const actions = createAgentActions(store, undefined, run);
  const prepared = actions.prepare({ command: 'community.decline', args: { offerId: { handle: 'offer-1' } },
    snapshotRevision: snapshot.revision, proposalId: 'wire-offer', runId, layer: 'marketing', tier: 'normal' }, {}, snapshot,
  () => true, new Map([['offer-1', { kind: 'offer' as const, id: offerId }]]));
  if (prepared.kind !== 'proposal') throw new Error(prepared.kind);
  const card = prepared.proposal;
  expect(card.tier).toBe('extra-confirm');
  expect(backend.callsTo('POST', /marketing/)).toHaveLength(0);
  card.confirm(store);
  expect(backend.callsTo('POST', /marketing/)).toHaveLength(0);
  card.confirm(store, card.id);
  expect((await card.settled()).frame.outcome).toBe('applied');
  const writes = backend.callsTo('POST', /\/decline$/u);
  expect(writes.map(call => call.body)).toEqual([{ confirmed: true, expectedRevision: 1 }]);
  expect(writes[0].headers.get('idempotency-key')).toBe(`navis:${runId}:${card.id}`);
});

it('keeps offer creation disabled until the approved peer list can be re-read', async () => {
  const backend = setup();
  let available = false;
  backend.on('GET', `${base}/offers/peers`, () => ({ status: available ? 'available' : 'unavailable',
    items: available ? [{ storeId: partner, displayName: '참여 카페' }] : [] }));
  open(backend, 'community');
  expect(await screen.findByText('참여 매장을 불러오지 못했어요')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '제휴 제안 만들기' })).toBeNull();
  available = true;
  fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
  expect(await screen.findByRole('button', { name: '제휴 제안 만들기' })).toBeEnabled();
  expect(backend.callsTo('POST', /marketing/)).toHaveLength(0);
});
