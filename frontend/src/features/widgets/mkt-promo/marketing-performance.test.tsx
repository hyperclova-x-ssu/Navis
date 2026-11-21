import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, ContentShape, PreviewSelection } from '../../../contracts';
import { MONTH_START, createWidgetDataStore } from '../../../data/widget-data';
import { useDataDispatch } from '../../../data/react';
import { renderWithKit, KitProviders } from '../../../ui/test-utils';
import { MarketingPerformanceDetail, MarketingPerformancePanel, metricBlocks, previousMonthRange, useMarketingPerformanceSummary } from './marketing-performance';
import { useT } from './shared';
import { cafeModel, makeHost, manText, rawOf, wonText } from './test-helpers';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
const variant = (state: string): PreviewSelection => ({ family: 'normal', overrides: { 'marketing-performance': state } });
const panel = (w: number, h: number, host = makeHost(), options: Parameters<typeof renderWithKit>[1] = {}) => renderWithKit(
  <MarketingPerformancePanel featureId="marketing-performance" condition={{ kind: 'default' }} width={w as CellSpan} height={h as CellSpan} shape={shapeOf(w, h)} presetId="A" editing={false} host={host} />, options);
const detail = (host = makeHost(), options: Parameters<typeof renderWithKit>[1] = {}, detailRef = { featureId: 'marketing-performance', view: 'route', focus: 'action' } as const) => renderWithKit(
  <MarketingPerformanceDetail featureId="marketing-performance" condition={{ kind: 'default' }} detailRef={detailRef} host={host} />, options);
/**
 * Numbers come from the 안숭잘부 카페 seed through the same selector the widget reads (SEED-W1), never from literals: this month is the demo
 * month so far (11/01~11/17), last month the previous calendar month (`previousMonthRange(MONTH_START)`).
 */
const thisMonth = (store?: ReturnType<typeof createWidgetDataStore>) => cafeModel('marketing-performance', { kind: 'default' }, store);
const lastMonth = () => cafeModel('marketing-performance', { kind: 'dateRange', ...previousMonthRange(MONTH_START) });
const routeName: Readonly<Record<string, string>> = { place_news: '플레이스 소식', blog: '블로그', clip: '클립 영상', sms: '단골 문자' };
const pct = (rate: number | null) => (rate === null ? '—' : `${rate}%`);
const arrow = (value: number) => (value > 0 ? 'up' : 'down');
/** `11월 1일~17일` as the panel writes a range inside one month. */
const rangeKo = (period: { readonly start: string; readonly end: string }) => `${Number(period.start.slice(5, 7))}월 ${Number(period.start.slice(8))}일~${Number(period.end.slice(8))}일`;
const row = (id: string) => document.querySelector(`[data-row-id="${id}"]`) as HTMLTableRowElement;
const cells = (el: HTMLElement) => [...el.querySelectorAll('th,td')].map((c) => c.textContent?.replace(/\s+/g, ' ').trim());

describe('마케팅 성과 panel sizes (AC-305)', () => {
  it('1x1: the coupon rate and its change with a 자세히 보기 button that opens the route table with focus', () => {
    const host = makeHost();
    const m = thisMonth();
    panel(1, 1, host);
    expect(screen.getByText(`${m.rate}%`)).toBeInTheDocument();
    expect(document.querySelector('.mp-block__label')).toHaveTextContent('쿠폰 사용률');
    expect(document.querySelector('[data-slot="marketing-performance.metric.desc"]')).toHaveTextContent(`${Math.abs(m.rateDelta!.value)}%p`);
    expect(document.querySelector('.mp-delta')).toHaveAttribute('data-direction', arrow(m.rateDelta!.value));
    act(() => { fireEvent.click(screen.getByRole('button', { name: '자세히 보기, 마케팅 성과' })); });
    expect(host.openDetail).toHaveBeenCalledWith({ featureId: 'marketing-performance', view: 'route', focus: 'action' });
  });
  it('2x1 shows the rate and the sales from promotions; 2x2 the four blocks', () => {
    const m = thisMonth();
    panel(2, 1);
    expect(screen.getByText(`${m.rate}%`)).toBeInTheDocument();
    expect(screen.getByText(manText(m.revenue.total))).toBeInTheDocument();
    expect(document.querySelectorAll('.mp-block')).toHaveLength(2);
    cleanup();
    panel(2, 2);
    expect(document.querySelectorAll('.mp-block')).toHaveLength(4);
  });
  it('4x1 shows four metrics, the best channel and the channel button in one row (rate, sales, profit, returning share)', () => {
    const m = thisMonth();
    panel(4, 1);
    const strip = document.querySelector('.mp-strip') as HTMLElement;
    expect(strip.querySelectorAll('.mp-block')).toHaveLength(4);
    const text = (id: string) => document.querySelector(`[data-slot="marketing-performance.metric.${id}"]`)?.textContent;
    expect(text('rate')).toBe(`${m.rate}%쿠폰 사용률${Math.abs(m.rateDelta!.value)}%p`);
    expect(text('revenue')).toBe(`${manText(m.revenue.total)}홍보로 생긴 매출${manText(m.revenueDelta!.value)}`);
    expect(text('profit')).toBe(`${manText(m.profit)}할인 후 실제 이익원가·할인 뺀 금액`);
    // The cafe seed has no campaign-attributed return visits.
    expect(text('return')).toBe('알 수 없어요다시 온 손님');
    for (const [id, amount] of [['revenue', manText(m.revenue.total)], ['profit', manText(m.profit)]] as const) {
      const metric = strip.querySelector(`[data-slot="marketing-performance.metric.${id}"] .ui-metric-fit`)!;
      expect(metric.textContent).toBe(amount);
      expect(metric.querySelector('.ui-metric-fit__value')?.textContent).toBe(amount.replace('만 원', '').trim());
      expect(metric.querySelector('.ui-metric-fit__unit')?.textContent).toBe('만 원');
    }
    const dirs = [...strip.querySelectorAll('.mp-delta')].map((el) => el.getAttribute('data-direction'));
    expect(dirs).toEqual([arrow(m.rateDelta!.value), arrow(m.revenueDelta!.value)]);
    expect(document.querySelector('[data-slot="marketing-performance.best"]')).toHaveTextContent(`${rangeKo(m.period)}${routeName[m.best!.route]} ${m.best!.rate}%가장 잘된 경로`);
    expect(screen.getByRole('button', { name: '경로별 자세히 보기, 마케팅 성과' })).toBeInTheDocument();
    expect(strip.querySelectorAll('.mp-strip__blocks > .mp-block')).toHaveLength(4); // never more than 4 blocks + the best-channel column
    expect(Array.from(strip.children).filter((child) => !child.hasAttribute('data-fit-probe'))).toHaveLength(2);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  it('4x1 drops the first supplementary line (사용·발행) for English and 125% text; money follows the language', () => {
    const m = thisMonth();
    const won = (amount: number) => `₩${Math.round(amount).toLocaleString('en-US')}`;
    panel(4, 1, makeHost(), { locale: 'en' });
    expect(document.querySelector('[data-slot="marketing-performance.metric.sub"]')).toBeNull();
    expect(screen.getByText(won(m.revenue.total))).toBeInTheDocument();
    expect(screen.getByText(won(m.profit))).toBeInTheDocument();
    cleanup();
    panel(4, 1, makeHost(), { textScale: 125 });
    expect(document.querySelector('[data-slot="marketing-performance.metric.sub"]')).toBeNull();
    expect(document.querySelectorAll('.ui-metric-fit').length).toBe(4);
    cleanup();
    panel(4, 1, makeHost(), { locale: 'zh-Hans' });
    expect(screen.getByText(`${(Math.round(m.revenue.total / 1000) / 10).toFixed(1)}万韩元`)).toBeInTheDocument();
  });
  it('4x2 adds the four channel lines; the best channel is named', () => {
    const m = thisMonth();
    panel(4, 2);
    expect(document.querySelectorAll('.mp-routes li')).toHaveLength(4);
    for (const route of m.routes) expect(document.querySelector(`.mp-routes [data-row-id="${route.route}"]`)).toHaveTextContent(`${routeName[route.route]}${route.issued} · ${route.used} · ${pct(route.rate)}`);
    expect(screen.getByText(`가장 잘된 경로: ${routeName[m.best!.route]} ${m.best!.rate}%`)).toBeInTheDocument();
  });
  it('uses MetricFit with minStage 1 at 125% on 1x1 so the PanelAction fits', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240);
    panel(1, 1, makeHost(), { textScale: 125 });
    expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage', '1');
    width.mockRestore();
    cleanup();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240);
    panel(1, 1);
    expect(document.querySelector('.ui-metric-fit')).toHaveAttribute('data-stage', '0');
    expect(document.querySelector('[data-slot="marketing-performance.metric.desc"]')).not.toBeNull();
  });
  it('empty says what is missing and offers the next step, failure retries, partial keeps the values and flags the missing ones', () => {
    const host = makeHost();
    panel(2, 1, host, { preview: variant('no-redemptions') });
    expect(screen.getByText('쿠폰이 사용되면 여기서 효과를 보여 드릴게요')).toBeInTheDocument();
    // H1/A10: the empty state has a next step (send a coupon), not only a sentence
    expect(screen.getAllByRole('button')).toHaveLength(1);
    act(() => { fireEvent.click(screen.getByRole('button', { name: '쿠폰 보내기, 마케팅 성과' })); });
    expect(host.openDetail).toHaveBeenCalledWith({ featureId: 'slot-coupon', view: 'send', focus: 'action' });
    cleanup();
    panel(2, 1, host, { preview: variant('error') });
    act(() => { fireEvent.click(screen.getByRole('button', { name: '다시 시도하기, 마케팅 성과' })); });
    expect(host.resetPreview).toHaveBeenCalledTimes(1);
    cleanup();
    panel(4, 1, host, { preview: variant('partial') });
    expect(screen.getByText('일부 지표 값이 비어 있어요')).toBeInTheDocument();
    expect(screen.getByText('확인 필요')).toBeInTheDocument();
  });
  it('summary includes the four metrics and their changes', () => {
    const m = thisMonth();
    const { result } = renderHook(() => useMarketingPerformanceSummary({ featureId: 'marketing-performance', condition: { kind: 'default' } }), { wrapper: ({ children }) => <KitProviders>{children}</KitProviders> });
    const mark = (value: number) => (value > 0 ? '▲' : '▼');
    expect(result.current).toBe([
      `쿠폰 사용률 ${m.rate}% ${mark(m.rateDelta!.value)}${Math.abs(m.rateDelta!.value)}%p`,
      `홍보로 생긴 매출 ${manText(m.revenue.total)} ${mark(m.revenueDelta!.value)}${manText(m.revenueDelta!.value)}`,
      `할인 후 실제 이익 ${manText(m.profit)}`,
      '다시 온 손님 알 수 없어요',
    ].join('\u00a0·\u00a0'));
  });
  it('metric blocks take every value from the data model (no copies)', () => {
    const { result } = renderHook(() => metricBlocks(useT(), { rate: 22, rateDelta: { value: 3, kind: 'pp' }, used: 28, issued: 125, revenue: { total: 624000, coupon: 481000, attributed: 143000 }, revenueDelta: { value: 81000, kind: 'count', unit: 'KRW' }, profit: 410000, returnRate: 31, returnRateDelta: { value: -2, kind: 'pp' } } as never), { wrapper: ({ children }) => <KitProviders>{children}</KitProviders> });
    expect(result.current.map((b) => b.value)).toEqual(['22%', '62.4만 원', '41.0만 원', '31%']);
    expect(result.current[0].sub).toBe('사용 28장\u00A0·\u00A0발행 125장');
  });
});


describe('마케팅 성과 detail (AC-306)', () => {
  it.each([[100, '56px'], [125, '64px']] as const)('aligns counts and the rate on the right and sets the row minimum across all tabs at %i percent', (textScale, rowMin) => {
    const { container } = detail(makeHost(), { textScale });
    const style = document.createElement('style');
    style.textContent = ['src/ui/tokens.css', 'src/ui/mastermanage.css', 'src/features/widgets/mkt-promo/widget.css']
      .map(path => readFileSync(path, 'utf8')).join('\n');
    container.prepend(style);

    for (const tab of ['경로별', '쿠폰별', '영상별']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      const table = screen.getByRole('table');
      // A2: every number column and its header sit on the right, the rate column included
      for (const name of ['발행', '사용', '사용률']) {
        const header = within(table).getByRole('columnheader', { name });
        expect(header).toHaveAttribute('data-numeric', 'true');
        expect(getComputedStyle(header).textAlign).toBe('end');
      }
      const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody > tr'));
      expect(rows.length).toBeGreaterThan(0);
      expect(getComputedStyle(table.closest('[data-text-scale]')!).getPropertyValue('--table-row-min').trim()).toBe(rowMin);
      for (const entry of rows) {
        expect(getComputedStyle(entry).height).toBe('var(--table-row-min)');
        for (const count of [entry.cells[1]!, entry.cells[2]!, entry.cells[3]!]) {
          expect(count).toHaveAttribute('data-numeric', 'true');
          expect(getComputedStyle(count).textAlign).toBe('end');
        }
      }
      // a row with a rate carries its indicator bar (a row without any use shows a dash)
      const withRate = rows.filter((entry) => entry.cells[3]!.textContent !== '—');
      if (tab !== '영상별') expect(withRate.length).toBeGreaterThan(0);
      if (withRate[0]) expect(within(withRate[0].cells[3]!).getByRole('img')).toHaveTextContent('%');
    }
  });

  it.each([
    { name: 'a lower last month', lastMonthChange: 0 },
    { name: 'a higher last month', lastMonthChange: -1_200_000 },
  ])('explains the sales comparison in exact won ($name), written the way the sales are', ({ lastMonthChange }) => {
    const { marketing } = createWidgetDataStore().getSnapshot().tables;
    const perfFixed = marketing.perfFixed.map(row => row.period === 'last-month'
      ? { ...row, revenueAttributed: row.revenueAttributed + lastMonthChange }
      : row);
    const store = createWidgetDataStore({ marketing: { ...marketing, perfFixed } });
    const change = thisMonth(store).revenueDelta!.value;
    // DS 6.1: exact won beside the exact-won sales, not a mix with `8.1만 원`
    const sentence = `지난달보다 ${wonText(Math.abs(change))} ${change > 0 ? '늘었어요' : '줄었어요'}`;
    expect(Math.sign(change)).toBe(lastMonthChange === 0 ? -1 : 1);
    const { container } = detail(makeHost(), { store });
    const revenue = container.querySelector<HTMLElement>('[data-slot="marketing-performance.metric.revenue"]')!;
    expect(within(revenue).getByText(sentence)).toBeInTheDocument();
    expect(revenue.querySelector('.mp-delta')).toBeNull();
    expect(revenue.textContent).not.toMatch(/만 원/);
    const profit = container.querySelector<HTMLElement>('[data-slot="marketing-performance.metric.profit"]')!;
    expect(within(profit).getByText('원가·할인 뺀 금액')).toBeInTheDocument();
  });

  it('route table lists every channel with its issued, used and rate, and the total; indicator bars carry the number', () => {
    const m = thisMonth();
    detail();
    for (const route of m.routes) expect(cells(row(route.route))).toEqual([routeName[route.route], String(route.issued), String(route.used), pct(route.rate)]);
    expect(cells(row('total'))).toEqual(['합계', String(m.issued), String(m.used), pct(m.rate)]);
    const withUse = m.routes.find((route) => route.rate !== null)!;
    expect(within(row(withUse.route)).getByRole('img')).toHaveAccessibleName(new RegExp(`${withUse.rate}%`));
    expect(screen.getByRole('table', { name: '경로별 발행·사용·사용률' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['경로', '발행', '사용', '사용률']);
  });
  it('KPIs and folded calculations in exact won, the basis line, and no insight card while only one channel has uses', () => {
    const m = thisMonth();
    detail();
    const kpis = document.querySelector('[data-slot="marketing-performance.kpis"]') as HTMLElement;
    expect(kpis.textContent).toContain(`${m.rate}%`);
    // DS 15.6-3: the detail is outside the six compact-money locations.
    expect(kpis.textContent).toContain(wonText(m.revenue.total));
    expect(kpis.textContent).toContain(wonText(m.profit));
    expect(kpis.textContent).toContain('알 수 없어요');
    expect(screen.queryByText(/쿠폰 코드 사용\)/)).toBeNull(); // the calculations are folded
    act(() => { fireEvent.click(screen.getByRole('button', { name: '계산 보기' })); });
    expect(screen.getByText(`${wonText(m.revenue.total)} = ${wonText(m.revenue.coupon)}(쿠폰 코드 사용) + ${wonText(m.revenue.attributed)}(홍보 후 14일 안 단골)`)).toBeInTheDocument();
    expect(screen.getByText(`${wonText(m.profit)} = ${wonText(m.revenue.total)} − ${wonText(m.cost)}(원가) − ${wonText(m.discount)}(할인액)`)).toBeInTheDocument();
    expect(screen.getByText(`${m.rate}% = ${m.used} ÷ ${m.issued}`)).toBeInTheDocument();
    expect(screen.getByText('사용률은 코드를 쓴 경우만, 매출은 홍보 후 14일 안 방문까지 세요')).toBeInTheDocument();
    // the fixed comparison needs two channels with uses; the cafe has one, so the model has none and the window shows no card
    expect(m.insight).toBeNull();
    expect(document.querySelector('.ui-insight-card')).toBeNull();
    expect(screen.getAllByRole('button').filter((b) => /쿠폰 보내기|올려/.test(b.textContent ?? ''))).toHaveLength(0); // no automatic improvement UI
  });
  it('last month is the previous calendar month of the business date, and returning to this month shows the first values again', () => {
    const m = thisMonth();
    const last = lastMonth();
    expect(last.period).toEqual(previousMonthRange(MONTH_START));
    expect(last.periodKind).toBe('last-month');
    detail();
    act(() => { fireEvent.click(screen.getByRole('radio', { name: '지난달' })); });
    expect(screen.queryByText(/불러오기 실패/)).toBeNull();
    expect(screen.getByText(`${Number(last.period.start.slice(5, 7))}월 ${Number(last.period.start.slice(8))}일~${Number(last.period.end.slice(8))}일`)).toBeInTheDocument();
    expect(cells(row('total'))).toEqual(['합계', String(last.issued), String(last.used), pct(last.rate)]);
    expect(screen.getByText('지난달은 고정 예시값이에요')).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByRole('radio', { name: '이번 달' })); });
    expect(cells(row('total'))).toEqual(['합계', String(m.issued), String(m.used), pct(m.rate)]);
  });
  it('previousMonthRange follows the date it is given, across a year start and a short month', () => {
    expect(previousMonthRange('2026-11-01')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(previousMonthRange('2027-01-01')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
    expect(previousMonthRange('2026-03-01')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
  it('a route row opens the side panel with that channel\'s coupon lines (aria-selected row), and the coupon and video tabs list their rows', () => {
    const m = thisMonth();
    const sms = m.routes.find((route) => route.route === 'sms')!;
    detail();
    expect(row('sms')).toHaveAttribute('aria-selected', 'false');
    act(() => { fireEvent.click(screen.getByRole('button', { name: '단골 문자' })); });
    expect(row('sms')).toHaveAttribute('aria-selected', 'true');
    const panelRegion = screen.getByRole('region', { name: '단골 문자 쿠폰·영상' });
    expect(panelRegion).toHaveClass('ui-detail-side-panel');
    const lines = document.querySelector('[data-slot="marketing-performance.route-lines"]') as HTMLElement;
    expect(lines).toHaveTextContent(rawOf(sms.lines[0]!.name));
    // the direct label beside the bar says what the bar counts
    expect(lines).toHaveTextContent(`${sms.lines[0]!.issued}장 중 ${sms.lines[0]!.used}장 사용`);
    act(() => { fireEvent.click(screen.getByRole('tab', { name: '쿠폰별' })); });
    expect(row(m.byCoupon[0]!.couponId)).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByRole('tab', { name: '영상별' })); });
    expect(row('clip')).toBeInTheDocument();
    expect(screen.queryByText(/아직 올린 영상이 없어요/)).toBeNull();
  });
  it('pressing anywhere in a route row selects it, a second press closes the panel, and a coupon-less channel says so', () => {
    detail();
    act(() => { fireEvent.click(row('blog').cells[1]!); });
    expect(row('blog')).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('[data-slot="marketing-performance.route-lines"]')).toHaveTextContent('이 경로로 나간 쿠폰이 아직 없어요');
    act(() => { fireEvent.click(row('place_news').cells[3]!); });
    expect(row('blog')).toHaveAttribute('aria-selected', 'false');
    expect(row('place_news')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('region').filter((el) => el.classList.contains('ui-detail-side-panel'))).toHaveLength(1);
    act(() => { fireEvent.click(row('place_news').cells[1]!); });
    expect(row('place_news')).toHaveAttribute('aria-selected', 'false');
  });
  it('GD-3: the route lines add up to the route row (ended coupon codes included) and say when a coupon ended', () => {
    const { marketing } = createWidgetDataStore().getSnapshot().tables;
    const store = createWidgetDataStore({ marketing: { ...marketing, coupon: marketing.coupon.map((coupon) => ({ ...coupon, status: 'ended' as const })) } });
    detail(makeHost(), { store });
    const numbers = (id: string) => { const [, issued, used] = cells(row(id)); return { issued: Number(issued), used: Number(used) }; };
    for (const [route, name] of [['place_news', '플레이스 소식'], ['blog', '블로그'], ['sms', '단골 문자']] as const) {
      act(() => { fireEvent.click(screen.getByRole('button', { name })); });
      const lines = document.querySelector('[data-slot="marketing-performance.route-lines"]') as HTMLElement;
      const { issued, used } = numbers(route);
      if (issued === 0 && used === 0) {
        expect(lines, name).toHaveTextContent('이 경로로 나간 쿠폰이 아직 없어요');
        expect(lines.querySelectorAll('li'), name).toHaveLength(0);
      } else {
        expect(lines.querySelector('[data-slot="marketing-performance.route-lines.sum"]'), name).toHaveTextContent(`합계 ${issued}장 발행 · ${used}장 사용`);
        expect(lines.querySelectorAll('li').length, name).toBeGreaterThan(0);
      }
    }
    act(() => { fireEvent.click(screen.getByRole('button', { name: '단골 문자' })); });
    expect(document.querySelector('[data-slot="marketing-performance.route-lines"]')).toHaveTextContent(/\(끝남\)/);
  });
  it('GD-3: last month has channel totals only, so a route row says so instead of showing this month\'s coupons', () => {
    detail();
    act(() => { fireEvent.click(screen.getByRole('radio', { name: '지난달' })); });
    act(() => { fireEvent.click(screen.getByRole('button', { name: '플레이스 소식' })); });
    expect(document.querySelector('[data-slot="marketing-performance.route-lines"]')).toHaveTextContent('지난달은 경로별 합계만 있어요');
    expect(document.querySelector('[data-slot="marketing-performance.route-lines"] li')).toBeNull();
  });
  it('opens on the coupon tab for view=coupon and marks the item', () => {
    const couponId = thisMonth().byCoupon[0]!.couponId;
    detail(makeHost(), {}, { featureId: 'marketing-performance', view: 'coupon', itemId: couponId } as never);
    expect(row(couponId)).toHaveAttribute('data-selected', 'true');
    expect(row(couponId)).toHaveAttribute('aria-selected', 'true');
  });
  it('empty state of the detail offers the next step; failure has a retry', () => {
    const host = makeHost();
    detail(host, { preview: variant('no-redemptions') });
    expect(screen.getByText('쿠폰이 사용되면 여기서 효과를 보여 드릴게요')).toBeInTheDocument();
    expect(screen.getByText('먼저 단골에게 쿠폰을 보내 보세요')).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByRole('button', { name: '쿠폰 보내기' })); });
    expect(host.openLinked).toHaveBeenCalledWith({ featureId: 'slot-coupon', view: 'send', focus: 'action' });
    cleanup();
    detail(host, { preview: variant('error') });
    act(() => { fireEvent.click(screen.getByRole('button', { name: '다시 시도하기, 마케팅 성과' })); });
    expect(host.resetPreview).toHaveBeenCalled();
  });
});

describe('제안 → 실행 → 성과 (F-55, AC-313/314)', () => {
  /** The cafe's selectable regulars for the first open quiet slot they can take (the coupon goes to them). */
  function sendArgs(store: ReturnType<typeof createWidgetDataStore>, key: string) {
    const slot = cafeModel('slot-coupon', { kind: 'default' }, store);
    const recipient = slot.recipients.find((r) => r.selectable)!;
    return { type: 'coupon.sendSlot' as const, slotIds: [recipient.slotIds[0]!], recipientIds: [recipient.customerId], benefit: 'free-shot' as const, idempotencyKey: key };
  }
  it('sending a slot coupon elsewhere raises issued and moves the rate and the sms line in the same frame, with the "just sent" note; usage, sales, profit and returning stay', () => {
    const store = createWidgetDataStore();
    const host = makeHost();
    const before = thisMonth(store);
    function Send() {
      const dispatch = useDataDispatch();
      return <button type="button" onClick={() => dispatch(sendArgs(store, 'perf-1'))}>send</button>;
    }
    renderWithKit(<><Send />
      <MarketingPerformancePanel featureId="marketing-performance" condition={{ kind: 'default' }} width={4} height={1} shape="W" presetId="A" editing={false} host={host} />
      <MarketingPerformanceDetail featureId="marketing-performance" condition={{ kind: 'default' }} detailRef={{ featureId: 'marketing-performance' }} host={host} /></>, { store });
    expect(cells(row('total'))).toEqual(['합계', String(before.issued), String(before.used), pct(before.rate)]);
    expect(document.querySelector('[data-slot="marketing-performance.recent"]')).toBeNull();
    act(() => { screen.getByText('send').click(); });
    const after = thisMonth(store);
    expect(after.issued).toBe(before.issued + 1);
    expect(after.used).toBe(before.used);
    expect(after.rate).toBeLessThan(before.rate!);
    expect(cells(row('total'))).toEqual(['합계', String(after.issued), String(after.used), pct(after.rate)]);
    const sms = after.routes.find((route) => route.route === 'sms')!;
    expect(cells(row('sms'))).toEqual(['단골 문자', String(sms.issued), String(sms.used), pct(sms.rate)]);
    expect(document.querySelector('[data-slot="marketing-performance.metric.rate"]')).toHaveTextContent(`${after.rate}%쿠폰 사용률${Math.abs(after.rateDelta!.value)}%p`);
    expect(document.querySelector('[data-slot="marketing-performance.recent"]')).toHaveTextContent(`방금 보낸 쿠폰 ${after.recentIssued}장이 발행에 더해졌어요. 사용은 쿠폰이 쓰이면 늘어요`);
    expect(after.recentIssued).toBe(1);
    const kpis = document.querySelector('[data-slot="marketing-performance.kpis"]') as HTMLElement;
    expect(after.revenue.total).toBe(before.revenue.total);
    expect(after.profit).toBe(before.profit);
    expect(after.returnRate).toBe(before.returnRate);
    expect(kpis.textContent).toContain(wonText(before.revenue.total));
    expect(kpis.textContent).toContain(wonText(before.profit));
    expect(kpis.textContent).toContain('알 수 없어요');
    expect(document.querySelector('.mp-flash[data-flash="true"]')).not.toBeNull(); // M-27 highlight
  });
  it('the numbers appear in the detail even when no panel is on the dashboard (one source)', () => {
    const store = createWidgetDataStore();
    const first = thisMonth(store).byCoupon[0]!;
    store.dispatch(sendArgs(store, 'perf-2'));
    const after = thisMonth(store);
    detail(makeHost(), { store });
    act(() => { fireEvent.click(screen.getByRole('tab', { name: '쿠폰별' })); });
    expect(document.body.textContent).toContain('빈 시간 샷 추가 무료'); // GD-3: the slot coupon name no longer says ‘다음 주’
    const couponRow = after.byCoupon.find((coupon) => coupon.couponId === first.couponId)!;
    expect(cells(row(first.couponId))).toEqual([rawOf(couponRow.name), String(couponRow.issued), String(couponRow.used), pct(couponRow.rate)]);
    fireEvent.click(screen.getByRole('tab', { name: '경로별' }));
    expect(cells(row('total'))[1]).toBe(String(after.issued));
  });
});
