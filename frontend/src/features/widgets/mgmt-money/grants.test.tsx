import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectWidget, TODAY } from '../../../data/widget-data';
import { addDays } from '../../../data/db/time';
import type { WidgetHost } from '../../../contracts';
import { GrantsDetail, GrantsPanel } from './grants';
import { applicationId, grant, insight, insightSession, noticeId, updatedAt } from '../../../data/reality/11/testing';
import { manualsGrantsDomain } from '../../assistant/domains/manuals-grants';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const detail = <GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />;
const widgetStyles = readFileSync('src/features/widgets/mgmt-money/widget.css', 'utf8');

it('shows a reason chip and sorts open grants by match tier then deadline', async () => {
 const { collections, newStore } = insightSession();
 const row = (id: string, title: string, matchTier: 'exact' | 'related', deadline: string, startsOn = TODAY) =>
  ({ ...grant, id, title, matchTier, startsOn, deadline, matchReason: matchTier === 'exact' ? '서울 · 카페' : '서울 · 소상공인' });
 collections.set('grant-notices', [
  row('late', '늦은 마감 사업', 'related', addDays(TODAY, 6)),
  row('next', '접수 예정 사업', 'exact', addDays(TODAY, 3), addDays(TODAY, 1)),
  row('soon', '빠른 마감 사업', 'related', addDays(TODAY, 2)),
  row('exact', '프로필 일치 사업', 'exact', addDays(TODAY, 9)),
 ]);
 const { container } = renderWithKit(detail, { store: newStore() });
 const exact = await screen.findByRole('button', { name: /프로필 일치 사업/ });
 expect(within(exact).getByText('서울 · 카페').closest('.ui-status-chip')).toBeVisible();
 const list = container.querySelector('[data-slot="grants.list"]')!;
 expect(within(list as HTMLElement).getAllByRole('button').map(button => button.querySelector('strong')?.textContent))
  .toEqual(['프로필 일치 사업', '빠른 마감 사업', '늦은 마감 사업', '접수 예정 사업']);
});

it('links the empty dashboard to the notice form without requesting a refresh', async () => {
 const { backend, newStore } = insightSession();
 const openDetail = vi.fn();
 renderWithKit(<GrantsPanel featureId="grants" shape="Q" presetId="A" editing={false} width={1} height={1} condition={{ kind: 'default' }} host={{ ...host, openDetail }} />, { store: newStore() });
 expect(await screen.findByText('확인할 지원사업이 없어요')).toBeVisible();
 await userEvent.click(screen.getByRole('button', { name: /공고 불러오기/ }));
 expect(openDetail).toHaveBeenCalledWith({ featureId: 'grants', view: 'notices', focus: 'action' });
 expect(backend.callsTo('POST', `${insight}/grant-notices/sync`)).toHaveLength(0);
});

it('uses the saved business type and asks for a region before importing notices', async () => {
 const { backend, newStore } = insightSession();
 const store = newStore();
 const transaction = { transactionId: 'grant-shop-type', runId: store.getSnapshot().runId!, expectedDataRevision: store.getSnapshot().revision, expectedRunRevision: 0, transitionToken: 'grant-shop-type' };
 const prepared = store.session.prepare(transaction, { type: 'shop.updateSettings', businessType: 'restaurant', paymentStyle: 'prepaid', tableLayout: null });
 if (!prepared.ok) throw new Error(prepared.reason);
 store.session.publish(prepared.change);
 store.session.flush(transaction.transactionId);
 renderWithKit(detail, { store });
 await userEvent.click(await screen.findByRole('button', { name: '공고 불러오기' }));
 expect(screen.getByRole('textbox', { name: '업종' })).toHaveValue('음식점');
 expect(screen.getByRole('textbox', { name: '지역' })).toHaveAccessibleDescription('매장이 있는 지역을 넣어 주세요');
 expect(screen.getByRole('button', { name: '공고 불러오기' })).toBeDisabled();
 expect(backend.callsTo('POST', `${insight}/grant-notices/sync`)).toHaveLength(0);
});

it('keeps the official notice period and records a historical application in Insight', async () => {
 const { backend, collections, newStore } = insightSession();
 collections.set('grant-notices', [grant]);
 backend.on('POST', `${insight}/grant-applications`, () => {
  collections.set('grant-applications', [{ id: applicationId, noticeId, title: grant.title, source: 'owner', status: 'applied', appliedOn: TODAY, receiptNumber: null, resultMemo: null, updatedAt, revision: 1 }]);
  return { resourceId: applicationId, receiptId: 'application-receipt', revision: 1, affectedSources: ['grants', 'briefing'] };
 });
 const store = newStore();
 const user = userEvent.setup();
 renderWithKit(detail, { store });
 const official = await screen.findByRole('link', { name: '공식 공고 열기' });
 expect(official).toHaveAttribute('href', grant.officialUrl);
 expect(screen.getByText('기업마당')).toBeVisible();
 expect(screen.getByText('9/30(금)')).toBeVisible();
 const clipboard = vi.spyOn(navigator.clipboard, 'writeText');
 await user.click(screen.getByRole('tab', { name: '신청서 초안' }));
 await user.click(screen.getByRole('button', { name: '초안 복사하기' }));
 expect(clipboard).toHaveBeenCalledWith(`${grant.title}\n${grant.agency}\n${grant.officialUrl}\n\n`);
 await user.click(screen.getByRole('tab', { name: '사업 목록' }));
 expect(backend.callsTo('POST', `${insight}/grant-applications`)).toHaveLength(0);
 await user.click(screen.getByRole('button', { name: '신청 완료로 표시하기' }));
 await user.click(screen.getByRole('tab', { name: '지원 현황' }));
 const grid = await screen.findByRole('grid', { name: '지원 현황' });
 expect(await within(grid).findByText(grant.title)).toBeVisible();
 expect(backend.callsTo('POST', `${insight}/grant-applications`)[0]?.body).toEqual({ noticeId });
 expect(store.getSnapshot().tables.grantApplication[0]).toMatchObject({ applicationId, source: 'owner' });
});

it('projects known dates without a time, skips unknown deadlines, and keeps a historical application name in Navis', async () => {
 const { collections, newStore } = insightSession();
 collections.set('grant-notices', [grant, { ...grant, id: 'unknown-date', deadline: null }]);
 collections.set('grant-applications', [{ id: applicationId, noticeId: 'archived-notice', title: '예전에 신청한 지원', source: 'owner', status: 'applied', appliedOn: TODAY, receiptNumber: null, resultMemo: null, updatedAt, revision: 1 }]);
 const store = newStore();
 await store.real!.load('manuals');
 const projection = manualsGrantsDomain.projectWidget(store.getSnapshot(), 'grants', { kind: 'default' }, 'ko');
 if (!projection || !('facts' in projection)) throw new Error('Missing Navis grant facts');
 const { facts } = projection;
 expect(facts).toContainEqual(expect.objectContaining({ key: `grants.notice.${noticeId}.deadline`, value: '2022-09-30', source: '기업마당' }));
 expect(facts.find(fact => fact.key === `grants.notice.${noticeId}.deadline`)?.display).not.toContain('23:59');
 expect(facts.some(fact => fact.key === 'grants.notice.unknown-date.deadline')).toBe(false);
 expect(facts).toContainEqual(expect.objectContaining({ key: `grants.application.${applicationId}.status`, label: '예전에 신청한 지원', source: '사장님 기록' }));
});

it.each([{ locale: 'ko', label: '마감' }, { locale: 'en', label: 'Deadline' }] as const)(
 'places the $label facts beside their labels in $locale', ({ locale, label }) => {
  const { container } = renderWithKit(<><style>{widgetStyles}</style>{detail}</>, { locale });
  const facts = container.querySelector('[data-slot="grants.item"] dl')!;
  const labels = Array.from(facts.querySelectorAll('dt'), term => term.textContent);
  expect(labels[2]).toBe(label);
  expect(getComputedStyle(facts).gap).toBe('var(--space-3)');
  for (const row of facts.children) {
   const style = getComputedStyle(row);
   expect(style.display).toBe('grid');
   expect(style.gridTemplateColumns).toBe('calc(var(--space-6) * 5) minmax(0, 1fr)');
   expect(getComputedStyle(row.querySelector('dd')!).textAlign).toBe('start');
  }
 },
);

it('has a visually hidden 지우기 heading above application row actions (the screen never says 삭제)', async () => {
 renderWithKit(<><style>{widgetStyles}</style>{detail}</>);
 await userEvent.click(screen.getByRole('tab', { name: '지원 현황' }));
 const grid = screen.getByRole('grid', { name: '지원 현황' });
 const heading = within(grid).getByRole('columnheader', { name: '지우기' });
 expect(getComputedStyle(within(heading).getByText('지우기')).clipPath).toBe('inset(50%)');
 expect(within(grid).queryByText('삭제')).toBeNull();
 expect(within(grid).getByRole('columnheader', { name: '선정 및 지원 결과' })).toBeInTheDocument();
});

it('applies, deletes and restores a grant application', async () => {
 const store = createWidgetDataStore();
 renderWithKit(<GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />, { store, textScale: 125, reducedMotion: true });
 const before = store.getSnapshot().tables.grantApplication.length;
 const programName = document.querySelector('[data-slot="grants.item"] h3')!.textContent!;
 await userEvent.click(screen.getByRole('button', { name: '신청 완료로 표시하기' }));
 expect(store.getSnapshot().tables.grantApplication).toHaveLength(before + 1);
 // the toast names the program (SCR-223)
 expect(host.notify).toHaveBeenLastCalledWith(expect.objectContaining({ messageKey: 'data.management.notice.grantApplied', params: { name: programName } }));
 await userEvent.click(screen.getByRole('tab', { name: '지원 현황' }));
 const row = screen.getByText(programName).closest('tr') as HTMLElement;
 // today's application: a status chip, and the applied date as 11/17(화), never ISO
 const [, month, day] = TODAY.split('-');
 expect(within(row).getByText(new RegExp(`^${Number(month)}/${Number(day)}\\(`))).toBeInTheDocument();
 expect(row.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
 expect(within(row).getByText('신청함').closest('.ui-status-chip')).toHaveAttribute('data-semantic', 'info');
 await userEvent.click(screen.getAllByRole('button', { name: '신청 기록 지우기' })[0]!);
 expect(store.getSnapshot().tables.grantApplication).toHaveLength(before + 1);
 await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '신청 기록 지우기' }));
 expect(store.getSnapshot().tables.grantApplication).toHaveLength(before);
 const notice = vi.mocked(host.notify).mock.calls.at(-1)?.[0];
 expect(notice?.undoToken).toBeTruthy();
 expect(store.undo(notice!.undoToken!).ok).toBe(true);
 expect(store.getSnapshot().tables.grantApplication).toHaveLength(before + 1);
});
it('offers application status in a keyboard-navigable grid', async () => {
 renderWithKit(<GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />, { reducedMotion: true, textScale: 125 });
 await userEvent.click(screen.getByRole('button', { name: '신청 완료로 표시하기' }));
 await userEvent.click(screen.getByRole('tab', { name: '지원 현황' }));
 const grid = screen.getByRole('grid', { name: '지원 현황' });
 const tabStops = Array.from(grid.querySelectorAll<HTMLElement>('[tabindex="0"]'));
 expect(tabStops).toHaveLength(1);
 tabStops[0]!.focus();
 await userEvent.keyboard('{ArrowRight}');
 expect(document.activeElement).not.toBe(tabStops[0]);
});
it('keeps all three tabs usable in the empty example, each with a sentence and its next action', async () => {
 renderWithKit(<GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />, { preview: { family: 'empty', overrides: {} } });
 expect(screen.getByText('기업마당 공고가 없어요')).toBeInTheDocument();
 expect(screen.getByText('새 공고가 올라오면 이 목록에 보여 드려요')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: '지원 현황 보기' }));
 expect(screen.getByRole('tab', { name: '지원 현황' })).toHaveAttribute('aria-selected', 'true');
 expect(screen.getByText('아직 신청한 사업이 없어요')).toBeInTheDocument();
 expect(screen.getByText('사업 목록에서 신청 완료로 표시하면 여기에 쌓여요')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('tab', { name: '신청서 초안' }));
 expect(screen.getByText('초안을 만들 자료가 없어요')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: '사업 목록 보기' }));
 expect(screen.getByRole('tab', { name: '사업 목록' })).toHaveAttribute('aria-selected', 'true');
});
it('offers the program list from the empty application table without adding a tab stop to the grid', async () => {
 renderWithKit(detail, { reducedMotion: true });
 await userEvent.click(screen.getByRole('tab', { name: '지원 현황' }));
 const grid = screen.getByRole('grid', { name: '지원 현황' });
 expect(within(grid).getByText('아직 신청한 사업이 없어요')).toBeInTheDocument();
 expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
 await userEvent.click(screen.getByRole('button', { name: '사업 목록 보기' }));
 expect(screen.getByRole('tab', { name: '사업 목록' })).toHaveAttribute('aria-selected', 'true');
});
const draftBody = '신청 목적\n예시 카페의 운영 자금에 활용하려고 해요.\n지원 금액: 확인 필요';
const draftResponse = () => Response.json({
 draftId: 'draft-1', kind: 'application', content: { body: draftBody }, sourceLabels: ['예시 지원 공고'],
});

// The cafe seed's programs, from the selector the widget reads (the draft list shows them in this order).
const programs = () => {
 const view = selectWidget(createWidgetDataStore().getSnapshot(), 'grants', { kind: 'default' }, 'normal');
 if (view.status !== 'ready') throw new Error('Grants fixture must be available');
 return view.model.notices;
};

function openDraft() {
 renderWithKit(detail, { textScale: 125 });
 fireEvent.click(screen.getByRole('tab', { name: '신청서 초안' }));
}

it('loads once per action, shows sources and checks, and copies the exact edit', async () => {
 const user = userEvent.setup();
 const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
 let resolve!: (response: Response) => void;
 const transport = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
 vi.spyOn(globalThis, 'fetch').mockImplementation(transport);
 openDraft();
 fireEvent.click(document.querySelectorAll<HTMLElement>('.mm-grant-draft-list .mm-select-row')[1]!);
 const generate = screen.getByRole('button', { name: '신청서 초안 만들기' });
 const copy = screen.getByRole('button', { name: '초안 복사하기' });
 expect(copy).toBeDisabled();
 fireEvent.click(generate);
 fireEvent.click(generate);
 expect(screen.getByText('초안을 만들고 있어요')).toHaveAttribute('role', 'status');
 expect(generate).toBeDisabled();
 expect(copy).toBeDisabled();
 expect(transport).toHaveBeenCalledTimes(1);
 expect(transport).toHaveBeenCalledWith('/api/navis/widget-drafts', expect.objectContaining({ body: JSON.stringify({ widget: 'grants', sampleId: programs()[1]!.noticeId }) }));
 resolve(draftResponse());
 const editor = await screen.findByRole('textbox', { name: '신청서 초안' });
 await waitFor(() => expect(editor).toHaveValue(draftBody));
 expect(screen.getByText('예시 지원 공고')).toBeVisible();
 expect(screen.getByText('확인 필요')).toBeVisible();
 fireEvent.change(editor, { target: { value: '고친 신청서\n지원 금액: 확인 필요' } });
 await user.click(copy);
 expect(writeText).toHaveBeenCalledWith('고친 신청서\n지원 금액: 확인 필요');
 expect(screen.getByText('복사했어요')).toBeVisible();
});

it('keeps edits on failure, retries explicitly, and opens a blank editor without a notice', async () => {
 const transport = vi.fn().mockResolvedValueOnce(draftResponse())
  .mockResolvedValueOnce(Response.json({ code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '12' } }))
  .mockResolvedValueOnce(draftResponse());
 vi.spyOn(globalThis, 'fetch').mockImplementation(transport);
 openDraft();
 const generate = screen.getByRole('button', { name: '신청서 초안 만들기' });
 fireEvent.click(generate);
 const editor = await screen.findByRole('textbox', { name: '신청서 초안' });
 fireEvent.change(editor, { target: { value: '고친 글' } });
 fireEvent.click(generate);
 const alert = await screen.findByRole('alert');
 expect(alert).toHaveTextContent('12초 뒤에 다시 시도해 주세요');
 expect(editor).toHaveValue('고친 글');
 fireEvent.click(within(alert).getByRole('button', { name: '다시 시도하기' }));
 await waitFor(() => expect(editor).toHaveValue(draftBody));
 fireEvent.click(screen.getByRole('button', { name: '공고 없이 직접 쓰기' }));
 expect(screen.getByRole('button', { name: '신청서 초안 만들기' })).toBeDisabled();
 const blank = screen.getByRole('textbox', { name: '신청서 초안' });
 expect(blank).toHaveValue('');
 expect(screen.getByRole('button', { name: '초안 복사하기' })).toBeDisabled();
 fireEvent.change(blank, { target: { value: '직접 쓴 초안' } });
 expect(screen.getByRole('button', { name: '초안 복사하기' })).toBeEnabled();
});

it('focuses and selects the editable text if clipboard access fails', async () => {
 const user = userEvent.setup();
 vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
 vi.spyOn(globalThis, 'fetch').mockResolvedValue(draftResponse());
 openDraft();
 fireEvent.click(screen.getByRole('button', { name: '신청서 초안 만들기' }));
 const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '신청서 초안' });
 await user.click(screen.getByRole('button', { name: '초안 복사하기' }));
 expect(await screen.findByRole('alert')).toHaveTextContent('복사하지 못했어요. 직접 복사해 주세요');
 expect(editor).toHaveFocus();
 expect(editor.selectionStart).toBe(0);
 expect(editor.selectionEnd).toBe(draftBody.length);
});

it('marks the official-notice block as an Esc layer of the detail window and gives focus back to its opener when it closes (K-B)', async () => {
 renderWithKit(detail, { reducedMotion: true });
 const opener = screen.getByRole('button', { name: '공식 공고 보기' });
 await userEvent.click(opener);
 const notice = document.querySelector<HTMLElement>('[data-slot="grants.official"]')!;
 // The detail window presses data-esc-close on the first Esc (DetailOverlay layer), so the notice closes before the window does.
 expect(notice).toHaveAttribute('data-esc-layer');
 const close = notice.querySelector<HTMLButtonElement>('[data-esc-close]')!;
 expect(close).toHaveTextContent('닫기');
 close.click();
 await waitFor(() => expect(document.querySelector('[data-slot="grants.official"]')).toBeNull());
 expect(opener).toHaveFocus();
});

it('reads a closed Financial Center recommendation alongside Bizinfo and re-reads it in a new session', async () => {
 const { backend, collections, newStore } = insightSession();
 collections.set('grant-notices', [grant]);
 const path = '/insight/financial-center/recommendations';
 const row = { ref: 'policy-2026', title: '소상공인 정책자금', source: 'naver-financial-center', officialNoticeUrl: 'https://www.semas.or.kr/', status: 'closed', endDate: '2026-09-30' };
 const sourceUrl = 'https://help.admin.pay.naver.com/faq/content.help?faqId=13148';
 backend.on('GET', path, () => ({ state: 'ready', items: [row], source: row.source, sourceUrl, asOf: updatedAt, nextCursor: null, sourceRevision: 'test' }));
 backend.on('GET', `${path}/policy-2026`, () => ({ ...row, sourceUrl, asOf: updatedAt, overview: '시설 자금 안내', eligibility: '소상공인', applicationMethod: '기관에서 신청', documents: ['사업자등록증'] }));
 for (let session = 0; session < 2; session++) {
  renderWithKit(detail, { store: newStore() });
  expect(await screen.findByText('기업마당')).toBeVisible();
  const recommendation = await screen.findByRole('button', { name: /소상공인 정책자금.*마감/u });
  await userEvent.click(recommendation);
  expect(await screen.findByText('사업자등록증')).toBeVisible();
  const section = document.querySelector<HTMLElement>('[data-slot="grants.financial-center.detail"]')!;
  expect(within(section).getByText('기관에서 신청')).toBeVisible();
  // T-27: the 기준일 is store day and clock, never the browser's date string.
  expect(section.textContent).not.toMatch(/기준일|15:00/);
  expect(section.textContent).not.toMatch(/GMT|오전|오후/);
  expect(within(section).getByRole('link', { name: '공식 안내 열기' })).toHaveAttribute('href', row.officialNoticeUrl);
  expect(within(section).queryByRole('button', { name: /신청 완료/u })).toBeNull();
  cleanup();
 }
 expect(backend.callsTo('GET', `${path}/policy-2026`)).toHaveLength(2);
 expect(backend.callsTo('POST', '/insight/grant-applications')).toHaveLength(0);
});

it('retries a Financial Center failure without hiding Bizinfo', async () => {
 const { backend, collections, newStore } = insightSession();
 collections.set('grant-notices', [grant]);
 const path = '/insight/financial-center/recommendations';
 let available = false;
 backend.on('GET', path, () => available
  ? { state: 'ready', items: [] }
  : { status: 503, body: { code: 'NAVER_SOURCE_UNAVAILABLE' } });
 renderWithKit(detail, { store: newStore() });
 const section = await screen.findByRole('region', { name: '네이버 금융센터 추천' });
 expect(await within(section).findByText('네이버 금융센터 추천을 불러오지 못했어요')).toBeVisible();
 expect(screen.getByText('기업마당')).toBeVisible();
 available = true;
 await userEvent.click(within(section).getByRole('button', { name: '다시 시도하기' }));
 expect(await within(section).findByText('추천 공고가 없어요')).toBeVisible();
 expect(backend.callsTo('GET', path)).toHaveLength(2);
});

/* FIX-PKG-A / T-27, T-28 (gate r1a W13): official notice dates read like the rest of the app, and the real draft tab carries no sample wording. */
it('shows official notice dates as day and weekday, and the source time as day and clock (no ISO date, no browser date string)', async () => {
 const { collections, newStore } = insightSession();
 collections.set('grant-notices', [grant]);
 renderWithKit(detail, { store: newStore() });
 await screen.findByRole('link', { name: '공식 공고 열기' });
 const facts = document.querySelector<HTMLElement>('[data-slot="grants.item"]')!;
 expect(facts.textContent).toContain('7/27(수)');
 expect(facts.textContent).toContain('9/30(금)');
 expect(facts.textContent).toMatch(/\d{1,2}\/\d{1,2}\([월화수목금토일]\) 15:00/);
 expect(facts.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}|GMT|오전|오후|\d{4}\. \d/);
});

it('names the notice-less draft start by what it does, not as a sample (real server)', async () => {
 const { collections, newStore } = insightSession();
 collections.set('grant-notices', [grant]);
 const user = userEvent.setup();
 renderWithKit(detail, { store: newStore() });
 await screen.findByRole('link', { name: '공식 공고 열기' });
 await user.click(screen.getByRole('tab', { name: '신청서 초안' }));
 expect(screen.queryByRole('button', { name: '자료가 없는 예시' })).not.toBeInTheDocument();
 expect(screen.getByRole('button', { name: '공고 없이 직접 쓰기' })).toBeVisible();
 expect(document.body.textContent).not.toMatch(/예시/);
});
