import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { CellSpan, ContentShape, PreviewSelection, WidgetHost } from '../../../contracts';
import { createWidgetDataStore, dataBundles } from '../../../data/widget-data';
import { baseBundles, findDuplicateKeys, findKoGaps, type MessageBundle } from '../../../i18n';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import { renderWithKit, KitProviders } from '../../../ui/test-utils';
import { bundles, MKT_PROMO_KO_ONLY_KEYS, mktPromoBundle, mktPromoR2Review, widgets } from './index';
import { MarketingTodayPanel, cellText, slotCount, slotFit, useMarketingTodaySummary, useMarketingTodayTapTarget } from './marketing-today';
import { useT } from './shared';
import { cafeModel, makeHost, syncedCafeStore } from './test-helpers';

afterEach(cleanup);

/**
 * What the panel says, read from the cafe seed through the same selector (SEED-W1): the quiet window, the number waiting for a reply, and — once the
 * catalog holds photos — the photo count. A test names these values from the model so a seed change moves the data, not the assertion.
 */
const weekday = (locale: string, style: 'short' | 'long', date: string) => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
function sentences(store?: ReturnType<typeof createWidgetDataStore>) {
  const model = cafeModel('marketing-today', { kind: 'default' }, store);
  const quiet = model.cells.find((cell) => cell.kind === 'quiet-hours')!;
  const replies = model.cells.find((cell) => cell.kind === 'replies')!;
  const video = model.cells.find((cell) => cell.kind === 'video');
  if (quiet.kind !== 'quiet-hours' || replies.kind !== 'replies') throw new Error('cafe seed cells');
  const { date, startHour: s, endHour: e } = quiet.quietSlot;
  return {
    model, regulars: quiet.params.regulars, replies: replies.params.count, photos: video?.kind === 'video' ? video.params.photos : null,
    quietKo: `${weekday('ko', 'long', date)} ${s}~${e}시가 한산해요`, quietEn: (style: 'short' | 'long') => `${weekday('en', style, date)} ${s}–${e} is quiet`,
    repliesKo: `답변 기다리는 메시지·리뷰가 ${replies.params.count}건 있어요`,
  };
}
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
const variant = (id: string, state: string): PreviewSelection => ({ family: 'normal', overrides: { [id]: state } });
function panel(width: number, height: number, host: WidgetHost = makeHost(), options: Parameters<typeof renderWithKit>[1] = {}) {
  return renderWithKit(
    <MarketingTodayPanel featureId="marketing-today" condition={{ kind: 'default' }} width={width as CellSpan} height={height as CellSpan} shape={shapeOf(width, height)} presetId="A" editing={false} host={host} />,
    options,
  );
}

describe('mkt-promo module shape (API-13 v4.1)', () => {
  it('exports the two widgets (마케팅 성과 is gone, D-365), Detail = null only for marketing-today, and a complete 4-language bundle', () => {
    expect(widgets.map((m) => m.id)).toEqual(['marketing-today', 'promo-video']);
    const [today, video] = widgets;
    expect(today.Detail).toBeNull();
    expect(today.useTapTarget).toBeTypeOf('function');
    expect(video.Detail).toBeTypeOf('function');
    expect(bundles).toEqual([mktPromoBundle]);
    const keys = Object.keys(mktPromoBundle.ko);
    // D-83: the Korean-only F-50 keys have no en/zh values yet; every other key is in all four languages.
    const translated = keys.filter((key) => !MKT_PROMO_KO_ONLY_KEYS.includes(key));
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) expect(Object.keys(mktPromoBundle[locale]).sort()).toEqual([...translated].sort());
    expect(keys.every((key) => /^(widget\.(marketing-today|promo-video)\.|promo\.)/.test(key))).toBe(true);
    expect(mktPromoR2Review.strings).toBe(mktPromoR2Review.writtenRows * 3);
  });
  it('owns its prefix only: no key is also defined in the common, data or kit bundles, and no Korean gap', () => {
    expect(findDuplicateKeys(mktPromoBundle, ...(baseBundles as readonly MessageBundle<string>[]), ...dataBundles)).toEqual([]);
    expect(findKoGaps(mktPromoBundle)).toEqual([]);
  });
});

describe('오늘 할 홍보 sizes (AC-285)', () => {
  it('4x1 shows three single-sentence slots; taller panels retain the second sentences', () => {
    const store = syncedCafeStore(createWidgetDataStore());
    const text = sentences(store);
    panel(4, 1, makeHost(), { store });
    const slots = screen.getAllByRole('region').filter((el) => el.getAttribute('data-slot')?.startsWith('marketing-today.slot.'));
    expect(slots.map((el) => el.getAttribute('data-slot'))).toEqual(['marketing-today.slot.now', 'marketing-today.slot.today', 'marketing-today.slot.week']);
    expect(screen.getByText('이번 주')).toBeInTheDocument();
    expect(screen.getByText('내일부터 7일')).toBeInTheDocument();
    expect(screen.getByText('오늘')).toBeInTheDocument();
    expect(screen.getByText(text.quietKo)).toBeInTheDocument();
    expect(screen.queryByText(/그 시간에 자주 오던 단골이/)).toBeNull();
    expect(screen.getByText(text.repliesKo.replace('메시지·리뷰', '메시지\u2060·\u2060리뷰'))).toBeInTheDocument();
    expect(screen.queryByText(/답변 초안을 써 뒀어요/)).toBeNull();
    expect(screen.getByText(`영상에 쓸 사진 ${text.photos}장이 있어요`)).toBeInTheDocument();
    expect(screen.queryByText(/짧은 영상으로 만들어 볼까요\?/)).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      '쿠폰 보내기, 오늘 할 홍보', '답변 확인하기, 오늘 할 홍보', '영상 만들기, 오늘 할 홍보',
    ]);
    expect(document.querySelector('.mp-today')).toHaveAttribute('data-layout', 'columns');
    cleanup();
    panel(4, 2, makeHost(), { store });
    expect(screen.getByText(new RegExp(`그 시간에 자주 오던 단골이 ${text.regulars}명 있어요`))).toBeInTheDocument();
    expect(screen.getByText(/답변 초안을 써 뒀어요/)).toBeInTheDocument();
    expect(screen.queryByText(/짧은 영상으로 만들어 볼까요\?/)).toBeNull();
  });
  it('1x1 shows the first slot only with the short label; 2x1 the top two; 2x2 and larger all three', () => {
    expect(slotCount(1, 1)).toBe(1); expect(slotCount(2, 1)).toBe(2); expect(slotCount(4, 1)).toBe(3); expect(slotCount(1, 2)).toBe(2); expect(slotCount(1, 3)).toBe(3); expect(slotCount(2, 2)).toBe(3);
    const store = syncedCafeStore(createWidgetDataStore());
    const text = sentences(store);
    panel(1, 1, makeHost(), { store });
    expect(screen.getByText(text.quietKo)).toBeInTheDocument();
    expect(screen.queryByText(/답변 기다리는/)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '쿠폰 보내기, 오늘 할 홍보' })).toBeInTheDocument();
    cleanup();
    panel(2, 1, makeHost(), { store });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByText(/영상에 쓸 사진 \d+장이/)).toBeNull();
    cleanup();
    panel(2, 2, makeHost(), { store });
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });
  it('drops the second sentence first for English and for 125% text, then the time tag on preset A at 125% (D-65)', () => {
    expect(slotFit({ width: 4, height: 1, locale: 'ko', large: false, presetId: 'A' })).toMatchObject({ showSecond: false, showTag: true });
    expect(slotFit({ width: 4, height: 1, locale: 'en', large: false, presetId: 'A' })).toMatchObject({ showSecond: false, showTag: true });
    expect(slotFit({ width: 4, height: 1, locale: 'ko', large: true, presetId: 'A' })).toMatchObject({ showSecond: false, showTag: true });
    expect(slotFit({ width: 4, height: 1, locale: 'ko', large: true, presetId: 'B' })).toMatchObject({ showSecond: false, showTag: true });
    const store = syncedCafeStore(createWidgetDataStore());
    const text = sentences(store);
    panel(4, 1, makeHost(), { locale: 'en', store });
    expect(screen.getByText(text.quietEn('long'))).toBeInTheDocument();
    expect(screen.queryByText(/regulars often come/)).toBeNull();
    expect(screen.getByText('Next 7 days')).toBeInTheDocument();
    cleanup();
    panel(4, 1, makeHost(), { textScale: 125, store });
    expect(screen.queryByText(/자주 오던 단골/)).toBeNull();
    expect(document.querySelector('.mp-slot__tag')).toHaveTextContent('내일부터 7일');
    expect(screen.getByText('이번 주')).toHaveClass('mp-slot__tag');
    cleanup();
    panel(1, 1, makeHost(), { textScale: 125, store });
    expect(document.querySelector('.mp-slot__tag')).toHaveTextContent('내일부터 7일');
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  it('writes the sentences in all four languages from LOCALES 9.3', () => {
    const n = sentences().regulars;
    const wording: Record<string, string> = {
      en: n === 1 ? '1 regular often comes at that time.' : `${n} regulars often come at that time.`,
      'zh-Hans': `经常在这个时间来的熟客有 ${n} 位。`, 'zh-Hant': `經常在這個時間來的熟客有 ${n} 位。`,
    };
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      const { unmount } = renderWithKit(<TextProbe />, { locale });
      expect(screen.getByTestId('second')).toHaveTextContent(wording[locale]);
      unmount();
    }
  });
});

function TextProbe() {
  const view = useWidgetView('marketing-today');
  const t = useT();
  if (view.status !== 'ready') return null;
  return <p data-testid="second">{cellText(t, view.model.cells[0]).second}</p>;
}

describe('오늘 할 홍보 buttons (AC-286)', () => {
  it('each slot button opens the target widget detail with its action open, not the widget itself', async () => {
    const host = makeHost();
    panel(4, 1, host, { store: syncedCafeStore(createWidgetDataStore()) });
    await userEvent.click(screen.getByRole('button', { name: '쿠폰 보내기, 오늘 할 홍보' }));
    await userEvent.click(screen.getByRole('button', { name: '답변 확인하기, 오늘 할 홍보' }));
    await userEvent.click(screen.getByRole('button', { name: '영상 만들기, 오늘 할 홍보' }));
    expect(host.openDetail.mock.calls.map(([ref]) => ref)).toEqual([
      { featureId: 'slot-coupon', view: 'send', focus: 'action' },
      { featureId: 'ai-response', focus: 'action' },
      { featureId: 'promo-video', view: 'create', focus: 'action' },
    ]);
  });
  it('a body press target is the first visible slot (quiet hours), then the next slot once that is handled, and the active coupons when none is left', () => {
    const store = createWidgetDataStore();
    const wrapper = ({ children }: { children: React.ReactNode }) => <KitProviders store={store}>{children}</KitProviders>;
    const args = { featureId: 'marketing-today' as const, condition: { kind: 'default' as const } };
    const { result } = renderHook(() => ({ tap: useMarketingTodayTapTarget(args), slot: useWidgetView('slot-coupon'), dispatch: useDataDispatch() }), { wrapper });
    expect(result.current.tap).toBeNull();
    const slot = result.current.slot;
    if (slot.status !== 'ready') throw new Error('slot-coupon should be ready');
    act(() => { result.current.dispatch({ type: 'coupon.sendSlot', slotIds: slot.model.openSlots.map((s) => s.slotId), recipientIds: ['mc-01', 'mc-02', 'mc-03', 'mc-04', 'mc-05'], benefit: 'free-shot', idempotencyKey: 'tap-1' }); });
    // every quiet slot handled: the croissant takes the "now" cell
    expect(result.current.tap).toBeNull();
  });
  it('the empty state opens the active coupons (진행 중인 쿠폰), the error state has no target', () => {
    const args = { featureId: 'marketing-today' as const, condition: { kind: 'default' as const } };
    const empty = renderHook(() => useMarketingTodayTapTarget(args), { wrapper: ({ children }) => <KitProviders preview={variant('marketing-today', 'none')}>{children}</KitProviders> });
    expect(empty.result.current).toBeNull();
    const error = renderHook(() => useMarketingTodayTapTarget(args), { wrapper: ({ children }) => <KitProviders preview={variant('marketing-today', 'error')}>{children}</KitProviders> });
    expect(error.result.current).toBeNull();
  });
});

describe('오늘 할 홍보 handled and empty (AC-287, AC-322)', () => {
  it('shows the nothing-to-do sentence and a button to the active coupons; it never turns normal by itself', async () => {
    const host = makeHost();
    panel(4, 1, host, { preview: variant('marketing-today', 'none') });
    expect(screen.getByText('지금 급한 홍보는 없어요. 빈 시간 단골 쿠폰을 만들어 보세요')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '빈 시간 단골 쿠폰 열기, 오늘 할 홍보' }));
    expect(host.openDetail).toHaveBeenCalledWith({ featureId: 'slot-coupon', view: 'send' });
    expect(screen.queryByText('지금')).toBeNull();
  });
  it('failure has a retry that resets only this widget; partial keeps the other slots and says what is missing', async () => {
    const host = makeHost();
    panel(4, 1, host, { preview: variant('marketing-today', 'error') });
    await userEvent.click(screen.getByRole('button', { name: '다시 시도하기, 오늘 할 홍보' }));
    expect(host.resetPreview).toHaveBeenCalledTimes(1);
    cleanup();
    panel(4, 1, host, { preview: variant('marketing-today', 'partial'), store: syncedCafeStore(createWidgetDataStore()) });
    expect(screen.queryByText('오늘')).toBeNull();
    expect(screen.getByText('일부 홍보 항목을 확인하지 못했어요')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
  it('folds a handled slot away so the others share the width, and the expiring item replaces the "now" slot', () => {
    const store = createWidgetDataStore();
    function Probe() {
      const slot = useWidgetView('slot-coupon');
      const dispatch = useDataDispatch();
      // the cafe's selectable regulars (consenting customers) are the recipients; the coupon covers every open quiet slot
      return <button type="button" onClick={() => { if (slot.status === 'ready') dispatch({ type: 'coupon.sendSlot', slotIds: slot.model.openSlots.map((s) => s.slotId), recipientIds: slot.model.recipients.filter((r) => r.selectable).map((r) => r.customerId), benefit: 'free-shot', idempotencyKey: 'fold-1' }); }}>send-all</button>;
    }
    const before = sentences();
    function Expiry() {
      const view = useWidgetView('marketing-today');
      const t = useT();
      const cell = view.status === 'ready' ? view.model.cells[0] : null;
      return <p data-testid="first">{cell ? cellText(t, cell).first : ''}</p>;
    }
    renderWithKit(<><Probe /><Expiry /><MarketingTodayPanel featureId="marketing-today" condition={{ kind: 'default' }} width={4} height={1} shape="W" presetId="A" editing={false} host={makeHost()} /></>, { store });
    expect(screen.getAllByText(before.quietKo).length).toBeGreaterThan(0);
    act(() => { screen.getByText('send-all').click(); });
    expect(screen.queryByText(before.quietKo)).toBeNull();
    // the "now" slot is now the item that must sell out today (its name and count come from the cafe's stock batches)
    const expiring = cafeModel('marketing-today', { kind: 'default' }, store).cells[0];
    expect(expiring.kind).toBe('expiry');
    expect(screen.getByTestId('first')).toHaveTextContent(/오늘 안에 팔아야 해요/);
    expect(screen.getAllByText(/오늘 안에 팔아야 해요/).length).toBeGreaterThan(0);
    // DATA-FIX item 12 (877f99a): the cafe photo catalog gives the normal 36-photo state, so the video action stays available next to the expiring-stock coupon and the waiting replies.
    expect(screen.getAllByRole('button').filter((b) => b.getAttribute('aria-label')?.includes('오늘 할 홍보'))).toHaveLength(3);
  });
  it('the key sentence is the first slot first sentence', () => {
    const { result } = renderHook(() => useMarketingTodaySummary({ featureId: 'marketing-today', condition: { kind: 'default' } }), { wrapper: ({ children }) => <KitProviders>{children}</KitProviders> });
    expect(result.current).toBe(sentences().quietKo);
    const { result: empty } = renderHook(() => useMarketingTodaySummary({ featureId: 'marketing-today', condition: { kind: 'default' } }), { wrapper: ({ children }) => <KitProviders preview={variant('marketing-today', 'none')}>{children}</KitProviders> });
    expect(empty.current.replace(/\u00a0/g, ' ')).toBe('지금 급한 홍보는 없어요. 빈 시간 단골 쿠폰을 만들어 보세요');
  });
});

describe('오늘 할 홍보 within the panel (no overflow structure)', () => {
  it('has no more than three columns and keeps each slot an independent focus stop with exactly one button', () => {
    panel(4, 1);
    for (const slot of document.querySelectorAll('.mp-slot')) expect(within(slot as HTMLElement).getAllByRole('button')).toHaveLength(1);
  });
});

it('labels the quiet slot with the window it is read from (tomorrow + 6 days), never the calendar ‘다음 주’ (GD-3, S5-129)', () => {
  panel(2, 1);
  const tag = document.querySelector('[data-slot="marketing-today.slot.tag"]');
  expect(tag).toHaveTextContent('내일부터 7일');
  expect(tag).not.toHaveTextContent('다음 주');
});
