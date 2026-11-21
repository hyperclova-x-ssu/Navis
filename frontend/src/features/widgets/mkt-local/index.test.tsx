import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, ContentShape, DetailRef, FeatureId, Locale, PreviewSelection, WidgetHost } from '../../../contracts';
import { baseBundles, findDuplicateKeys, findKoGaps, type MessageBundle } from '../../../i18n';
import { dataBundle } from '../../../data/messages';
import { createWidgetDataStore } from '../../../data/db/store';
import { createSeedTables } from '../../../data/db/seed';
import { readModel, TODAY } from '../../../data/widget-data';
import { uiBundle } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import { mktLocalBundle, mktLocalReviewKeys } from './messages';
import { widgets } from './index';
import { readFileSync } from 'node:fs';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const byId = (id: FeatureId) => widgets.find((w) => w.id === id)!;
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
type TestHost = WidgetHost & { readonly calls: { openClosing: string[]; openLinked: DetailRef[]; openDetail: DetailRef[]; notify: unknown[]; resetPreview: number } };
function makeHost(): TestHost {
  const calls = { openClosing: [] as string[], openLinked: [] as DetailRef[], openDetail: [] as DetailRef[], notify: [] as unknown[], resetPreview: 0 };
  return {
    layer: 'marketing', calls, openClosing: (key) => { calls.openClosing.push(key); return true; },
    resetPreview: () => { calls.resetPreview += 1; }, openLinked: (r) => { calls.openLinked.push(r); }, openDetail: (r) => { calls.openDetail.push(r); },
    notify: (n) => { calls.notify.push(n); }, acknowledgeBriefing: () => {},
  };
}
const condition = { kind: 'default' } as const;
function panel(id: FeatureId, w: CellSpan, h: CellSpan, opts: { locale?: Locale; textScale?: 100 | 125; preview?: PreviewSelection; host?: TestHost; store?: ReturnType<typeof createWidgetDataStore> } = {}) {
  const Panel = byId(id).Panel;
  const host = opts.host ?? makeHost();
  return { host, ...renderWithKit(<div data-testid="p"><Panel featureId={id} condition={condition} width={w} height={h} shape={shapeOf(w, h)} presetId="A" editing={false} host={host} /></div>, { ...opts, modules: widgets }) };
}
function detail(id: FeatureId, opts: { locale?: Locale; preview?: PreviewSelection; ref?: Partial<DetailRef>; store?: ReturnType<typeof createWidgetDataStore> } = {}) {
  const Detail = byId(id).Detail!;
  const host = makeHost();
  const ref: DetailRef = { featureId: id, ...opts.ref };
  return { host, ...renderWithKit(<Detail featureId={id} condition={condition} detailRef={ref} host={host} />, { ...opts, modules: widgets }) };
}
const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`);

/* The app now runs on the cafe seed. Expectations come from the same model the widget reads (readModel), never from copied numbers. */
type LocalId = 'local-changes' | 'trade-area' | 'local-trends' | 'ai-response' | 'community';
const model = <F extends LocalId>(id: F, store = createWidgetDataStore()) => readModel(store.getSnapshot(), id);
const seedText = (key: string): string => key.replace(/^seed:/, '');
const dataLabel = (locale: Locale, key: string): string => (dataBundle as unknown as Record<string, Record<string, string>>)[locale][key];
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const koRange = (start: string, end: string): string => {
  const [, m1, d1] = start.split('-').map(Number); const [, m2, d2] = end.split('-').map(Number);
  return m1 === m2 ? `${m1}월 ${d1}일~${d2}일` : `${m1}월 ${d1}일~${m2}월 ${d2}일`;
};
const bodyOf = (th: { readonly body: unknown }): string => seedText((th.body as { readonly key: string }).key);
const rowFor = (body: string) => screen.getByRole('button', { name: new RegExp(escapeRe(body.slice(0, 16))) });

/** The cafe DB has no review sentiment (rating is independent of it), so 긍정/부정 and 칭찬 리뷰 are checked on sentiments derived from the rating: 4–5 positive, 3 neutral, 1–2 negative. */
function storeWithSentiment() {
  const base = createSeedTables();
  return createWidgetDataStore({ inquiryThread: base.inquiryThread.map((th) => (th.type === 'review' && th.rating !== null ? { ...th, sentiment: th.rating >= 4 ? 'positive' as const : th.rating <= 2 ? 'negative' as const : 'neutral' as const } : th)) });
}
/** DATA-FIX item 4 (877f99a): the seed now flags refund, complaint, privacy and ungrounded threads itself, so the oldest flagged row is a seeded one (97d9735e-0001-5478-af3a-d1d0e6771c21).
 * To keep testing the synthetic refund specifically, every other row's reason is cleared and the first waiting message alone is marked as a refund request. */
function storeWithRefund() {
  const base = createSeedTables();
  const target = base.inquiryThread.find((th) => th.type === 'message' && th.status !== 'done')!;
  return { store: createWidgetDataStore({ inquiryThread: base.inquiryThread.map((th) => ({ ...th, needsPersonReason: th.threadId === target.threadId ? 'refund' as const : null })) }), threadId: target.threadId };
}
/** The cafe DB has one direct offer: add a later direct offer and a public one for ordering, accepting and showing interest. */
function storeWithOffers() {
  const base = createSeedTables();
  const first = base.partnershipOffer[0];
  return createWidgetDataStore({ partnershipOffer: [...base.partnershipOffer,
    { ...first, offerId: 'zz-direct-later', titleKey: 'seed:수제 쿠키 샘플 교환', fromStoreKey: 'seed:상도 쿠키 공방', respondBy: '2026-11-24T18:00', periodStart: '2026-11-25', periodEnd: '2026-11-30' },
    { ...first, offerId: 'zz-public', visibility: 'public' as const, titleKey: 'seed:골목 책방 스탬프 연계', fromStoreKey: 'seed:상도역 독립 서점', respondBy: '2026-11-26T18:00', periodStart: '2026-11-27', periodEnd: '2026-12-05' },
  ] });
}
/** The cafe trends all have a previous value; one keyword without it checks “비교 자료 없음”. */
function storeWithNewKeyword() {
  const base = createSeedTables();
  return createWidgetDataStore({ trendKeyword: [...base.trendKeyword, { ...base.trendKeyword[0], keywordId: 'zz-new', keywordKey: 'seed:단호박 라떼', categoryKey: 'seed:시즌 메뉴', mentions: 12, prevMentions: null }] });
}

describe('module shape', () => {
  it('exports the five API-13 modules in the marketing layer', () => {
    expect(widgets.map((w) => w.id)).toEqual(['local-changes', 'trade-area', 'local-trends', 'ai-response', 'community']);
    for (const w of widgets) { expect(typeof w.Panel).toBe('function'); expect(typeof w.Detail).toBe('function'); expect(typeof w.useSummary).toBe('function'); }
  });
});

describe('panel values (1x1 · 2x1 · 1x2 · 2x2)', () => {
  it('동네 변화: 이번 주 건수, 변화 제목과 종류, 날짜는 ISO가 아님', () => {
    const lc = model('local-changes');
    expect(lc.count).toBe(lc.changes.length);
    expect(lc.foldedCount).toBe(0);
    panel('local-changes', 1, 1);
    expect(slot('local-changes.metric.label')).toHaveTextContent('이번 주 동네 변화');
    expect(slot('local-changes.metric.value')).toHaveTextContent(`${lc.count}개`);
    cleanup();
    panel('local-changes', 2, 1);
    for (const c of lc.openChanges.slice(0, 2)) expect(screen.getByText(seedText(c.titleKey))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    cleanup();
    panel('local-changes', 1, 2, { locale: 'en' });
    expect(slot('local-changes.metric.value')).toHaveTextContent(`${lc.count}changes`);
    for (const c of lc.openChanges.slice(0, 2)) expect(screen.getAllByText(dataLabel('en', c.kindKey)).length).toBeGreaterThan(0);
    cleanup();
    panel('local-changes', 2, 2, { locale: 'zh-Hans' });
    expect(slot('local-changes.metric.value')).toHaveTextContent(`${lc.count}条`);
    expect(screen.getByText(dataLabel('zh-Hans', lc.openChanges[0].kindKey))).toBeInTheDocument();
  });

  it('상권분석: 가장 붐비는 시간의 유동인구, 상위 시간대 2개를 시간 순서로', () => {
    const ta = model('trade-area');
    const { peak } = ta;
    const topByClock = [...ta.top].sort((a, b) => a.hour - b.hour);
    panel('trade-area', 1, 1);
    expect(slot('trade-area.metric.label')).toHaveTextContent(`${peak.hour}시 유동인구`);
    expect(slot('trade-area.metric.value')).toHaveTextContent(`${peak.people}명`);
    expect(slot('trade-area.metric.note')).toHaveTextContent('매장 주변 · 시간대별 일평균');
    cleanup();
    panel('trade-area', 2, 1);
    const rows = document.querySelectorAll('[data-slot="trade-area.list.row"]');
    expect(rows).toHaveLength(2);
    topByClock.forEach((h, index) => { expect(rows[index]).toHaveTextContent(`${h.hour}~${h.hour + 1}시`); expect(rows[index]).toHaveTextContent(`${h.people}명`); });
    cleanup();
    panel('trade-area', 2, 2, { locale: 'en' });
    expect(slot('trade-area.metric.label')).toHaveTextContent(`Foot traffic at ${peak.hour}:00`);
    expect(slot('trade-area.metric.value')).toHaveTextContent(`${peak.people}people`);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('로컬 트렌드: 주목할 키워드 건수, 많이 늘어난 순서의 키워드와 언급 증가', () => {
    const lt = model('local-trends');
    const [first, second] = lt.notable;
    panel('local-trends', 1, 1);
    expect(slot('local-trends.metric.value')).toHaveTextContent(`${lt.notableCount}개`);
    expect(slot('local-trends.metric.note')).toHaveTextContent('최근 7일 · 이전 7일 대비');
    cleanup();
    panel('local-trends', 2, 1);
    expect(screen.getByText(seedText(first.keywordKey))).toBeInTheDocument();
    expect(screen.getByText(seedText(second.keywordKey))).toBeInTheDocument();
    expect(document.querySelector('[data-slot="local-trends.list"]')).toHaveTextContent(`▲ ${first.changePercent}% 늘었어요`);
    cleanup();
    panel('local-trends', 1, 2, { locale: 'zh-Hant' });
    expect(slot('local-trends.metric.label')).toHaveTextContent('值得關注的關鍵字');
    expect(screen.getByText(seedText(first.keywordKey))).toBeInTheDocument();
  });

  it('메시지·리뷰: 답변 대기 건수와 종류별 수, 채널별, 먼저 볼 항목, 칭찬 리뷰', () => {
    const ai = model('ai-response');
    const channelText = (locale: Locale, key: string) => (key.startsWith('seed:') ? seedText(key) : dataLabel(locale, key));
    const praise = (n: number) => `칭찬 리뷰 ${n}개`;
    panel('ai-response', 1, 1);
    expect(slot('ai-response.metric.value')).toHaveTextContent(`${ai.waitingCount}건`);
    expect(slot('ai-response.metric.secondary')).toHaveTextContent(`메시지 ${ai.byType.message} · 리뷰 ${ai.byType.review}`);
    expect(screen.queryByText(praise(ai.praiseCount))).not.toBeInTheDocument();
    cleanup();
    panel('ai-response', 2, 1);
    for (const channel of ai.byChannel.slice(0, 2)) expect(screen.getByText(channelText('ko', channel.channelKey))).toBeInTheDocument();
    expect(screen.getByText(praise(ai.praiseCount))).toBeInTheDocument();
    cleanup();
    panel('ai-response', 1, 2);
    const rows = document.querySelectorAll('[data-slot="ai-response.list.row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(bodyOf(ai.priority[0]));
    expect(rows[1]).toHaveTextContent(bodyOf(ai.priority[1]));
    cleanup();
    panel('ai-response', 2, 2, { locale: 'en' });
    expect(slot('ai-response.metric.value')).toHaveTextContent(`${ai.waitingCount}items`);
    expect(screen.getByText(`${ai.praiseCount} praise review${ai.praiseCount === 1 ? '' : 's'}`)).toBeInTheDocument();
  });

  it('메시지·리뷰: 시드가 환불·개인정보·불만·근거 없음 글을 스스로 표시하고, 가장 오래된 표시 글이 맨 위에 나온다 (DATA-FIX 4)', () => {
    const ai = model('ai-response');
    expect(ai.priority[0]).toMatchObject({ threadId: '97d9735e-0001-5478-af3a-d1d0e6771c21' });
    expect(ai.priority[0].needsPersonReason).not.toBeNull();
    panel('ai-response', 1, 2);
    const rows = document.querySelectorAll('[data-slot="ai-response.list.row"]');
    expect(rows[0]).toHaveTextContent(bodyOf(ai.priority[0]));
    expect(rows[0]).toHaveTextContent('확인 필요');
  });

  it('메시지·리뷰: 사람이 확인해야 하는 글은 맨 위에 확인 필요 배지와 함께 나온다', () => {
    const { store, threadId } = storeWithRefund();
    const ai = model('ai-response', store);
    expect(ai.priority[0].threadId).toBe(threadId);
    panel('ai-response', 1, 2, { store });
    const rows = document.querySelectorAll('[data-slot="ai-response.list.row"]');
    expect(rows[0]).toHaveTextContent(bodyOf(ai.priority[0]));
    expect(rows[0]).toHaveTextContent('확인 필요');
  });

  it('커뮤니티: 답할 제안 건수, 제안 이름과 응답 대기', () => {
    const co = model('community');
    panel('community', 1, 1);
    expect(slot('community.metric.value')).toHaveTextContent(`${co.pendingCount}건`);
    cleanup();
    panel('community', 2, 1);
    for (const o of co.pending.slice(0, 2)) expect(screen.getByText(seedText(o.titleKey))).toBeInTheDocument();
    expect(screen.getAllByText('응답 대기')).toHaveLength(Math.min(2, co.pending.length));
    cleanup();
    panel('community', 2, 2, { locale: 'en' });
    expect(screen.getByText(seedText(co.pending[0].titleKey))).toBeInTheDocument();
  });

  it('패널 안에는 상태 조작 하나 외 버튼이 없다', () => {
    for (const w of widgets) { panel(w.id, 2, 2); expect(screen.queryAllByRole('button')).toHaveLength(0); cleanup(); }
  });

  it('긴 영어 제목·값도 겹치지 않는 구조(라벨·값·보조가 각각 하나의 슬롯)', () => {
    panel('ai-response', 1, 1, { locale: 'en', textScale: 125 });
    expect(document.querySelectorAll('[data-slot="ai-response.metric.label"]')).toHaveLength(1);
    expect(document.querySelectorAll('.ui-metric-fit')).toHaveLength(1);
    expect(slot('ai-response.metric.secondary')).toBeNull(); // first thing dropped at 125% in Q
  });
});

describe('useSummary', () => {
  it('writes one key sentence per widget', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { KitProviders } = await import('../../../ui/test-utils');
    const sentence = (id: FeatureId, locale: Locale) => renderHook(() => byId(id).useSummary({ featureId: id, condition }), { wrapper: ({ children }) => <KitProviders locale={locale} modules={widgets}>{children}</KitProviders> }).result.current;
    const lc = model('local-changes'); const ta = model('trade-area'); const lt = model('local-trends'); const ai = model('ai-response'); const co = model('community');
    expect(sentence('local-changes', 'ko')).toBe(`새 변화 ${lc.openChanges.length}개`);
    expect(sentence('trade-area', 'ko')).toBe(`${ta.peak.hour}시 유동인구 ${ta.peak.people}명`);
    expect(sentence('local-trends', 'ko')).toBe(`주목할 키워드 ${lt.notableCount}개`);
    expect(sentence('ai-response', 'ko')).toBe(`답변 대기 ${ai.waitingCount}건`);
    expect(sentence('community', 'ko')).toBe(`답할 제안 ${co.pendingCount}건`);
    expect(sentence('ai-response', 'en')).toBe(`${ai.waitingCount} items awaiting reply`);
    expect(sentence('community', 'zh-Hans')).toBe(`待回复的合作提议 ${co.pendingCount} 条`);
  });
});

describe('동네 변화 detail', () => {
  it('shows kind, distance, same category, source and updated time; 확인했어요 folds one change and the header follows the open count', () => {
    const lc = model('local-changes');
    const [first] = lc.openChanges;
    const updatedLike = lc.openChanges.filter((c) => c.updatedAt === first.updatedAt).length;
    expect(first.updatedAt.slice(0, 10)).toBe(TODAY);
    const { host } = detail('local-changes');
    // D-327: the header counts the changes still to check, the same number as the list and the chat.
    const summary = (open: number) => `새 변화 ${open}개 · 매장 주변 ${lc.radiusM}m`;
    expect(screen.getByText(summary(lc.openChanges.length))).toBeInTheDocument();
    expect(screen.queryAllByText('같은 업종')).toHaveLength(lc.changes.filter((c) => c.sameCategory).length);
    expect(screen.getByText(`매장에서 ${first.distanceM}m`)).toBeInTheDocument();
    expect(screen.getAllByText(/출처: 예시 자료/)).toHaveLength(lc.openChanges.length);
    expect(screen.getAllByText(new RegExp(`오늘 ${first.updatedAt.slice(11, 16)} 갱신`))).toHaveLength(updatedLike);
    expect(screen.queryByText('손님예측에 반영했어요')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`확인 완료로 표시하기.*${escapeRe(seedText(first.titleKey))}`) }));
    expect(screen.queryByText(`매장에서 ${first.distanceM}m`)).not.toBeInTheDocument();
    expect(screen.getByText(summary(lc.openChanges.length - 1))).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: '접어 둔 변화 1개' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByText(`매장에서 ${first.distanceM}m`)).toBeInTheDocument();
    expect(screen.getAllByText('확인함').length).toBeGreaterThan(0);
    expect(host.calls.notify).toHaveLength(1);
    expect(host.calls.notify[0]).toMatchObject({ kind: 'success', messageKey: 'data.notice.changeAcked' });
  });
  it('panel keeps the count after folding and lists only open changes', () => {
    const store = createWidgetDataStore();
    const lc = model('local-changes', store);
    store.dispatch({ type: 'localChanges.acknowledge', changeId: lc.openChanges[0].changeId });
    panel('local-changes', 1, 1, { store });
    expect(slot('local-changes.metric.value')).toHaveTextContent(`${lc.count}개`);
    expect(slot('local-changes.metric.secondary')).toHaveTextContent('접어 둔 변화 1개');
  });
});

describe('상권분석 detail', () => {
  it('bounds the hourly chart within the detail even when coupon styles are loaded', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync('src/features/widgets/mkt-coupon/widget.css', 'utf8') + '\n' + readFileSync('src/features/widgets/mkt-local/widget.css', 'utf8');
    document.head.append(style);
    try {
      detail('trade-area');
      const root = document.querySelector<HTMLElement>('[data-slot="trade-area.card"]')!;
      const chart = root.querySelector<HTMLElement>('.mkt-hours')!;
      const rootStyle = getComputedStyle(root);
      const chartStyle = getComputedStyle(chart);
      expect(rootStyle.display).toBe('flex');
      expect(rootStyle.flexDirection).toBe('column');
      expect(rootStyle.minHeight).toBe('0');
      expect(chartStyle.flexGrow).toBe('0');
      expect(chartStyle.overflowY).toBe('visible');
    } finally {
      style.remove();
    }
  });
  it('starts on the peak hour; every bar label has its unit; tapping an hour shows that slot; link opens 로컬 트렌드', () => {
    const ta = model('trade-area');
    const { peak } = ta;
    const other = ta.top.find((h) => h.hour !== peak.hour)!;
    const percent = Math.round((other.people / peak.people) * 100);
    const { host } = detail('trade-area');
    expect(screen.getByText(new RegExp(`${escapeRe(seedText(ta.regionKey))} · 최근 4주`))).toBeInTheDocument();
    const card = () => slot('trade-area.metric.value')!;
    expect(card()).toHaveTextContent(`${peak.hour}~${peak.hour + 1}시`);
    expect(within(card() as HTMLElement).getByText('가장 붐비는 시간대예요')).toBeInTheDocument();
    expect(card()).not.toHaveTextContent('100%');
    const labels = [...document.querySelectorAll('.mkt-hour__label')].map((el) => el.textContent);
    expect(labels).toEqual(ta.hours.map((h) => `${h.hour}시`));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${other.hour}~${other.hour + 1}시, ${other.people}명`) }));
    expect(card()).toHaveTextContent(`${other.hour}~${other.hour + 1}시`);
    expect(card()).toHaveTextContent(`${other.people}명`);
    expect(within(card() as HTMLElement).getByText(`가장 붐비는 시간의 ${percent}%예요`)).toBeInTheDocument();
    expect(card()).not.toHaveTextContent('가장 붐비는 시간대예요');
    expect(screen.getByRole('button', { name: new RegExp(`^${other.hour}~${other.hour + 1}시`) })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '이 지역 트렌드 보기' }));
    expect(host.calls.openLinked).toEqual([{ featureId: 'local-trends' }]);
  });

  it('shows only the busiest hour sentence for the peak in English', () => {
    const ta = model('trade-area');
    const { peak } = ta;
    const other = ta.top.find((h) => h.hour !== peak.hour)!;
    const percent = Math.round((other.people / peak.people) * 100);
    const clock = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
    detail('trade-area', { locale: 'en' });
    const card = slot('trade-area.metric.value') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${clock(other.hour)}–${clock(other.hour + 1)},`) }));
    expect(within(card).getByText(`${percent}% of the busiest hour`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${clock(peak.hour)}–${clock(peak.hour + 1)},.*The busiest hour$`) }));
    expect(within(card).getByText('This is the busiest hour')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('100%');
  });
});

describe('로컬 트렌드 detail', () => {
  it('keyword detail shows definition, comparison period, source, date; no comparison is stated', () => {
    const store = storeWithNewKeyword();
    const lt = model('local-trends', store);
    const [first] = lt.keywords;
    detail('local-trends', { store });
    const fresh = screen.getByRole('button', { name: /단호박 라떼/ });
    fireEvent.click(fresh);
    const freshCard = fresh.closest('li')!.querySelector('.mkt-card')!;
    expect(freshCard).toHaveTextContent('비교 자료 없음');
    expect(freshCard).toHaveTextContent('관심 지표는');
    const opened = screen.getByRole('button', { name: new RegExp(escapeRe(seedText(first.keywordKey))) });
    fireEvent.click(opened);
    const card = opened.closest('li')!.querySelector('.mkt-card')!;
    expect(card).toHaveTextContent(`언급 ${first.mentions}회(이전 ${first.previous}회)`);
    expect(card).not.toHaveTextContent(/회 \(이전/);
    expect(card).toHaveTextContent('이전');
    expect(card).toHaveTextContent('출처: 예시 자료');
    expect(card).toHaveTextContent('갱신');
  });

  it('opens evidence in the keyword row and toggles one section at a time with click, Enter and Space', async () => {
    const user = userEvent.setup();
    const [a, b, c] = model('local-trends').keywords;
    detail('local-trends');
    const first = screen.getByRole('button', { name: new RegExp(escapeRe(seedText(a.keywordKey))) });
    const second = screen.getByRole('button', { name: new RegExp(escapeRe(seedText(b.keywordKey))) });
    const third = screen.getByRole('button', { name: new RegExp(escapeRe(seedText(c.keywordKey))) });
    const secondRow = second.closest('li')!;
    const scrollIntoView = vi.fn();
    Object.defineProperty(secondRow, 'scrollIntoView', { value: scrollIntoView });

    await user.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'true');
    expect(first).toHaveAttribute('aria-expanded', 'false');
    const evidence = document.getElementById(second.getAttribute('aria-controls')!)!;
    expect(secondRow).toContainElement(evidence);
    expect(evidence).toBeVisible();
    expect(evidence).toHaveTextContent(`언급 ${b.mentions}회(이전 ${b.previous}회)`);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));

    await user.click(second);
    expect(second).toHaveAttribute('aria-expanded', 'false');
    expect(evidence).not.toBeVisible();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    await user.keyboard('{Enter}');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    third.focus();
    await user.keyboard(' ');
    expect(second).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button', { expanded: true })).toEqual([third]);
  });
});

function stubReplyTransport(body: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (input === '/api/navis/widget-drafts') return Response.json({ draftId: 'draft', kind: 'reply', sourceLabels: ['예시 원문'], content: { body } });
    if (input === '/api/navis/reply-test-targets') return Response.json({ mode: 'fake', targets: [{ id: 'fake-1', label: '테스트 번호 1' }] });
    if (input === '/api/navis/reply-test-send') return Response.json({ status: 'simulated', receiptId: 'receipt' });
    throw new Error('Unexpected route');
  });
}

async function previewReply() {
  await screen.findByRole('radio', { name: '테스트 번호 1' });
  fireEvent.click(screen.getByRole('button', { name: '보낼 내용 확인하기' }));
  return screen.getByRole('button', { name: '테스트 문자 보내기' });
}

describe('메시지·리뷰 응대 detail', () => {
  it('message tab: a thread that needs a human, confirmed test send once → one fewer waiting, 보냈어요(예시)', async () => {
    const parkingReply = '건물 뒤에 2대까지 주차할 수 있어요.';
    const { store, threadId } = storeWithRefund();
    const ai = model('ai-response', store);
    const flagged = ai.threads.find((th) => th.threadId === threadId)!;
    const next = ai.priority.find((th) => th.type === 'message' && th.threadId !== threadId)!;
    const transport = stubReplyTransport(parkingReply);
    detail('ai-response', { store });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const first = screen.getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'true')!;
    expect(first).toHaveTextContent(bodyOf(flagged));
    expect(screen.getByText(/사람이 직접 확인해 주세요\(환불\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보낼 내용 확인하기' })).toBeDisabled();
    fireEvent.click(rowFor(bodyOf(next)));
    expect(next.groundKeys).toEqual([]);
    expect(screen.getByText('사용한 매장 안내가 없어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '답변 초안 만들기' }));
    expect(await screen.findByRole('textbox', { name: '답변 초안' })).toHaveValue(parkingReply);
    const send = await previewReply();
    fireEvent.click(send);
    fireEvent.click(send);
    expect(await screen.findByText('보냈어요(예시)')).toBeInTheDocument();
    expect(screen.getByText(`답변 대기 ${ai.waitingCount - 1}건 · 메시지 ${ai.byType.message - 1} · 리뷰 ${ai.byType.review}`)).toBeInTheDocument();
    expect(transport.mock.calls.filter(([path]) => path === '/api/navis/reply-test-send')).toHaveLength(1);
  });

  it('review tab: 긍정/부정 badges with text, 칭찬 리뷰 chip filters to positive and keeps its number after the reply', async () => {
    const store = storeWithSentiment();
    const ai = model('ai-response', store);
    const reviews = ai.priority.filter((th) => th.type === 'review');
    const positive = reviews.filter((th) => th.sentiment === 'positive');
    const negative = reviews.filter((th) => th.sentiment === 'negative');
    expect(positive.length).toBeGreaterThan(0);
    expect(negative.length).toBeGreaterThan(0);
    stubReplyTransport('오래 기다리시게 해서 죄송해요.');
    detail('ai-response', { ref: { view: 'review' }, store });
    const chipName = `칭찬 리뷰 ${ai.praiseCount}개`;
    expect(ai.praiseCount).toBe(positive.length);
    const chip = screen.getByRole('checkbox', { name: chipName });
    const list = () => document.querySelector('[data-slot="ai-response.list"]') as HTMLElement;
    expect(chip).toHaveAttribute('aria-checked', 'false');
    expect(within(list()).getAllByText('긍정')).toHaveLength(positive.length);
    expect(within(list()).getAllByText('부정')).toHaveLength(negative.length);
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-checked', 'true');
    expect(document.querySelectorAll('[data-slot="ai-response.list"] li')).toHaveLength(positive.length);
    expect(screen.queryAllByText('부정')).toHaveLength(0);
    expect(within(list()).getAllByText(/ · [^ ]\*\*$/)).toHaveLength(positive.filter((th) => th.authorMasked).length);
    expect(document.body.textContent).not.toMatch(/손님\d{4}/);
    fireEvent.click(chip);
    expect(list().textContent).toContain(`네이버 리뷰 · ${reviews[0].authorMasked}`);
    fireEvent.click(rowFor(bodyOf(reviews[0])));
    fireEvent.click(screen.getByRole('button', { name: '답글 초안 만들기' }));
    expect(await screen.findByRole('textbox', { name: '답글 초안' })).toBeInTheDocument();
    fireEvent.click(await previewReply());
    expect(await screen.findByText('보냈어요(예시)')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: chipName })).toBeInTheDocument();
    expect(screen.getByText(`답변 대기 ${ai.waitingCount - 1}건 · 메시지 ${ai.byType.message} · 리뷰 ${ai.byType.review - 1}`)).toBeInTheDocument();
  });

  it('review rows show the star rating as a rating chip and the date in the short form', () => {
    const ai = model('ai-response');
    const review = ai.priority.find((th) => th.type === 'review')!;
    detail('ai-response', { ref: { view: 'review' } });
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(screen.getAllByText(`별점 ${review.rating}점`).length).toBeGreaterThan(0);
    expect(document.querySelector('.ui-status-badge[data-semantic="rating"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('★★');
  });

  it('send-failure sample state: 보내지 못했어요 + reason, thread stays waiting, 다시 시도 resets the sample state', async () => {
    const ai = model('ai-response');
    const message = ai.priority.find((th) => th.type === 'message')!;
    const transport = stubReplyTransport('건물 뒤에 2대까지 주차할 수 있어요.');
    const { host } = detail('ai-response', { preview: { family: 'normal', overrides: { 'ai-response': 'send-failure' } } });
    fireEvent.click(rowFor(bodyOf(message)));
    fireEvent.click(screen.getByRole('button', { name: '답변 초안 만들기' }));
    fireEvent.click(await previewReply());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('보내지 못했어요');
    expect(alert).toHaveTextContent('채널이 응답하지 않아요(예시)');
    expect(screen.getByText(`답변 대기 ${ai.waitingCount}건 · 메시지 ${ai.byType.message} · 리뷰 ${ai.byType.review}`)).toBeInTheDocument();
    expect(host.calls.notify).toHaveLength(0);
    expect(transport.mock.calls.filter(([path]) => path === '/api/navis/reply-test-send')).toHaveLength(0);
    fireEvent.click(within(alert).getByRole('button', { name: '다시 시도하기' }));
    expect(host.calls.resetPreview).toBe(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('채널 미연결 and 대기 0건 are different states', () => {
    const disconnected = detail('ai-response', { preview: { family: 'normal', overrides: { 'ai-response': 'channel-disconnected' } } });
    expect(screen.getByText('연결된 채널이 없어요')).toBeInTheDocument();
    expect(screen.queryByText('연결이 필요해요')).toBeNull();
    expect(screen.getByRole('button', { name: '연결하기(예시)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '연결하기(예시)' }));
    expect(disconnected.host.calls.resetPreview).toBe(1);
    cleanup();
    detail('ai-response', { preview: { family: 'normal', overrides: { 'ai-response': 'none' } } });
    expect(screen.getByText('답변을 기다리는 메시지·리뷰가 없어요')).toBeInTheDocument();
    expect(screen.queryByText('채널 미연결')).not.toBeInTheDocument();
  });

  it('requires preview and confirmation for test sends', () => {
    detail('ai-response');
    expect(screen.getByText('자동 발송 없음 · 항상 미리보기 확인 후 테스트 발송')).toBeInTheDocument();
    expect(screen.queryByText('켜짐')).not.toBeInTheDocument();
  });

  it('shop guidance lines carry no empty separators and no ISO dates', () => {
    detail('ai-response');
    const section = screen.getByRole('region', { name: '매장 안내' });
    const lines = [...section.querySelectorAll('p')].map((el) => el.textContent ?? '');
    for (const line of lines) expect(line).not.toMatch(/^[\s·]*$/);
    expect(section.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('works in English and Traditional Chinese (no key strings)', () => {
    const store = storeWithSentiment();
    const { praiseCount } = model('ai-response', store);
    detail('ai-response', { locale: 'en', ref: { view: 'review' }, store });
    expect(screen.getByRole('checkbox', { name: `${praiseCount} praise reviews` })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/widget\.|data\./);
    cleanup();
    detail('ai-response', { locale: 'zh-Hant', ref: { view: 'review' }, store });
    expect(screen.getByRole('checkbox', { name: `好評 ${praiseCount} 則` })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/widget\.|data\./);
  });
});

describe('커뮤니티 detail', () => {
  it('received offers are in reply-deadline order; opening does not change the count; accept moves one to in progress and shows the contact', () => {
    const store = storeWithOffers();
    const co = model('community', store);
    const direct = co.received;
    expect(direct).toHaveLength(2);
    const { host } = detail('community', { store });
    const rows = [...document.querySelectorAll('[data-slot="community.list"] li')];
    expect(rows[0]).toHaveTextContent(seedText(direct[0].titleKey));
    expect(rows[1]).toHaveTextContent(seedText(direct[1].titleKey));
    expect(direct[0].respondBy < direct[1].respondBy).toBe(true);
    expect(rows[0]).toHaveTextContent('11/19(목) 18:00까지 응답');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(escapeRe(seedText(direct[1].titleKey))) }));
    expect(screen.getByText(`답할 제안 ${co.pendingCount}건`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '수락하기' }));
    expect(screen.getByText(`답할 제안 ${co.pendingCount - 1}건`)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('연락 수단: 가게 전화로 연락해요(예시)');
    expect(screen.getAllByText('진행 중').length).toBeGreaterThan(0);
    expect(host.calls.notify[0]).toMatchObject({ messageKey: 'data.notice.offerAccepted' });
  });
  it('decline, and 관심 보내기 only for public offers', () => {
    const store = storeWithOffers();
    const co = model('community', store);
    detail('community', { store });
    fireEvent.click(screen.getByRole('button', { name: '거절하기' }));
    expect(screen.getByText(`답할 제안 ${co.pendingCount - 1}건`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '동네 둘러보기' }));
    expect(screen.queryByRole('button', { name: '수락하기' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '관심 보내기' }));
    expect(screen.getByRole('status')).toHaveTextContent('관심을 보냈어요(예시)');
    expect(screen.queryByRole('button', { name: '관심 보내기' })).not.toBeInTheDocument();
  });
  it('the cafe sample (one direct offer, three browse-only public offers) fills the browse tab instead of an empty page', () => {
    // DATA-FIX item 6 (877f99a): three sample posts populate the public tab; the direct count stays 1.
    const co = model('community');
    expect(co.pendingCount).toBe(1);
    expect(co.publicOffers).toHaveLength(3);
    detail('community', { ref: { view: 'browse' } });
    for (const title of ['시험기간 공부 공간과 음료 제휴', '연말 꽃다발과 카페 방문 공동 행사', '주말 공방 체험과 디저트 산책']) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText('둘러볼 공개 제안이 없어요')).not.toBeInTheDocument();
  });
  it('a store with only direct offers still says so on the browse tab instead of an empty page', () => {
    const base = createSeedTables();
    const store = createWidgetDataStore({ partnershipOffer: base.partnershipOffer.filter((o) => o.visibility !== 'public') });
    expect(model('community', store).publicOffers).toHaveLength(0);
    detail('community', { store, ref: { view: 'browse' } });
    expect(screen.getByText('둘러볼 공개 제안이 없어요')).toBeInTheDocument();
  });
});

describe('D-231 compact errors', () => {
  it.each(['local-changes', 'trade-area', 'local-trends', 'ai-response', 'community'] as const)('%s has the short message and retry action', (id) => {
    panel(id, 1, 1, { preview: { family: 'error', overrides: {} } });
    expect(document.querySelector('.ui-panel-state__message')?.lastChild?.textContent).toBe('불러오지 못했어요');
    expect(screen.getByRole('button', { name: /다시 시도하기/ })).toBeInTheDocument();
    cleanup();
    panel(id, 2, 1, { preview: { family: 'error', overrides: {} } });
    expect(document.querySelector('.ui-panel-state__message')?.lastChild?.textContent).toBe('불러오지 못했어요');
    cleanup();
    panel(id, 3, 1, { preview: { family: 'error', overrides: {} } });
    expect(document.querySelector('.ui-panel-state__message')?.lastChild?.textContent).toMatch(/^.+(을|를) 불러오지 못했어요$/);
  });
});

describe('sample states (SCR-29)', () => {
  const states: readonly [FeatureId, string, string][] = [
    ['local-changes', 'none', '이번 주에는 동네 변화가 없어요'], ['local-changes', 'region-unsupported', '이 지역의 자료를 준비 중이에요'],
    ['trade-area', 'none', '표시할 자료가 없어요'], ['local-trends', 'insufficient', '표시할 자료가 없어요'],
    ['ai-response', 'none', '답변을 기다리는 메시지·리뷰가 없어요'], ['ai-response', 'channel-disconnected', '연결된 채널이 없어요'], ['community', 'none', '답할 제안이 없어요'],
  ];
  it.each(states)('%s · %s shows its sentence in the panel', (id, variant, sentence) => {
    panel(id, 2, 1, { preview: { family: 'normal', overrides: { [id]: variant } } });
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });
  it('error state has 다시 시도 that resets; community empty action opens its browse tab; no key text', () => {
    const a = panel('community', 1, 1, { preview: { family: 'error', overrides: {} } });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /다시 시도/ }));
    expect(a.host.calls.resetPreview).toBe(1);
    cleanup();
    const b = panel('community', 2, 1, { preview: { family: 'empty', overrides: {} } });
    fireEvent.click(screen.getByRole('button', { name: /동네 제안 보기/ }));
    expect(b.host.calls.openDetail).toEqual([{ featureId: 'community', view: 'browse' }]);
    expect(document.body.textContent).not.toMatch(/data\.state|widget\./);
  });
  it('all five error sentences exist in four languages', () => {
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      for (const w of widgets) { panel(w.id, 2, 1, { locale, preview: { family: 'error', overrides: {} } }); expect(document.body.textContent).not.toMatch(/data\.state/); cleanup(); }
    }
  });
});

describe('message bundle', () => {
  it('has no key shared with the base, data or kit bundles', () => {
    expect(findDuplicateKeys(mktLocalBundle, ...(baseBundles as unknown as readonly MessageBundle<string>[]), dataBundle, uiBundle)).toEqual([]);
    expect(findKoGaps(mktLocalBundle)).toEqual([]);
  });
  it('preserves translations and falls back to Korean for the two new state messages', () => {
    const koreanOnly = ['widget.local.state.error.short', 'widget.ai-response.state.disconnected.short', 'widget.ai-response.sent', 'widget.ai-response.send', 'widget.ai-response.post', 'widget.ai-response.autoSummary', 'widget.ai-response.autoEnabled', 'widget.community.accept', 'widget.community.decline', 'widget.community.state.none'];
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      expect(Object.keys(mktLocalBundle[locale]).sort()).toEqual(Object.keys(mktLocalBundle.ko).filter(key => !koreanOnly.includes(key)).sort());
      for (const key of koreanOnly) expect(mktLocalBundle[locale]).not.toHaveProperty(key);
    }
  });
  it('lists the rows R2 should review (not plan-1 rows)', () => {
    expect(mktLocalReviewKeys.length).toBeGreaterThan(50);
    expect(mktLocalReviewKeys).not.toContain('widget.ai-response.waiting');
  });
  it('does not use legacy copy helpers', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = `${process.cwd()}/src/features/widgets/mkt-local/`;
    for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes('.test.'))) expect(readFileSync(`${dir}${f}`, 'utf8')).not.toMatch(/uiCopy|groupLabels|businessLabels|starterLabel|formatNotice/);
  });
});


it('uses the correct comparison particle and accounts for hidden waiting channels', () => {
  const lt = model('local-trends');
  const ai = model('ai-response');
  detail('local-trends');
  expect(document.body.textContent).toContain(`${koRange(lt.previousPeriod.start, lt.previousPeriod.end)})와 비교했어요`);
  cleanup();
  panel('ai-response', 2, 1);
  const hidden = ai.byChannel.slice(2).reduce((sum, channel) => sum + channel.count, 0);
  expect(hidden).toBeGreaterThan(0);
  expect(document.querySelector('[data-slot="ai-response.list"]')).toHaveTextContent(`외 ${hidden}건`);
});

it('D231 presents a concise trend comparison and one auto-reply summary', () => {
  const lt = model('local-trends');
  detail('local-trends');
  expect(document.body.textContent).toContain(`${koRange(lt.period.start, lt.period.end)} · 지난주(${koRange(lt.previousPeriod.start, lt.previousPeriod.end)})와 비교했어요`);
  cleanup();
  detail('ai-response');
  expect(screen.getByText('자동 발송 없음 · 항상 미리보기 확인 후 테스트 발송')).toBeInTheDocument();
});
