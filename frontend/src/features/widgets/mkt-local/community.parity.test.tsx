/** FIX-RV3 (RV-REALVERIFY-3): the community window keeps its original tabs in HTTP mode; the approved real-only tabs come after them. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createSeedTables } from '../../../data/db/seed';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { fakeBackend } from '../../../data/reality/00/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';
import { loaded, localBackend, openWidget, plain, structure } from './parity-harness';

afterEach(cleanup);

const at = `${TODAY}T06:45:00.000Z`;
const base = '/marketing';
const page = { items: [], nextCursor: null, asOf: at, sourceRevision: 1 };

function open() {
  const backend = fakeBackend();
  backend.on('GET', `${base}/local-changes`, ({ query }) => ({ ...page, coverage: null, unreadCount: 0, period: { from: query.from, to: query.to } }));
  backend.on('GET', `${base}/trade-area`, ({ query }) => ({ asOf: at, period: query, population: { status: 'unavailable', items: [] }, sales: { status: 'empty', items: [] } }));
  backend.on('GET', `${base}/local-trends`, ({ query }) => ({ asOf: at, period: query, search: null, sales: { status: 'empty', items: [] } }));
  backend.on('GET', `${base}/offers`, () => page);
  backend.on('GET', `${base}/offers/peers`, () => ({ status: 'available', items: [] }));
  backend.on('GET', `${base}/community/cafe-boards`, () => ({ items: [] }));
  backend.on('GET', `${base}/community/cafe-posts`, () => page);
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'local' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'community')!.Detail!;
  renderWithKit(<Detail featureId="community" condition={{ kind: 'default' }} detailRef={{ featureId: 'community' }} host={host} />, { modules: widgets, store });
}

it('keeps the original tabs and adds the approved sent-offers and Café tabs after them', async () => {
  open();
  await screen.findByRole('tab', { name: '받은 제안' });
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['받은 제안', '동네 둘러보기', '보낸 제안', '카페 글쓰기']);
  // The original browse tab says plainly that there is nothing public to browse, like the sample window does with no public offers.
  fireEvent.click(screen.getByRole('tab', { name: '동네 둘러보기' }));
  expect(await screen.findByText('둘러볼 공개 제안이 없어요')).toBeInTheDocument();
});

/* PAR-3 (D-384, D-355): the example (fixture) window and the real one are the same screen — four tabs, the offer button, interest, the Café tab. */
/** Received offers only (the real service has no public offers to browse), so the browse tab is empty in both modes. */
const directOnly = () => createWidgetDataStore({ partnershipOffer: createSeedTables().partnershipOffer.filter(o => o.visibility === 'direct').slice(0, 1) });

async function tabStructure(mode: 'example' | 'real', tab: string) {
  const opened = mode === 'example' ? openWidget('community', 'Detail', 'example', { store: directOnly() }) : openWidget('community', 'Detail', 'real', { backend: localBackend() });
  await loaded(opened.container);
  await screen.findByRole('tab', { name: '받은 제안' });
  fireEvent.click(screen.getByRole('tab', { name: tab }));
  expect(opened.container.querySelector('.mkt-add-toolbar')?.lastElementChild).toHaveTextContent('제휴 제안 만들기');
  if (tab === '카페 글쓰기') {
    const hint = await screen.findByText('사진·파일은 붙일 수 없어요');
    const review = screen.getByRole('button', { name: '올릴 내용 확인하기' });
    const posts = screen.getByRole('heading', { name: '올린 글' });
    const bodyField = screen.getByRole('textbox', { name: '본문' }).closest('.ui-field');
    expect(hint.compareDocumentPosition(bodyField!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bodyField?.nextElementSibling).toContainElement(review);
    expect(review.compareDocumentPosition(posts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  const result = { structure: structure(opened.container), text: plain(opened.container) };
  cleanup();
  return result;
}

it('parity: every tab has the same parts in both modes — received, browse, sent and Café', async () => {
  for (const tab of ['받은 제안', '동네 둘러보기', '보낸 제안', '카페 글쓰기']) {
    const example = await tabStructure('example', tab);
    const real = await tabStructure('real', tab);
    expect(example.structure, tab).toEqual(real.structure);
    expect(example.structure.tabs).toEqual(['받은 제안', '동네 둘러보기', '보낸 제안', '카페 글쓰기']);
    expect(example.structure.buttons.slice(0, 1)).toEqual(['제휴 제안 만들기']);
  }
  const received = await tabStructure('example', '받은 제안');
  expect(received.structure.buttons).toEqual(['제휴 제안 만들기', '수락하기', '관심 보내기', '거절하기']);
  const cafe = await tabStructure('example', '카페 글쓰기');
  expect(cafe.structure.buttons).toEqual(['제휴 제안 만들기', '올릴 내용 확인하기']);
  expect(cafe.text).toContain('사진·파일은 붙일 수 없어요');
  expect(cafe.text).toContain('아직 올린 글이 없어요');
});

it('offer form: the same fields in both modes; an example offer goes to a store that offered to this one and joins the sent tab', async () => {
  const form = async (mode: 'example' | 'real') => {
    const opened = mode === 'example' ? openWidget('community', 'Detail', 'example', { store: directOnly() }) : openWidget('community', 'Detail', 'real', { backend: localBackend() });
    await loaded(opened.container);
    fireEvent.click(await screen.findByRole('button', { name: '제휴 제안 만들기' }));
    const el = screen.getByRole('form', { name: '제휴 제안 만들기' });
    const fields = [...el.querySelectorAll('input, textarea, select')].map(node => (node.closest('label')?.firstChild?.textContent ?? '').replace(/\s+/g, ' ').trim());
    const options = [...el.querySelectorAll('option')].map(option => option.textContent);
    const buttons = [...el.querySelectorAll('button')].map(button => button.textContent);
    cleanup();
    return { fields, buttons, first: options[0] };
  };
  const example = await form('example');
  expect(await form('real')).toEqual(example);
  expect(example.fields).toHaveLength(3);
  expect(example.fields[0]).toBe('받는 매장');

  const opened = openWidget('community', 'Detail', 'example', { store: directOnly() });
  await loaded(opened.container);
  fireEvent.click(await screen.findByRole('button', { name: '제휴 제안 만들기' }));
  const peer = screen.getByRole('combobox', { name: /받는 매장/ }) as HTMLSelectElement;
  expect([...peer.options].map(option => option.textContent)).toEqual(['매장 고르기', '상도 책마루']);
  fireEvent.change(peer, { target: { value: peer.options[1]!.value } });
  fireEvent.change(screen.getByRole('textbox', { name: /^제목/ }), { target: { value: '주말 공동 쿠폰' } });
  fireEvent.change(screen.getByLabelText(/^협업 방식/), { target: { value: '서로의 쿠폰을 안내해요' } });
  fireEvent.submit(screen.getByRole('form', { name: '제휴 제안 만들기' }));
  fireEvent.click(await screen.findByRole('button', { name: '이 제안 보내기' }));
  await waitFor(() => expect(opened.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.real.local.offerCreated' })));
  expect(await screen.findByRole('tab', { name: '보낸 제안', selected: true })).toBeInTheDocument();
  const pane = plain(opened.container);
  expect(pane).toContain('주말 공동 쿠폰');
  expect(pane).toContain('상도 책마루에 보낸 제안');
  // The received list is unchanged by an offer this store sent.
  fireEvent.click(screen.getByRole('tab', { name: '받은 제안' }));
  expect(screen.queryByText('주말 공동 쿠폰')).toBeNull();
});

it.each(['example', 'real'] as const)('shows one inline interest result and no success toast in %s mode', async mode => {
  const backend = localBackend();
  let interested = false;
  const offer = { id: 'o1', revision: 1, title: '책방 영수증 혜택', terms: '할인 안내', senderStoreId: '22222222-2222-4222-8222-222222222222',
    recipientStoreId: backend.storeId, startsOn: TODAY, endsOn: TODAY, respondBy: TODAY, canRespond: true,
    status: 'pending', sharedContact: null, updatedAt: at, visibility: 'direct' };
  backend.on('GET', '/marketing/offers', () => ({ ...page, items: [{ ...offer, interested }] }));
  backend.on('POST', '/marketing/offers/o1/interest', () => {
    interested = true;
    return { resourceId: 'o1', revision: 2, receiptId: 'interest-1', affectedSources: ['local'] };
  });
  const opened = openWidget('community', 'Detail', mode, { store: directOnly(), backend });
  await loaded(opened.container);
  fireEvent.click(await screen.findByRole('button', { name: '관심 보내기' }));
  expect(await screen.findAllByText('관심을 보냈어요')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '관심 보내기' })).toBeNull();
  expect(opened.notify).not.toHaveBeenCalled();
});

it('Café tab: the example data walks the same two presses — review, then post — and lists the post with its link', async () => {
  const opened = openWidget('community', 'Detail', 'example', { store: directOnly() });
  await loaded(opened.container);
  fireEvent.click(await screen.findByRole('tab', { name: '카페 글쓰기' }));
  fireEvent.change(await screen.findByRole('textbox', { name: /^제목/ }), { target: { value: '이번 주 새 메뉴' } });
  fireEvent.change(screen.getByRole('textbox', { name: /^본문/ }), { target: { value: '보늬밤 라떼가 나왔어요' } });
  fireEvent.click(screen.getByRole('button', { name: '올릴 내용 확인하기' }));
  const confirmation = await screen.findByRole('group', { name: '이 글을 카페에 올릴까요?' });
  const publish = within(confirmation).getByRole('button', { name: '카페에 글 올리기' });
  expect(publish.parentElement?.previousElementSibling).toHaveTextContent('보늬밤 라떼가 나왔어요');
  expect(publish.closest('.detail-footer-actions')).toBeNull();
  fireEvent.click(publish);
  expect(await screen.findByText('카페에 글을 올렸어요', { exact: false })).toBeInTheDocument();
  const posts = within(opened.container.querySelector('[data-slot="community.cafe.posts"]') as HTMLElement);
  expect(posts.getAllByText('이번 주 새 메뉴').length).toBeGreaterThan(0);
  expect(posts.getByText('올렸어요')).toBeInTheDocument();
  expect(posts.getByRole('link', { name: /글 보기/ })).toHaveAttribute('href', 'https://cafe.naver.com/');
  // The post stays on the list when the tab is left and opened again.
  fireEvent.click(screen.getByRole('tab', { name: '보낸 제안' }));
  fireEvent.click(screen.getByRole('tab', { name: '카페 글쓰기' }));
  expect((await screen.findAllByText('이번 주 새 메뉴')).length).toBeGreaterThan(0);
});
