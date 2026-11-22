/** GAPUI-MKT (SCR-31 · community `카페 글쓰기`, PN17): text-only Café post from two owner presses, receipt link and the owner's post list. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { fakeBackend, reply, type RecordedCall } from '../../../data/reality/00/testing';
import type { CafePostDto } from '../../../data/reality/13/dto';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

afterEach(cleanup);

const at = `${TODAY}T06:45:00.000Z`;
const base = '/marketing';
const page = (items: readonly unknown[] = [], sourceRevision = 1) => ({ items, nextCursor: null, asOf: at, sourceRevision });
const board = { clubid: '31000001', menuid: '7' };
const article = 'https://cafe.naver.com/navistown/120';

function setup(boards: readonly { clubid: string; menuid: string }[] = [board]) {
  const backend = fakeBackend();
  const posts: CafePostDto[] = [];
  const log: string[] = [];
  let revision = 4;
  backend.on('GET', `${base}/local-changes`, ({ query }) => ({ ...page(), coverage: null, unreadCount: 0, period: { from: query.from, to: query.to } }));
  backend.on('GET', `${base}/trade-area`, ({ query }) => ({ asOf: at, period: query, population: { status: 'unavailable', items: [] }, sales: { status: 'empty', items: [] } }));
  backend.on('GET', `${base}/local-trends`, ({ query }) => ({ asOf: at, period: query, search: null, sales: { status: 'empty', items: [] } }));
  backend.on('GET', `${base}/offers`, () => page());
  backend.on('GET', `${base}/offers/peers`, () => ({ status: 'available', items: [] }));
  backend.on('GET', `${base}/community/cafe-boards`, () => ({ items: boards }));
  backend.on('GET', `${base}/community/cafe-posts`, () => page(posts, revision));
  const approvals = new Map<string, { body: unknown; confirmed: boolean }>();
  backend.on('POST', `${base}/approvals`, (call: RecordedCall) => {
    const body = call.body as { operation: string; stage: string; approvalId?: string; expectedRevision: number; targetRef: string; command: unknown };
    log.push(`card:${body.operation}:${body.stage}`);
    const intent = JSON.stringify({ ...body, stage: undefined, approvalId: undefined });
    if (body.stage === 'confirm') {
      const prior = approvals.get(body.approvalId!);
      if (!prior || JSON.stringify(prior.body) !== intent) return reply(409, { code: 'APPROVAL_CONFLICT' });
      prior.confirmed = true;
      return { approvalId: body.approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    }
    if (body.expectedRevision !== revision) return reply(409, { code: 'STALE_REVISION' });
    const approvalId = `a0000000-0000-4000-8000-00000000000${approvals.size + 1}`;
    approvals.set(approvalId, { body: JSON.parse(intent), confirmed: false });
    return { approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  });
  backend.on('POST', `${base}/community/cafe-posts`, (call: RecordedCall) => {
    const key = call.headers.get('idempotency-key') ?? '';
    const approval = approvals.get(key.replace(/^navis:/, ''));
    if (!approval?.confirmed) return reply(403, { code: 'CARD_REQUIRED' });
    const prior = posts.find(row => row.receiptId === key);
    const { subject } = call.body as { subject: string };
    const row: CafePostDto = prior ?? { id: `p${posts.length + 1}`, receiptId: key, revision: 2, state: 'published', subject, articleId: '120', articleUrl: article, updatedAt: at };
    if (!prior) { posts.push(row); revision += 1; log.push('action:cafe.post'); }
    return { ...row, resourceId: row.id, affectedSources: ['community'] };
  });
  return { backend, posts, log };
}

function open(backend: ReturnType<typeof fakeBackend>) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'local' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'community')!.Detail!;
  renderWithKit(<Detail featureId="community" condition={{ kind: 'default' }} detailRef={{ featureId: 'community', view: 'cafe' }} host={host} />, { modules: widgets, store });
  return { store };
}

it('posts text to the one writable board only after the card press and its confirmation, once, and links the article', async () => {
  const { backend, log } = setup();
  open(backend);
  expect(await screen.findByText('글을 쓸 수 있는 게시판 1곳에 올려요')).toBeInTheDocument();
  expect(screen.getByText('아직 올린 글이 없어요')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '올릴 내용 확인하기' }));
  expect(await screen.findByText('제목을 넣어 주세요')).toBeInTheDocument();
  expect(log).toEqual([]);
  fireEvent.change(screen.getByRole('textbox', { name: /제목/ }), { target: { value: '동네 플리마켓 안내' } });
  fireEvent.change(screen.getByRole('textbox', { name: '본문' }), { target: { value: '토요일 2시에 열려요.\n함께해요' } });
  fireEvent.click(screen.getByRole('button', { name: '올릴 내용 확인하기' }));
  const confirm = await screen.findByRole('group', { name: '이 글을 카페에 올릴까요?' });
  expect(within(confirm).getByText(/토요일 2시에 열려요/)).toBeInTheDocument();
  expect(log).toEqual(['card:cafe.post:press']);
  expect(backend.callsTo('POST', `${base}/community/cafe-posts`)).toHaveLength(0);
  const press = backend.callsTo('POST', `${base}/approvals`)[0]!.body;
  expect(press).toEqual({ operation: 'cafe.post', targetRef: '31000001:7', expectedRevision: 4, stage: 'press',
    command: { clubid: '31000001', menuid: '7', subject: '동네 플리마켓 안내', text: '토요일 2시에 열려요.\n함께해요' } });
  const post = within(confirm).getByRole('button', { name: '카페에 글 올리기' });
  fireEvent.click(post);
  fireEvent.click(post);
  expect(await screen.findByText(/카페에 글을 올렸어요/)).toBeInTheDocument();
  expect(log).toEqual(['card:cafe.post:press', 'card:cafe.post:confirm', 'action:cafe.post']);
  const sent = backend.callsTo('POST', `${base}/community/cafe-posts`);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers.get('idempotency-key')).toBe('navis:a0000000-0000-4000-8000-000000000001');
  expect(sent[0]!.body).toEqual({ clubid: '31000001', menuid: '7', subject: '동네 플리마켓 안내', text: '토요일 2시에 열려요.\n함께해요' });
  expect(screen.getAllByRole('link', { name: /글 보기/ })[0]).toHaveAttribute('href', article);
  expect(screen.getByText('올린 글을 고치거나 지우려면 카페에서 해 주세요')).toBeInTheDocument();
  // The writer is ready for a new post: empty, without validation errors, and nothing more was sent.
  expect(screen.getByRole('textbox', { name: /제목/ })).toHaveValue('');
  expect(screen.queryByText('제목을 넣어 주세요')).toBeNull();
  await waitFor(() => expect(screen.getByRole('list', { name: '올린 글' })).toHaveTextContent('동네 플리마켓 안내'));
  expect(within(screen.getByRole('list', { name: '올린 글' })).getByText('올렸어요')).toBeInTheDocument();
  // A new session reads the same post back from the service.
  cleanup();
  open(backend);
  expect(await screen.findByRole('list', { name: '올린 글' })).toHaveTextContent('동네 플리마켓 안내');
});

it('names several boards by order, hides the writer without a board, and locks an unknown outcome instead of posting again', async () => {
  const many = setup([board, { clubid: '31000001', menuid: '9' }]);
  open(many.backend);
  expect(await screen.findByRole('radio', { name: '게시판 2' })).toBeInTheDocument();
  expect(screen.queryByText('31000001')).toBeNull();
  cleanup();
  const none = setup([]);
  open(none.backend);
  expect(await screen.findByText('글을 쓸 수 있는 카페 게시판이 없어요')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '올릴 내용 확인하기' })).toBeNull();
  cleanup();
  const lost = setup();
  lost.backend.on('POST', `${base}/community/cafe-posts`, () => { throw new TypeError('network down'); });
  open(lost.backend);
  fireEvent.change(await screen.findByRole('textbox', { name: /제목/ }), { target: { value: '공지' } });
  fireEvent.change(screen.getByRole('textbox', { name: '본문' }), { target: { value: '안녕하세요' } });
  fireEvent.click(screen.getByRole('button', { name: '올릴 내용 확인하기' }));
  fireEvent.click(await screen.findByRole('button', { name: '카페에 글 올리기' }));
  expect(await screen.findByText(/올린 결과를 확인해 주세요/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '카페에 글 올리기' })).toBeNull();
  expect(screen.queryByRole('button', { name: '올릴 내용 확인하기' })).toBeNull();
});

// FIX-PKG-C T-18 (W22-H5): the tab the owner was on comes back when the window is reopened without a requested view (a Navis card's view still wins).
it('reopens on the tab the owner left, and a requested view still wins', async () => {
  const { backend } = setup();
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'local' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify: vi.fn(), acknowledgeBriefing() {} };
  const Detail = widgets.find(widget => widget.id === 'community')!.Detail!;
  const mount = (view?: string) => renderWithKit(<Detail featureId="community" condition={{ kind: 'default' }} detailRef={{ featureId: 'community', ...(view ? { view } : {}) }} host={host} />, { modules: widgets, store });
  mount();
  fireEvent.click(await screen.findByRole('tab', { name: '카페 글쓰기' }));
  expect(screen.getByRole('tab', { name: '카페 글쓰기' })).toHaveAttribute('aria-selected', 'true');
  cleanup();
  mount();
  expect(await screen.findByRole('tab', { name: '카페 글쓰기' })).toHaveAttribute('aria-selected', 'true');
  cleanup();
  mount('browse');
  expect(await screen.findByRole('tab', { name: '동네 둘러보기' })).toHaveAttribute('aria-selected', 'true');
});
