/** FIX-RV3 (RV-REALVERIFY-3 and -4): the inbox widget keeps its original two-column layout in HTTP mode, and one rule counts what waits for a reply. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { TODAY, addDays } from '../../../data/db/time';
import { createRealPort } from '../../../data/reality/00';
import { reply } from '../../../data/reality/00/testing';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { ids, reviewInsights, service } from '../../../data/reality/15/testing';
import { loaded, openWidget, plain, structure } from './parity-harness';
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
  expect(screen.getByRole('heading', { name: '내 답글' })).toBeInTheDocument();
  expect(screen.getByText('감사합니다')).toBeInTheDocument();
  fireEvent.click(row);
  const pane = row.closest('.ui-master-detail')!.querySelector('.ui-master-detail__detail') as HTMLElement;
  expect(within(pane).getByText('창가 자리가 조용해서 좋았어요')).toBeInTheDocument();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  fireEvent.click(within(pane).getByRole('button', { name: '답글 쓰기' }));
  await waitFor(() => expect(backend.callsTo('POST', '/marketing/inquiries')).toHaveLength(1));
  expect(backend.callsTo('POST', '/marketing/inquiries')[0]!.body).toEqual({ source: 'review', providerRef: 'rv-2' });
});

it('shows the consultation waiting for a reply under the messages tab', async () => {
  const { backend } = backendWithImports();
  open(backend, 'Detail');
  const row = await screen.findByRole('button', { name: /톡톡 상담/ });
  expect(row.closest('.ui-master-detail__list')).toBeInTheDocument();
  expect(row).not.toHaveTextContent('tt-2');
  expect(screen.queryByText(/톡톡 상담 tt-3|톡톡 상담 tt-4/)).toBeNull();
});


/* PAR-3 (D-384, D-355): the example (fixture) 메시지·리뷰 응대 and the real one are the same screen — tabs, toolbar, statistics tab, praise filter, add-inquiry form. */
function realInbox(options: { readonly stars?: number | null; readonly emptyStats?: boolean } = {}) {
  const made = service();
  made.backend.on('GET', '/marketing/reviews', () => ({ items: [{ ref: 'rv-1', text: '커피가 맛있어요', keywords: [], media: [], stars: options.stars === undefined ? 5 : options.stars, reply: null, hasReply: false }], authorNotification: '답글을 올리면 리뷰 작성자에게 알림이 가요.' }));
  made.backend.on('GET', '/insight/review-insights', () => reviewInsights({ empty: options.emptyStats ?? true }));
  made.backend.on('GET', '/marketing/talktalk/consultations/tt-1', () => ({ ref: 'tt-1', status: 'waiting', messages: [{ text: '일요일에도 문 여나요?', from: 'user' }] }));
  return made.backend;
}

async function detailOf(mode: 'example' | 'real', view?: 'review' | 'stats') {
  const detailRef = view ? { view } : undefined;
  const opened = mode === 'example' ? openWidget('ai-response', 'Detail', 'example', { detailRef }) : openWidget('ai-response', 'Detail', 'real', { backend: realInbox(), domain: 'inbox', detailRef });
  await loaded(opened.container);
  await screen.findByRole('tab', { name: '리뷰 AI 통계' });
  await new Promise(resolve => setTimeout(resolve, 60));
  return opened;
}

it('parity: the add action is in the summary toolbar and shop guidance stays in a draft', async () => {
  for (const view of [undefined, 'review', 'stats'] as const) {
    const example = await detailOf('example', view);
    const a = structure(example.container);
    const exampleText = plain(example.container);
    expect(example.container.querySelector('.mkt-add-toolbar')?.lastElementChild).toHaveTextContent('문의 직접 적기');
    cleanup();
    const real = await detailOf('real', view);
    const b = structure(real.container);
    expect(real.container.querySelector('.mkt-add-toolbar')?.lastElementChild).toHaveTextContent('문의 직접 적기');
    expect(a.tabs, String(view)).toEqual(['메시지', '리뷰', '리뷰 AI 통계']);
    expect(b.tabs).toEqual(a.tabs);
    expect(a.buttons[0]).toBe('문의 직접 적기');
    expect(b.buttons[0]).toBe('문의 직접 적기');
    expect(a.sections).not.toContain('매장 안내');
    expect(b.sections).not.toContain('매장 안내');
    if (view === 'stats') {
      expect(a.sections).not.toContain('초안에 쓴 매장 안내');
      expect(b.sections).not.toContain('초안에 쓴 매장 안내');
    }
    expect(exampleText).toMatch(/^답변 대기 \d+건 · 메시지 \d+ · 리뷰 \d+/);
    expect(plain(real.container)).toMatch(/^답변 대기 \d+건 · 메시지 \d+ · 리뷰 \d+/);
    cleanup();
  }
});

it.each([
  [undefined, '답변 초안', '톡톡으로 답변 보내기'],
  ['review', '답글 초안', '답글 올리기'],
] as const)('parity: the %s reply pane has the same draft and reply buttons in both modes', async (view, label, reply) => {
  for (const mode of ['example', 'real'] as const) {
    const { container } = await detailOf(mode, view);
    const pane = within(container.querySelector<HTMLElement>('.ui-master-detail__detail')!);
    expect(pane.getByRole('textbox', { name: label })).toBeInTheDocument();
    const footerElement = container.querySelector<HTMLElement>('.mkt-reply-footer')!;
    const footer = within(footerElement);
    const editor = footerElement.querySelector('.mkt-reply-footer__editor');
    const tips = footerElement.querySelector('.mkt-reply-footer__tips');
    const actions = footerElement.querySelector('.mkt-reply-footer__actions');
    expect(editor).toContainElement(footer.getByRole('textbox', { name: label }));
    expect(editor?.nextElementSibling).toBe(tips);
    expect(tips?.nextElementSibling).toBe(actions);
    expect(actions).toContainElement(footer.getByRole('button', { name: reply }));
    expect(within(actions as HTMLElement).getAllByRole('button').map(button => button.textContent)).toEqual(['초안 저장하기', reply]);
    const navis = footer.getByRole('button', { name: 'Navis로 초안 쓰기' });
    expect(editor).toContainElement(navis);
    expect(navis.querySelector('img')).toBeInTheDocument();
    expect(pane.getAllByRole('button', { name: 'Navis로 초안 쓰기' })).toHaveLength(1);
    expect(Boolean(pane.queryByRole('button', { name: '쿠폰 붙이기' }))).toBe(view === undefined);
    expect(pane.queryByRole('button', { name: /^(답변 초안 만들기|답글 초안 만들기|보낼 내용 확인하기|테스트 문자 보내기)$/ })).toBeNull();
    cleanup();
  }
});

it.each([
  ['message', ids.manual, '답변 초안', '답변을 마쳤다고 기록하기'],
  ['review', ids.review, '답글 초안', '답글 올리기'],
] as const)('previews the selected %s beside the editor without saving or replying in either mode', async (type, realId, label, send) => {
  const original = createWidgetDataStore().getSnapshot().tables;
  const thread = original.inquiryThread.find(row => row.type === type && row.status === 'waiting')!;
  const inquiryText = '매장 주소를 알려 주세요.';
  const example = createWidgetDataStore({ inquiryThread: [{ ...thread, type, bodyRaw: inquiryText, needsPersonReason: null,
    channelKey: type === 'review' ? 'data.channel.naverReview' : 'data.real.inbox.channel.manualMessage' }] });
  const backend = realInbox();
  const fact = '매장 주소는 상도로 1입니다.';
  const path = `/marketing/inquiries/${realId}/navis-draft-preview`;
  backend.on('POST', path, () => ({ source: 'navis', text: `안녕하세요.\n${fact}\n감사합니다.`, facts: [fact] }));
  for (const mode of ['example', 'real'] as const) {
    const detailRef = { itemId: mode === 'example' ? thread.threadId : realId, ...(type === 'review' && { view: 'review' }) };
    if (mode === 'example') openWidget('ai-response', 'Detail', mode, { store: example, detailRef });
    else openWidget('ai-response', 'Detail', mode, { backend, domain: 'inbox', detailRef });
    fireEvent.click(await screen.findByRole('button', { name: 'Navis로 초안 쓰기' }));
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: label });
    await waitFor(() => expect(editor.value).toContain('매장 주소는'));
    expect(screen.getByRole('region', { name: '초안에 쓴 매장 안내' })).toHaveTextContent('매장 주소는');
    expect(screen.getByRole('button', { name: send })).toBeDisabled();
    expect(example.getSnapshot().tables.inquiryThread[0]?.replyDraft).toBe(thread.replyDraft);
    cleanup();
  }
  expect(backend.calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual([path]);
});

it('previews the selected TalkTalk inquiry and sends one body with the chosen active Navis coupon on the owner’s press', async () => {
  const backend = realInbox();
  const day = '2026-11-21';
  const code = { codeId: 'code', route: 'place_news', activated: true, unpublishedAt: null, code: 'NAVIS25', issueCount: 10, used: 1 };
  const active = { couponId: 'active', name: '당일 커피 쿠폰', status: 'active', startsOn: day, endsOn: '2026-11-26', benefitType: 'percent', benefitValue: 25, codes: [code] };
  backend.on('GET', '/marketing/coupons', () => ({ items: [active,
    { ...active, couponId: 'paused', status: 'paused', name: '멈춘 쿠폰' },
    { ...active, couponId: 'ended', endsOn: '2026-11-20', name: '만료된 쿠폰' },
    { ...active, couponId: 'individual', codes: [{ ...code, route: 'sms' }], name: '개인 문자 쿠폰' },
  ], businessDate: day, nextCursor: null, sourceRevision: 1, asOf: `${day}T05:00:00Z` }));
  backend.on('GET', '/marketing/naver-coupons', () => ({ placeCoupons: { items: [{ name: '네이버 전용 쿠폰' }] } }));
  const path = `/marketing/inquiries/${ids.talk}`;
  const hours = '일요일 영업시간은 10:00~20:30입니다.';
  const draft = `안녕하세요.\n${hours}\n감사합니다.`;
  backend.on('POST', `${path}/navis-draft-preview`, () => ({ source: 'navis', text: draft, facts: [hours] }));
  openWidget('ai-response', 'Detail', 'real', { backend, domain: 'inbox' });
  fireEvent.click(await screen.findByRole('button', { name: 'Navis로 초안 쓰기' }));
  const editor = await screen.findByRole('textbox', { name: '답변 초안' });
  await waitFor(() => expect(editor).toHaveValue(draft));
  const guidance = within(screen.getByRole('region', { name: '초안에 쓴 매장 안내' }));
  expect(guidance.getAllByRole('listitem').map(line => line.textContent)).toEqual([hours]);
  fireEvent.click(screen.getByRole('button', { name: '쿠폰 붙이기' }));
  const picker = within(await screen.findByRole('group', { name: '쿠폰 붙이기' }));
  expect((await picker.findAllByRole('button')).map(button => button.textContent)).toEqual(['당일 커피 쿠폰']);
  expect(backend.callsTo('GET', '/marketing/naver-coupons')).toHaveLength(0);
  fireEvent.click(picker.getByRole('button', { name: '당일 커피 쿠폰' }));
  expect(editor).toHaveValue(`${draft}\n\n당일 커피 쿠폰\n혜택: 25% 할인\n사용 기한: 2026-11-26\n쿠폰 코드: NAVIS25`);
  expect(guidance.getAllByRole('listitem').map(plain)).toEqual([hours, '붙인 쿠폰 · 당일 커피 쿠폰 · 25% 할인 · 2026-11-26 · NAVIS25']);
  expect(backend.callsTo('POST', `${path}/reply`)).toHaveLength(0);
  expect(backend.callsTo('PATCH', `${path}/draft`)).toHaveLength(0);
  const send = screen.getByRole('button', { name: '톡톡으로 답변 보내기' });
  fireEvent.click(send);
  fireEvent.click(send);
  await waitFor(() => expect(backend.callsTo('POST', `${path}/reply`)).toHaveLength(1));
  await screen.findByText(/쿠폰 코드: NAVIS25/);
});

it('keeps the owner’s editor text when the preview cannot be grounded', async () => {
  const backend = realInbox();
  backend.on('POST', `/marketing/inquiries/${ids.talk}/navis-draft-preview`, () => reply(422, { code: 'DRAFT_UNGROUNDED' }));
  openWidget('ai-response', 'Detail', 'real', { backend, domain: 'inbox' });
  const editor = await screen.findByRole('textbox', { name: '답변 초안' });
  fireEvent.change(editor, { target: { value: '제가 확인하겠습니다.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Navis로 초안 쓰기' }));
  expect(await screen.findByText('초안을 만들지 못했어요. 쓰던 글은 그대로 있어요')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: '초안에 쓴 매장 안내' })).getByText('매장 정보에서 이 문의에 답할 근거를 확인하지 못했어요')).toBeInTheDocument();
  expect(editor).toHaveValue('제가 확인하겠습니다.');
  expect(backend.callsTo('POST', `/marketing/inquiries/${ids.talk}/reply`)).toHaveLength(0);
});

it('uses the same picker and editor with fixture hours and a local public coupon without a network request', async () => {
  const original = createWidgetDataStore().getSnapshot().tables;
  const thread = original.inquiryThread.find(row => row.type === 'message' && row.status === 'waiting')!;
  const coupon = original.marketing.coupon.find(row => row.status === 'active')!;
  const code = original.marketing.couponCode.find(row => row.couponId === coupon.couponId)!;
  const store = createWidgetDataStore({ inquiryThread: [{ ...thread, channelKey: 'data.channel.naverTalk',
    bodyRaw: '일요일에도 문 여나요?', needsPersonReason: null }], marketing: { ...original.marketing,
    coupon: [{ ...coupon, name: { raw: '예시 커피 쿠폰' }, startsOn: TODAY, endsOn: addDays(TODAY, 3) }],
    couponCode: [{ ...code, route: 'place_news' }], couponRedemptionAgg: [] } });
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    openWidget('ai-response', 'Detail', 'example', { store });
    fireEvent.click(await screen.findByRole('button', { name: 'Navis로 초안 쓰기' }));
    const editor = screen.getByRole('textbox', { name: '답변 초안' });
    const hours = '일요일 영업시간은 10:00~20:30입니다.';
    await waitFor(() => expect(editor).toHaveValue(`안녕하세요.\n${hours}\n감사합니다.`));
    const guidance = within(screen.getByRole('region', { name: '초안에 쓴 매장 안내' }));
    expect(guidance.getAllByRole('listitem').map(line => line.textContent)).toEqual([hours]);
    fireEvent.click(screen.getByRole('button', { name: '쿠폰 붙이기' }));
    const picker = within(screen.getByRole('group', { name: '쿠폰 붙이기' }));
    fireEvent.click(picker.getByRole('button', { name: '예시 커피 쿠폰' }));
    expect(String((editor as HTMLTextAreaElement).value)).toContain(`쿠폰 코드: ${code.code}`);
    expect(guidance.getAllByRole('listitem').map(plain)).toEqual([hours, `붙인 쿠폰 · 예시 커피 쿠폰 · 1,000원 할인 · ${addDays(TODAY, 3)} · ${code.code}`]);
    expect(store.getSnapshot().tables.inquiryThread[0]?.status).toBe('waiting');
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it('parity: the statistics tab has the same unit control, average line, source line, two-day lag note and empty sentence in both modes', async () => {
  const example = await detailOf('example', 'stats');
  const a = structure(example.container);
  const exampleText = plain(example.container);
  cleanup();
  const real = await detailOf('real', 'stats');
  expect(structure(real.container)).toEqual(a);
  expect(a.buttons).toEqual(['문의 직접 적기', '일별', '주별', '월별']);
  expect(a.fields).toEqual(['통계 기간']);
  for (const text of [exampleText, plain(real.container)]) {
    expect(text).toMatch(/평균 별점 \d\.\d/);
    expect(text).toMatch(/출처: 네이버 리뷰 AI 통계 · /);
    expect(text).toContain('이틀 전까지의 자료예요');
  }
});

it('parity: the review tab has the praise filter and the average line in both modes, and the filter keeps only praise', async () => {
  for (const mode of ['example', 'real'] as const) {
    const opened = await detailOf(mode, 'review');
    const chip = screen.getByRole('checkbox', { name: '칭찬 리뷰만 보기' });
    expect(plain(opened.container)).toMatch(/평균 별점 \d\.\d/);
    fireEvent.click(chip);
    const rows = opened.container.querySelectorAll('[data-slot="ai-response.list.row"]');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.textContent).toMatch(/긍정|별점 [45]/);
    cleanup();
  }
});

it('parity: the panel shows the praise count line in both modes', async () => {
  const example = openWidget('ai-response', 'Panel', 'example', { panel: { shape: 'L', width: 4, height: 4 } });
  await loaded(example.container);
  expect(plain(example.container)).toMatch(/칭찬 리뷰 \d+건/);
  cleanup();
  const real = openWidget('ai-response', 'Panel', 'real', { backend: realInbox(), domain: 'inbox', panel: { shape: 'L', width: 4, height: 4 } });
  await loaded(real.container);
  expect(plain(real.container)).toMatch(/칭찬 리뷰 1건/);
});

it('record by hand: the same form in both modes; in the example data the new record joins the list, opens, and a bad source address is refused', async () => {
  const form = async (mode: 'example' | 'real') => {
    const opened = await detailOf(mode);
    fireEvent.click(screen.getByRole('button', { name: '문의 직접 적기' }));
    const el = screen.getByRole('form', { name: '문의 직접 적기' });
    const result = { fields: [...el.querySelectorAll('input, textarea')].map(node => node.getAttribute('name') ?? node.getAttribute('type')), chips: [...el.querySelectorAll('[role="radio"], .ui-choice-chip')].map(chip => chip.textContent), buttons: [...el.querySelectorAll('button')].map(button => button.textContent) };
    void opened;
    cleanup();
    return result;
  };
  const example = await form('example');
  expect(await form('real')).toEqual(example);
  expect(example.chips).toEqual(['문의', '리뷰']);

  const opened = await detailOf('example');
  fireEvent.click(screen.getByRole('button', { name: '문의 직접 적기' }));
  fireEvent.change(screen.getByRole('textbox', { name: /^제목/ }), { target: { value: '단체 주문 문의' } });
  fireEvent.change(screen.getByRole('textbox', { name: /^받은 내용/ }), { target: { value: '내일 아메리카노 20잔 가능한가요?' } });
  fireEvent.change(screen.getByRole('textbox', { name: /^네이버 원문 링크/ }), { target: { value: 'https://example.com/x' } });
  expect(screen.getByText(/^네이버 주소\(https/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: /^네이버 원문 링크/ }), { target: { value: '' } });
  fireEvent.submit(screen.getByRole('form', { name: '문의 직접 적기' }));
  await waitFor(() => expect(opened.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.real.inbox.inquiryRecorded' })));
  const row = (await screen.findAllByText(/내일 아메리카노 20잔 가능한가요\?/)).length;
  expect(row).toBeGreaterThan(0);
  const created = opened.store.getSnapshot().tables.inquiryThread.find(th => th.bodyRaw === '내일 아메리카노 20잔 가능한가요?');
  expect(created).toMatchObject({ type: 'message', status: 'waiting', title: '단체 주문 문의', channelKey: 'data.real.inbox.channel.manualMessage' });
});

it('shows draft guidance only after entering a draft', async () => {
  await detailOf('real');
  expect(screen.queryByRole('heading', { name: '초안에 쓴 매장 안내' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: '답변 초안' }), { target: { value: '안녕하세요' } });
  expect(screen.getByRole('heading', { name: '초안에 쓴 매장 안내' })).toBeInTheDocument();
});
