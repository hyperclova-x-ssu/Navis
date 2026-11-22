/**
 * PAR-3 example adapter for the neighbourhood widgets (D-384, D-355): the example (fixture) mode shows the same screen as the real mode, so the
 * parts the real service adds — the official source line, the hourly POS sales, the coverage line, the offers' peers, the Café boards — are
 * derived here from the same fixture tables the rest of the example mode reads. Nothing here is written to the snapshot (Navis reads the
 * snapshot, and a populated `realLocal` would switch its real-mode answers on), and nothing leaves the browser.
 */
import { APP_CLOCK } from '../../../data/db/app-clock';
import { addDays, weekdayOf } from '../../../data/db/time';
import type { DataSnapshot, LocalChange } from '../../../data/db/types';
import type { ReviewInsightsDto, ReviewStatsUnit } from '../../../data/reality/15/dto';
import type { ChangeDto, ChangeKind, CoverageDto, HourlySale, MenuSale, PeriodDto, PopulationBand, SearchLinksDto, SearchSeries, TradeDto } from '../../../data/reality/13/dto';

/** The Seoul open-data dataset the real service cites for the hourly movement estimate. */
export const SEOUL_POPULATION_URL = 'https://data.seoul.go.kr/dataList/OA-23016/S/1/datasetView.do';
export const EXAMPLE_REGION = '서울 동작구 상도동';
export const EXAMPLE_STOREFRONT_ADDRESS = `${EXAMPLE_REGION} 999-12`;
const REFERENCE_LAG_DAYS = 3;

const calendarDay = APP_CLOCK.calendarDate;
/** The same trailing seven business days the real service reads for POS sales. */
export const examplePeriod = (): PeriodDto => ({ from: addDays(APP_CLOCK.businessDate, -6), to: APP_CLOCK.businessDate });

/** POS quantities by hour and by menu-and-day over the period, from the fixture orders (cancelled quantities and cancelled orders do not count). */
function soldLines(snapshot: DataSnapshot, period: PeriodDto) {
  const rows: { readonly date: string; readonly hour: number; readonly menuId: string; readonly name: string; readonly quantity: number }[] = [];
  for (const order of snapshot.pos?.orders ?? []) {
    const date = order.orderedAt.slice(0, 10);
    if (order.preparation === 'canceled' || date < period.from || date > period.to) continue;
    for (const line of order.lines) {
      const quantity = line.qty - line.canceledQty;
      if (quantity > 0) rows.push({ date, hour: Number(order.orderedAt.slice(11, 13)), menuId: line.menuId, name: line.nameAtOrder, quantity });
    }
  }
  return rows;
}

export function exampleHourlySales(snapshot: DataSnapshot, period: PeriodDto): readonly HourlySale[] {
  const byHour = new Map<number, number>();
  for (const row of soldLines(snapshot, period)) byHour.set(row.hour, (byHour.get(row.hour) ?? 0) + row.quantity);
  return [...byHour].sort(([a], [b]) => a - b).map(([hour, quantity]) => ({ hour, quantity, settlementIds: [] }));
}

export function exampleMenuSales(snapshot: DataSnapshot, period: PeriodDto): readonly MenuSale[] {
  const byKey = new Map<string, MenuSale>();
  for (const row of soldLines(snapshot, period)) {
    const key = `${row.menuId}|${row.date}`;
    const previous = byKey.get(key);
    byKey.set(key, { menuId: row.menuId, menuName: row.name, businessDate: row.date, quantity: (previous?.quantity ?? 0) + row.quantity });
  }
  return [...byKey.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.menuId.localeCompare(b.menuId));
}

/** The real `TradeDto` shape from the fixture's hourly movement estimate and POS orders. */
export function exampleTrade(snapshot: DataSnapshot, asOf: string): TradeDto {
  const period = examplePeriod();
  const quarter = `${calendarDay.slice(0, 4)}-Q${Math.ceil(Number(calendarDay.slice(5, 7)) / 3)}`;
  const weekday = weekdayOf(calendarDay);
  const referenceDate = addDays(calendarDay, -REFERENCE_LAG_DAYS);
  const items: PopulationBand[] = [...snapshot.tables.footTraffic].sort((a, b) => a.hour - b.hour).map(row => ({
    region: EXAMPLE_REGION, quarter, weekday, startHour: row.hour, endHour: row.hour + 1, estimate: row.estPeople, referenceDate, refreshedAt: asOf, sourceUrl: SEOUL_POPULATION_URL,
  }));
  const sales = exampleHourlySales(snapshot, period);
  return { asOf, period, population: { status: items.length ? 'available' : 'empty', quarter, weekday, items }, sales: { status: sales.length ? 'available' : 'empty', items: sales } };
}

/** The official feeds the example mode "covers": the same region and kinds the real service reports for the store. */
export function exampleCoverage(): CoverageDto {
  return { region: EXAMPLE_REGION, kinds: ['food-license', 'festival'], referenceDate: addDays(calendarDay, -REFERENCE_LAG_DAYS) };
}

/** The official source each kind of sample change cites (the datasets the real service reads); a construction notice has none, so it reads as the owner's own record. */
const OFFICIAL: Readonly<Record<'food-license' | 'festival', { readonly authority: string; readonly url: string; readonly dateKind: ChangeDto['dateKind'] }>> = {
  'food-license': { authority: '서울특별시 동작구', url: 'https://data.seoul.go.kr/dataList/OA-18696/S/1/datasetView.do', dateKind: 'license-date' },
  festival: { authority: '서울특별시 동작구', url: 'https://data.seoul.go.kr/dataList/OA-18671/S/1/datasetView.do', dateKind: 'event-date' },
};

/** The service's change record for each fixture row: an owner's own entry (`seed:` source) or a sample row dressed with its official source. */
export function exampleChange(row: LocalChange): ChangeDto {
  const own = row.sourceKey.startsWith('seed:') || row.kind === 'construction';
  const kind: ChangeKind = own ? 'owner-record' : row.kind === 'event' ? 'festival' : 'food-license';
  const official = kind === 'owner-record' ? undefined : OFFICIAL[kind];
  return { id: row.changeId, revision: 1, title: row.titleKey, kind, region: row.region ?? EXAMPLE_REGION,
    authority: own ? (row.sourceKey.startsWith('seed:') ? row.sourceKey.slice(5) : '사장님 기록') : official!.authority,
    sourceUrl: row.sourceUrl !== undefined ? row.sourceUrl : official?.url ?? null,
    dateKind: official?.dateKind ?? 'recorded-date', referenceDate: row.startDate, updatedAt: row.updatedAt, acknowledgedAt: row.ackedAt };
}

/**
 * The example mode's search-interest lookup (PN10): an answer only for a keyword the example data holds, never invented for any other.
 * The relative index runs from the keyword's previous count to its current one over the period, scaled so the highest day is 100;
 * the two result links open NAVER's own blog and Café searches for that keyword.
 */
export function exampleSearch(keyword: string, period: PeriodDto, keywords: readonly { readonly name: string; readonly mentions: number; readonly previous: number | null }[]): { readonly search: SearchSeries; readonly links: SearchLinksDto } {
  const key = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
  const found = keywords.find(row => key(row.name) === key(keyword));
  const days = Array.from({ length: 7 }, (_, index) => addDays(period.from, index));
  const items = found ? days.map((day, index) => {
    const from = found.previous ?? found.mentions;
    const count = from + (found.mentions - from) * (index / (days.length - 1));
    return { period: day, ratio: Math.round(1000 * count / Math.max(found.mentions, from, 1)) / 10 };
  }) : [];
  const query = { startDate: period.from, endDate: period.to, keywordGroups: [{ groupName: keyword }] };
  const search: SearchSeries = { status: found ? 'available' : 'empty', items, query };
  const link = (where: 'blog' | 'article', label: string) => found ? { status: 'available' as const, items: [{ title: `${found.name} · ${label}`, url: `https://search.naver.com/search.naver?where=${where}&query=${encodeURIComponent(found.name)}` }] } : { status: 'empty' as const, items: [] };
  return { search, links: { source: 'naver-search', use: 'display-only', blog: link('blog', '블로그 글 검색'), cafearticle: link('article', '카페 글 검색'),
    news: { status: 'empty', items: [] }, local: { status: 'empty', items: [] } } };
}

/**
 * The example mode's review statistics and average (the insight service's answer, PN03): the provider's two-day lag and period are the same,
 * the average is the mean of the example reviews' own star ratings (shown from ten raters up, like the provider), and no theme or keyword is
 * made up — the example reviews carry none, so the statistics say so in the screen's own empty state.
 */
export function exampleInsights(snapshot: DataSnapshot, unit: ReviewStatsUnit): ReviewInsightsDto {
  const through = addDays(APP_CLOCK.businessDate, -2);
  const from = addDays(through, unit === 'day' ? 0 : unit === 'week' ? -6 : -29);
  const ratings = snapshot.tables.inquiryThread.flatMap(row => row.type === 'review' && row.rating !== null ? [row.rating] : []);
  const average = ratings.length >= 10 ? Math.round(10 * ratings.reduce((sum, value) => sum + value, 0) / ratings.length) / 10 : null;
  return { state: 'ready', asOf: APP_CLOCK.local, businessDate: APP_CLOCK.businessDate,
    statistics: { state: 'ready', source: 'naver-review-statistics', sourceUrl: 'https://help.naver.com/service/30026/contents/24863?lang=ko',
      period: { unit, from, to: through }, coverage: { requestedTo: APP_CLOCK.businessDate, dataThrough: through, lagDays: 2 }, themes: [], topKeywords: { positive: [], negative: [] } },
    averageRating: { state: average === null ? 'hidden' : 'shown', source: 'naver-place-visitor-reviews', sourceUrl: 'https://help.naver.com/service/30026/contents/20497?lang=ko', value: average, minimumReviewers: 10 } };
}
