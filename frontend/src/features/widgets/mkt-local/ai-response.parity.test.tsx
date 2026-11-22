/** FIX-RV3 (RV-REALVERIFY-3 and -4): the inbox widget keeps its original two-column layout in HTTP mode, and one rule counts what waits for a reply. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { service } from '../../../data/reality/15/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

afterEach(cleanup);

/** The service's visible NAVER reviews: one already in the queue (rv-1), one waiting for a reply (rv-2), one already answered on NAVER (rv-3). */
function backendWithImports() {
  const made = service();
  made.backend.on('GET', '/marketing/reviews', () => ({ items: [
    { ref: 'rv-1', text: '커피가 맛있어요', keywords: [], media: [], stars: 5, reply: null, hasReply: false },
    { ref: 'rv-2', text: '창가 자리가 조용해서 좋았어요', keywords: [], media: [], stars: 4, reply: null, hasReply: false },
    { ref: 'rv-3', text: '직원분이 친절했어요', keywords: [], media: [], stars: 5, reply: '감사합니다', hasReply: true },
  ] }));
  made.backend.on('GET', '/marketing/talktalk/consultations', () => ({ nextCursor: null, items: [
    { ref: 'tt-1', status: 'waiting' }, { ref: 'tt-2', status: 'in-progress' }, { ref: 'tt-3', status: 'completed' }, { ref: 'tt-4', status: 'spam' },
  ] }));
  return made;
}

function open(backend: ReturnType<typeof service>['backend'], which: 'Detail' | 'Panel', detailRef: { itemId?: string; view?: string } = {}) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'inbox' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const module = widgets.find(widget => widget.id === 'ai-response')!;
  if (which === 'Detail') {
    const Detail = module.Detail!;
    return renderWithKit(<Detail featureId="ai-response" condition={{ kind: 'default' }} detailRef={{ featureId: 'ai-response', ...detailRef }} host={host} />, { modules: widgets, store });
  }
  const Panel = module.Panel;
  return renderWithKit(<Panel featureId="ai-response" presetId="A" editing={false} condition={{ kind: 'default' }} width={2} height={2} shape="S" host={host} />, { modules: widgets, store });
}

it('counts the queue and the visible reviews and consultations that wait for a reply with one rule in the panel and the window', async () => {
  const { backend } = backendWithImports();
  const detail = open(backend, 'Detail');
  // Queue: review, talk, manual (3). Waiting to be taken in: review rv-2 and consultation tt-2 (rv-3 is answered, tt-3 is completed, tt-4 is spam).
  expect(await screen.findByText(/^답변 대기 5건 · 메시지 3 · 리뷰 2/)).toBeInTheDocument();
  detail.unmount();
  open(backend, 'Panel');
  expect(await screen.findByText('5')).toBeInTheDocument();
  expect(screen.getByText(/메시지 3/)).toBeInTheDocument();
});

it('lists the review waiting for a reply in the two-column list and opens it on the right with the one button that takes it in', async () => {
  const { backend } = backendWithImports();
  open(backend, 'Detail', { view: 'review' });
  // The original two-column split stays: a list column and a reading column.
  const row = await screen.findByRole('button', { name: /창가 자리가 조용해서 좋았어요/ });
  expect(row.closest('.ui-master-detail__list')).toBeInTheDocument();
  expect(row.className).toContain('mkt-pick');
  expect(screen.queryByText('네이버에서 가져오기')).toBeNull();
  expect(screen.queryByText('가져올 새 항목이 없어요')).toBeNull();
  // The already answered review remains readable, with no waiting badge or extra count.
  const answered = screen.getByRole('button', { name: /직원분이 친절했어요/ });
  expect(answered).not.toHaveTextContent('답변 대기');
  fireEvent.click(answered);
  expect(screen.getByText('감사합니다')).toBeInTheDocument();
  fireEvent.click(row);
  const pane = row.closest('.ui-master-detail')!.querySelector('.ui-master-detail__detail') as HTMLElement;
  expect(within(pane).getByText('창가 자리가 조용해서 좋았어요')).toBeInTheDocument();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  fireEvent.click(within(pane).getByRole('button', { name: '답글 대기에 넣기' }));
  await waitFor(() => expect(backend.callsTo('POST', '/marketing/inquiries')).toHaveLength(1));
  expect(backend.callsTo('POST', '/marketing/inquiries')[0]!.body).toEqual({ source: 'review', providerRef: 'rv-2' });
});

it('shows the consultation waiting for a reply under the messages tab', async () => {
  const { backend } = backendWithImports();
  open(backend, 'Detail');
  const row = await screen.findByRole('button', { name: /톡톡 상담 tt-2/ });
  expect(row.closest('.ui-master-detail__list')).toBeInTheDocument();
  expect(screen.queryByText(/톡톡 상담 tt-3|톡톡 상담 tt-4/)).toBeNull();
});

