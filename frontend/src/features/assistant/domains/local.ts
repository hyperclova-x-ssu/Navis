/**
 * N20 local intelligence adapter: local changes, trade area and local trends.
 * Reads project the widgets' own stored values. The only writes are the two reversible local bookkeeping commands,
 * and each runs only when the owner presses its card (D-324).
 */
import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import type { DataCommand } from '../../../data/commands/types';
import { addDays, dateOf, inRange, NOW, TODAY, WEEK_END, WEEK_START, weekdayOf } from '../../../data/db/time';
import type { DataSnapshot, LocalChange, LocalChangeKind } from '../../../data/db/types';
import type { RealLocal } from '../../../data/reality/13/dto';
import { getLocalTrendRanking, trendSource, type TrendRanking, type TrendRankRow } from '../../../data/reality/13/trend-ranking';
import { readModel, dataBundles } from '../../../data/widget-data';
import { baseBundles, createTranslator, type MessageBundle, type Translator } from '../../../i18n';
import { mktLocalBundle } from '../../widgets/mkt-local/messages';
import { seoulStamp } from '../../widgets/mkt-local/local-changes.http';
import {
  validateAgentDraft, validateAgentNavigationArgs, type AgentFact, type AgentMissingStatus, type AgentRecordMatch, type AgentWireArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import { normalizeNavisInput, normalizeNavisName, parseNavisPeriod, parseNavisTime } from '../navis-input';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainRoute, RecordAdapter, RecordSearch } from './registry';

const CHANGES = 'local-changes', AREA = 'trade-area', TRENDS = 'local-trends';
const featureIds = [CHANGES, AREA, TRENDS] as const satisfies readonly FeatureId[];
const defaultCondition = { kind: 'default' } as const;
const businessDate = (snapshot: DataSnapshot) => snapshot.pos?.businessDate ?? TODAY;
const local = (locale: Locale, ko: string, en: string, hans: string, hant: string) => ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];
const slotLocale = (value: unknown): Locale => value === 'en' || value === 'zh-Hans' || value === 'zh-Hant' ? value : 'ko';

const translators = new Map<Locale, Translator>();
function translator(locale: Locale): Translator {
  let t = translators.get(locale);
  if (!t) {
    t = createTranslator(locale, ...([mktLocalBundle, ...baseBundles, ...dataBundles] as unknown as MessageBundle<string>[]));
    translators.set(locale, t);
  }
  return t;
}

function labels(locale: Locale) {
  const t = translator(locale);
  const tr = (ko: string, en: string, hans: string, hant: string) => local(locale, ko, en, hans, hant);
  return { t, tr,
    ackTitle: tr('소식 확인', 'Mark as seen', '确认动态', '確認動態'),
    reopenTitle: tr('새 소식으로 되돌리기', 'Move back to new', '移回新动态', '移回新動態'),
    change: tr('소식', 'Change', '动态', '動態'),
    status: tr('확인 상태', 'Status', '确认状态', '確認狀態'),
    isNew: tr('새 소식', 'New', '新动态', '新動態'),
    isChecked: tr('확인 완료', 'Checked', '已确认', '已確認'),
    alreadyChecked: tr('이미 확인한 소식이에요', 'Already checked.', '已经确认过了。', '已經確認過了。'),
    alreadyNew: tr('이미 새 소식으로 열려 있어요', 'Already marked as new.', '已经是新动态。', '已經是新動態。'),
    nothingOpen: tr('확인할 새 변화가 없어요', 'There are no new changes to check.', '没有待确认的动态。', '沒有待確認的動態。'),
    nothingFolded: tr('접어 둔 변화가 없어요', 'There are no folded changes.', '没有已收起的动态。', '沒有已收合的動態。'),
    chooseChange: tr('어느 변화인가요?', 'Which change?', '是哪条动态？', '是哪則動態？'),
    // D-327 Q1: 점심 is fixed at 12~14시 and the answer says so.
    lunchBasis: (from: string, to: string) => tr(`점심은 ${from}~${to} 기준이에요`, `Lunch is counted as ${from}–${to}.`, `午餐按 ${from}~${to} 计算。`, `午餐按 ${from}~${to} 計算。`),
    // D-327 Q3: no open opening carries the shop type the owner said in its title.
    noTypeInTitle: (type: string) => tr(`제목에 ‘${type}’ 글자가 든 개업 소식은 없어요. 어느 소식인가요?`, `No opening change has “${type}” in its title. Which change?`,
      `没有标题含“${type}”的开业动态。是哪条动态？`, `沒有標題含「${type}」的開幕動態。是哪則動態？`),
    chooseHours: tr('몇 시부터 몇 시까지 볼까요?', 'From which hour to which hour?', '请告诉我从几点到几点。', '請告訴我從幾點到幾點。'),
    noWeekday: tr('요일별 유동인구 자료는 없어요. 시간대별 일평균만 볼 수 있어요', 'There is no day-of-week foot traffic data. Only the hourly daily average is available.',
      '没有按星期统计的人流数据，只有分时段日均。', '沒有按星期統計的人流資料，只有分時段日均。'),
    noCompetitor: tr('경쟁 가게의 매출이나 가격 자료는 없어요', 'There is no sales or price data for competing shops.', '没有竞争店铺的销售额或价格数据。', '沒有競爭店鋪的銷售額或價格資料。'),
    noCompare: tr('유동인구와 방문 손님을 나눠 비교한 자료는 없어요', 'There is no comparison between foot traffic and your visitors.',
      '没有人流量与到店客人的对比数据。', '沒有人流量與到店客人的對比資料。'),
    noAddress: tr('정확한 주소 자료는 없어요', 'There is no exact address on record.', '没有确切地址的资料。', '沒有確切地址的資料。'),
    noLive: tr('실시간 유동인구는 볼 수 없어요. 시간대별 일평균 추정만 있어요', 'Live foot traffic is not available. Only the estimated hourly daily average is.',
      '看不到实时人流，只有分时段日均估算。', '看不到即時人流，只有分時段日均估算。'),
    noRows: tr('이번 주 동네 변화가 없어요', 'There are no neighborhood changes this week.', '本周没有周边动态。', '本週沒有周邊動態。'),
    openCount: tr('새로 확인할 변화', 'Changes to check', '待确认的动态', '待確認的動態'),
    foldedCount: tr('접어 둔 변화', 'Folded changes', '已收起的动态', '已收合的動態'),
    radius: tr('알림 범위', 'Alert range', '提醒范围', '提醒範圍'),
    source: tr('출처', 'Source', '来源', '來源'),
    updated: tr('갱신', 'Updated', '更新', '更新'),
    kind: tr('종류', 'Type', '类型', '類型'),
    when: tr('시기', 'When', '时间', '時間'),
    distance: tr('거리', 'Distance', '距离', '距離'),
    category: tr('업종', 'Category', '行业', '行業'),
    different: tr('같은 업종 아님', 'Not the same category', '不是同行业', '不是同行業'),
    forecast: tr('손님예측에 반영한 변화', 'Changes in the customer forecast', '已计入客流预测的动态', '已計入客流預測的動態'),
    period: tr('집계 기간', 'Period', '统计期间', '統計期間'),
    estimate: tr('자료 성격', 'Data type', '数据性质', '資料性質'),
    total: tr('하루 합계(시간대별 일평균의 합)', 'Daily total (sum of the hourly averages)', '全天合计（分时段日均之和）', '全天合計（分時段日均之和）'),
    am: tr('오전 합계(12시 전)', 'Morning total (before 12:00)', '上午合计（12点前）', '上午合計（12點前）'),
    pm: tr('오후 합계(12시 이후)', 'Afternoon total (from 12:00)', '下午合计（12点起）', '下午合計（12點起）'),
  };
}

const fact = (key: string, label: string, value: string | number, display = String(value), unit = 'text', date?: string): AgentFact => ({
  key, label: label.slice(0, 180), value: typeof value === 'string' ? value.slice(0, 1000) : value, display: display.slice(0, 1000), unit, ...(date ? { date } : {}),
});

/* ---------- local changes ---------- */
interface ChangeRow {
  readonly changeId: string; readonly kind: LocalChangeKind; readonly titleKey: string; readonly whenKey: string;
  readonly startDate: string; readonly endDate: string | null; readonly distanceM: number; readonly sameCategory: boolean;
  readonly sourceKey: string; readonly updatedAt: string; readonly folded: boolean; readonly forecast: boolean;
}
/** The widget's own rule: a change belongs to a period when it starts or was updated inside it. */
function changeRows(snapshot: DataSnapshot, start = WEEK_START, end = WEEK_END): readonly ChangeRow[] {
  const { localChange, demandDay, realLocal } = snapshot.tables;
  const scoped = realLocal ? localChange : localChange.filter((c: LocalChange) => inRange(c.startDate, start, end) || inRange(dateOf(c.updatedAt), start, end))
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.changeId.localeCompare(b.changeId));
  return scoped
    .map(c => ({ changeId: c.changeId, kind: c.kind, titleKey: c.titleKey, whenKey: c.whenKey, startDate: c.startDate, endDate: c.endDate,
      distanceM: c.distanceM, sameCategory: c.sameCategory, sourceKey: c.sourceKey, updatedAt: c.updatedAt, folded: c.ackedAt !== null,
      forecast: (c.kind === 'event' || c.kind === 'construction') && demandDay.some(d => d.eventKey === c.titleKey) }));
}
const titleOf = (row: ChangeRow, t: Translator) => t.t(row.titleKey);
function whenOf(row: ChangeRow, t: Translator) {
  const range = row.endDate && row.endDate !== row.startDate ? t.format.dateRange(row.startDate, row.endDate) : t.format.date(row.startDate, 'short');
  const label = t.t(row.whenKey);
  return /^\d{4}-\d{2}-\d{2}/.test(label) ? range : `${label} · ${range}`;
}
const distanceText = (row: ChangeRow, t: Translator) => t.t('widget.local-changes.distance', { m: t.format.number(row.distanceM) });
const MAX_ROWS = 8;
/** The widgets' own number and unit wording: 3개 in Korean, “3 changes” in English. */
const counted = (t: Translator, widget: 'local-changes' | 'local-trends', n: number) =>
  `${t.format.number(n)}${t.locale === 'en' ? ' ' : ''}${t.t(`widget.${widget}.unit`, { n })}`;
const changeKey = (index: number, field: string) => `localChanges.change.${index}.${field}`;

function tradeHourFacts({ sales, population, period }: RealLocal['trade'], hour: number, t: Translator): readonly AgentFact[] {
  const band = population.items.find(row => row.startHour <= hour && hour < row.endHour);
  const sale = sales.items.find(row => row.hour === hour);
  const hours = t.format.hourRange(hour, hour + 1);
  const movement = t.t('data.real.local.movement');
  const hourlySales = t.t('data.real.local.hourlySales');
  const noData = t.t('data.real.local.noData');
  const seoul = t.t('data.real.local.seoul');
  return [
    band ? { ...fact(`tradeArea.band.${hour}`, movement, band.estimate,
      `${hours} · ${t.format.number(band.estimate)} · ${t.t('data.real.local.seoulDate', { date: t.format.date(band.referenceDate, 'short') })} · ${band.quarter}`, 'count', band.referenceDate), source: seoul }
      : fact(`tradeArea.band.${hour}`, movement, 'unavailable', `${hours} · ${noData}`),
    { ...fact(`tradeArea.sales.${hour}`, hourlySales, sale?.quantity ?? 'unavailable',
      `${hours} · ${sale ? t.format.number(sale.quantity) : noData} · POS`, sale ? 'count' : 'text'),
      source: 'POS', start: period.from, end: period.to },
  ];
}

function lunchFact({ population }: RealLocal['trade'], t: Translator): AgentFact {
  const label = t.t('data.real.local.movement');
  const key = 'tradeArea.lunch.average';
  const noon = population.items.find(row => row.startHour <= 12 && row.endHour > 12);
  const one = population.items.find(row => row.startHour <= 13 && row.endHour > 13);
  if (!noon || !one || noon.region !== one.region || noon.quarter !== one.quarter
    || noon.weekday !== one.weekday || noon.referenceDate !== one.referenceDate) {
    return fact(key, label, 'unavailable', `12시~14시 · ${t.t('data.real.local.noData')}`);
  }
  const average = (noon.estimate + one.estimate) / 2;
  return { ...fact(key, label, average, `12시~14시 평균 ${t.format.number(average)} · ${t.t('data.real.local.seoulDate', { date: t.format.date(noon.referenceDate, 'short') })}`,
    'count', noon.referenceDate), source: t.t('data.real.local.seoul') };
}

function sourcedFacts(data: RealLocal, feature: typeof CHANGES | typeof AREA, t: Translator): readonly AgentFact[] {
  if (feature === CHANGES) {
    const { coverage, changes, period, unreadCount } = data;
    return [
      { ...fact('localChanges.week.count', t.t('widget.local-changes.thisWeek'), changes.length, counted(t, CHANGES, changes.length), 'count'), start: period.from, end: period.to },
      fact('localChanges.open.count', t.t('widget.local-changes.openList'), unreadCount, counted(t, CHANGES, unreadCount), 'count'),
      fact('localChanges.folded.count', t.t('widget.local-changes.folded', { n: changes.filter(row => row.acknowledgedAt).length }), changes.filter(row => row.acknowledgedAt).length),
      fact('localChanges.coverage', t.t('widget.local-changes.title'), coverage
        ? t.t('data.real.local.coverage', { region: coverage.region, date: t.format.date(coverage.referenceDate, 'short') }) : t.t('data.real.local.noCoverage')),
      ...changes.slice(0, MAX_ROWS).flatMap((row, index) => [
        fact(changeKey(index, 'title'), t.t(`data.real.local.${row.kind}`), row.title, `${row.title} · ${row.region}`),
        fact(changeKey(index, 'when'), t.t(`data.real.local.${row.dateKind}`), row.referenceDate, t.format.date(row.referenceDate, 'short'), 'date', row.referenceDate),
        { ...fact(changeKey(index, 'source'), t.t('widget.local-changes.source', { source: row.authority }), row.authority,
          row.authority, 'text', row.referenceDate), source: row.authority },
      ]),
    ];
  }
  const { period } = data.trade;
  const range = t.format.dateRange(period.from, period.to);
  return [
    fact('tradeArea.period', t.t('data.real.local.hourlySales'), range, `POS · ${range}`),
    lunchFact(data.trade, t),
    ...Array.from({ length: 24 }, (_, hour) => tradeHourFacts(data.trade, hour, t)).flat(),
  ];
}

function changeFacts(snapshot: DataSnapshot, condition: QueryCondition, locale: Locale): { readonly facts: readonly AgentFact[] } | { readonly status: AgentMissingStatus } {
  const day = businessDate(snapshot);
  let start = WEEK_START, end = WEEK_END;
  if (condition.kind === 'dateRange') {
    if (condition.start > condition.end || condition.end > addDays(condition.start, 366)) return { status: 'unsupported_period' };
    ({ start, end } = condition);
  } else if (condition.kind !== 'default') return { status: 'unsupported_period' };
  const l = labels(locale), { t } = l;
  const rows = changeRows(snapshot, start, end);
  const model = readModel(snapshot, CHANGES);
  const open = rows.filter(row => !row.folded).length, folded = rows.length - open;
  const sources = [...new Set(rows.map(row => t.t(row.sourceKey)))].join(' · ');
  const latest = rows.map(row => row.updatedAt).sort().at(-1);
  return { facts: [
    condition.kind === 'dateRange'
      ? { ...fact('localChanges.range.count', t.t('widget.local-changes.thisWeek'), rows.length, counted(t, 'local-changes', rows.length), 'count'), start, end }
      : { ...fact('localChanges.week.count', t.t('widget.local-changes.thisWeek'), rows.length, counted(t, 'local-changes', rows.length), 'count'), start, end },
    fact('localChanges.open.count', l.openCount, open, counted(t, 'local-changes', open), 'count', day),
    fact('localChanges.folded.count', l.foldedCount, folded, counted(t, 'local-changes', folded), 'count', day),
    fact('localChanges.forecast.count', l.forecast, rows.filter(row => row.forecast).length, counted(t, 'local-changes', rows.filter(row => row.forecast).length), 'count', day),
    fact('localChanges.radius', l.radius, model.radiusM, t.t('data.region.storeArea'), 'm'),
    ...(sources ? [fact('localChanges.source', l.source, sources)] : []),
    ...(latest ? [fact('localChanges.updated', l.updated, latest, t.format.dateTime(latest, { today: day }), 'dateTime', dateOf(latest))] : []),
    ...rows.slice(0, MAX_ROWS).flatMap((row, index) => {
      const title = titleOf(row, t), key = (field: string) => changeKey(index, field);
      return [
        fact(key('title'), l.kind, title, `${title} · ${t.t(`data.localChangeKind.${row.kind}`)}`, 'text', row.startDate),
        fact(key('kind'), title, row.kind, t.t(`data.localChangeKind.${row.kind}`)),
        fact(key('when'), title, row.startDate, whenOf(row, t), 'date', row.startDate),
        fact(key('distance'), title, row.distanceM, distanceText(row, t), 'm'),
        fact(key('category'), title, row.sameCategory ? 'same' : 'other', row.sameCategory ? t.t('widget.local-changes.sameCategory') : l.different),
        fact(key('status'), title, row.folded ? 'folded' : 'open', row.folded ? l.isChecked : l.isNew),
        ...(row.forecast ? [fact(key('forecast'), title, 'forecast', t.t('widget.local-changes.reflected'))] : []),
      ];
    }),
  ] };
}

/* ---------- trade area ---------- */
const hourTick = (t: Translator, hour: number) => t.t('widget.trade-area.hourTick', { hour });
function areaFacts(snapshot: DataSnapshot, condition: QueryCondition, locale: Locale): { readonly facts: readonly AgentFact[] } | { readonly status: AgentMissingStatus } {
  if (condition.kind !== 'default') return { status: 'unsupported_period' };
  const l = labels(locale), { t } = l, day = businessDate(snapshot);
  const model = readModel(snapshot, AREA);
  if (!model.peak) return { status: 'unavailable' };
  const people = (value: number) => t.format.count(value, 'person');
  const hourFact = (key: string, hour: number, value: number) =>
    fact(key, t.t('widget.trade-area.peakFootfall', { hour }), value, people(value), 'person');
  const ranked = [...model.hours].sort((a, b) => b.people - a.people || a.hour - b.hour);
  const lowest = [...model.hours].sort((a, b) => a.people - b.people || a.hour - b.hour)[0];
  const sum = (hours: readonly { readonly people: number }[]) => hours.reduce((total, item) => total + item.people, 0);
  const morning = model.hours.filter(item => item.hour < 12), afternoon = model.hours.filter(item => item.hour >= 12);
  const updated = model.updatedAt;
  return { facts: [
    hourFact('tradeArea.peak.people', model.peak.hour, model.peak.people),
    fact('tradeArea.peak.hour', t.t('widget.trade-area.peakNote'), model.peak.hour, hourTick(t, model.peak.hour), 'hour'),
    ...ranked.slice(0, 5).map((item, index) => hourFact(`tradeArea.top.${index + 1}`, item.hour, item.people)),
    ...(lowest ? [hourFact('tradeArea.lowest', lowest.hour, lowest.people)] : []),
    ...model.hours.map(item => hourFact(`tradeArea.hour.${item.hour}`, item.hour, item.people)),
    fact('tradeArea.total', l.total, sum(model.hours), people(sum(model.hours)), 'person'),
    fact('tradeArea.am.total', l.am, sum(morning), people(sum(morning)), 'person'),
    fact('tradeArea.pm.total', l.pm, sum(afternoon), people(sum(afternoon)), 'person'),
    fact('tradeArea.period', l.period, model.periodKey, `${t.t(model.periodKey)} · ${t.t('widget.trade-area.hourlyAverage')}`),
    fact('tradeArea.source', l.source, model.sourceKey, t.t(model.sourceKey)),
    fact('tradeArea.updated', l.updated, updated, t.format.dateTime(updated, { today: day }), 'dateTime', dateOf(updated)),
    fact('tradeArea.estimate', l.estimate, 'estimate', t.t('widget.trade-area.estimate')),
  ] };
}

/* ---------- local trends ---------- */
const trendRowKey = (index: number, field: string) => `localTrends.keyword.${index}.${field}`;
const trendPercent = (value: number, t: Translator) => {
  const change = Math.abs(value) < 0.05 ? 0 : value;
  const percent = new Intl.NumberFormat(t.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(change);
  return `${change > 0 ? '+' : ''}${percent}%`;
};
const trendRowLabel = (row: TrendRankRow, t: Translator) =>
  `${row.rank}위 ${row.keyword} · ${t.t('data.real.local.trends.fourWeeks')} ${trendPercent(row.changePercent, t)}`;
const trendMenuLabel = (row: TrendRankRow, t: Translator) => row.menuName
  ? t.t('data.real.local.trends.menuMatch', { menu: row.menuName })
  : row.isMenu === false ? t.t('data.real.local.trends.notMenu') : row.isMenu === true ? '우리 메뉴에 있음' : undefined;
const trendSourceLine = (ranking: TrendRanking) =>
  `${trendSource} · ${ranking.fetchedAt ? dateOf(seoulStamp(ranking.fetchedAt)) : ranking.period.to}`;

function trendFacts(snapshot: DataSnapshot, condition: QueryCondition, locale: Locale): { readonly facts: readonly AgentFact[] } | { readonly status: AgentMissingStatus } {
  const ranking = getLocalTrendRanking(snapshot);
  if (condition.kind !== 'default' && (condition.kind !== 'dateRange'
    || condition.start !== ranking?.period.from || condition.end !== ranking?.period.to)) return { status: 'unsupported_period' };
  if (!ranking || ranking.status === 'disabled' || ranking.status === 'unavailable') return { status: 'unavailable' };
  if (ranking.status === 'empty' || !ranking.items.length) return { status: 'missing' };
  const l = labels(locale), { t } = l;
  const { from: start, to: end } = ranking.period;
  const from = addDays(end, -6);
  const scope = { start, end, source: trendSource };
  const [first] = ranking.items;
  const missingMenu = ranking.items.filter(row => row.isMenu === false).map(row => trendRowLabel(row, t));
  const menuExamples = missingMenu.slice(0, 4).join(' · ');
  const menuCount = counted(t, TRENDS, missingMenu.length);
  const current = t.format.dateRange(from, end), previous = t.format.dateRange(start, addDays(from, -1));
  const fetchedAt = ranking.fetchedAt && Date.parse(ranking.fetchedAt);
  return { facts: [
    { ...fact('localTrends.source', l.source, trendSource, trendSourceLine(ranking)), ...scope },
    { ...fact('localTrends.period', l.period, `${start}/${end}`, `최근 7일 ${current} · 이전 4주 ${previous} 대비`, 'dateRange'), ...scope },
    fact('localTrends.definition', t.t('data.real.local.searchInterest'), 'definition',
      '4주 대비는 최근 7일의 일평균 검색 관심도를 앞선 28일 일평균과 비교한 변화율이에요. 검색이 늘거나 줄어든 이유는 이 자료에서 알 수 없어요.'),
    fact('localTrends.interest.mentions', t.t('data.real.local.searchInterest'), 'unavailable', '검색이나 언급의 실제 횟수는 알 수 없어요'),
    ...(ranking.fetchedAt && Number.isFinite(fetchedAt) ? [fact('localTrends.updated', l.updated, ranking.fetchedAt,
      new Intl.DateTimeFormat(t.locale, { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ranking.fetchedAt)), 'dateTime')] : []),
    { ...fact('localTrends.top', t.t('data.real.local.trends.ranking'), first.changePercent, trendRowLabel(first, t), 'percent'), ...scope },
    fact('localTrends.notable.count', t.t('data.real.local.trends.ranking'), ranking.items.length, counted(t, TRENDS, ranking.items.length), 'count'),
    ...(ranking.items.some(row => row.isMenu !== null) ? [fact('localTrends.menu.missing', t.t('data.real.local.trends.notMenu'), missingMenu.length,
      menuExamples ? `${menuCount}${missingMenu.length > 4 ? ' 중 상위 4개' : ''} · ${menuExamples}` : '우리 메뉴에 없음으로 표시된 검색어가 없어요', 'count')] : []),
    ...ranking.items.flatMap((row, index) => {
      const menu = trendMenuLabel(row, t);
      return [
        { ...fact(trendRowKey(index, 'change'), row.keyword, row.changePercent, trendRowLabel(row, t), 'percent'), ...scope },
        ...(menu ? [fact(trendRowKey(index, 'menu'), row.keyword, row.menuName ?? 'absent', `${row.keyword} · ${menu}`)] : []),
        ...(row.sameWeekChangePercent == null ? [] : [{ ...fact(trendRowKey(index, 'year'), row.keyword, row.sameWeekChangePercent,
          `${row.keyword} · ${t.t('data.real.local.trends.lastYear')} ${trendPercent(row.sameWeekChangePercent, t)}`, 'percent'), ...scope }]),
      ];
    }),
  ] };
}

function projectWidget(snapshot: DataSnapshot, feature: FeatureId, condition: QueryCondition, locale: Locale) {
  if (feature === TRENDS) return trendFacts(snapshot, condition, locale);
  const real = snapshot.tables.realLocal;
  if (real && (feature === CHANGES || feature === AREA)) {
    if (condition.kind !== 'default' && (feature !== CHANGES || condition.kind !== 'dateRange'
      || condition.start !== real.period.from || condition.end !== real.period.to)) return { status: 'unsupported_period' as const };
    return { facts: sourcedFacts(real, feature, translator(locale)) };
  }
  if (feature === CHANGES) return changeFacts(snapshot, condition, locale);
  if (feature === AREA) return areaFacts(snapshot, condition, locale);
  return undefined;
}

/* ---------- record search: a change row, resolved only in the browser ---------- */
type ChangeState = 'open' | 'folded' | 'any';
interface ChangeQuery { readonly state: ChangeState; readonly kinds: readonly LocalChangeKind[]; readonly ids: readonly string[]; readonly words: readonly string[] }
const encodeQuery = ({ state, kinds, ids, words }: ChangeQuery) => [state, kinds.join(','), ids.join(','), words.join(',')].join('\n');
function decodeQuery(query: string): ChangeQuery {
  const [state = 'any', kinds = '', ids = '', words = ''] = query.split('\n');
  const split = (value: string) => value ? value.split(',') : [];
  return { state: state === 'open' || state === 'folded' ? state : 'any', kinds: split(kinds) as LocalChangeKind[], ids: split(ids), words: split(words) };
}
function searchRows(snapshot: DataSnapshot, query: string): readonly ChangeRow[] {
  const q = decodeQuery(query);
  return changeRows(snapshot).filter(row => (q.state === 'any' || (q.state === 'folded') === row.folded)
    && (!q.ids.length || q.ids.includes(row.changeId))
    && (!q.kinds.length || q.kinds.includes(row.kind))).slice(0, 5);
}
const handleOf = (index: number) => `n20-localChange-${index + 1}`;
const recordReader: RecordAdapter = {
  kind: 'localChange',
  search({ snapshot, query, privateLookup, locale }: RecordSearch): readonly AgentRecordMatch[] {
    const { t } = labels(locale);
    return searchRows(snapshot, query).map((row, index) => ({
      handle: handleOf(index), match: 'exact' as const, fields: { date: row.startDate, folded: row.folded },
      ...(!privateLookup ? { label: titleOf(row, t).slice(0, 180) } : {}),
    }));
  },
  resolve: ({ snapshot, query }, handle) => searchRows(snapshot, query).find((_, index) => handleOf(index) === handle)?.changeId,
  describe(match, locale, input) {
    const row = input && searchRows(input.snapshot, input.query).find((_, index) => handleOf(index) === match.handle);
    if (!row) return match.label;
    const l = labels(locale);
    return `${titleOf(row, l.t)} · ${row.folded ? l.isChecked : l.isNew}`;
  },
};

/* ---------- the two reversible commands ---------- */
type ChangeCommandType = 'localChanges.acknowledge' | 'localChanges.unacknowledge';
interface ChangeDraft { readonly changeId: string; readonly locale: Locale }
function commandAdapter(type: ChangeCommandType): CommandAdapter<Extract<DataCommand, { type: ChangeCommandType }>, ChangeDraft> {
  return {
    command: type, featureId: CHANGES, slots: {},
    resolve(wire, slots, snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return;
      const ref = (wire as AgentWireArgs).changeId;
      const handle = ref && typeof ref === 'object' && !Array.isArray(ref) && 'handle' in ref && typeof ref.handle === 'string' ? ref.handle : undefined;
      const target = handle === undefined ? undefined : targets.get(handle);
      if (!target || target.kind !== 'localChange' || !snapshot.tables.localChange.some(row => row.changeId === target.id)) return;
      return { changeId: target.id, locale: slotLocale(slots.navisLocale) };
    },
    preflight({ changeId, locale }, { snapshot }) {
      const row = snapshot.tables.localChange.find(item => item.changeId === changeId);
      if (!row) return { kind: 'conflict' };
      const folded = row.ackedAt !== null;
      if (folded === (type === 'localChanges.acknowledge')) return { kind: 'unchanged' };
      const l = labels(locale);
      const before = folded ? l.isChecked : l.isNew, after = folded ? l.isNew : l.isChecked;
      return { kind: 'ready', command: { type, changeId } as Extract<DataCommand, { type: ChangeCommandType }>,
        preview: { title: type === 'localChanges.acknowledge' ? l.ackTitle : l.reopenTitle, target: l.t.t(row.titleKey), fields: [{ label: l.change, before: l.t.t(row.titleKey), after: l.t.t(row.titleKey) }, { label: l.status, before, after }] } };
    },
    undoToken: result => result.undoToken,
  };
}

/* ---------- wording ---------- */
const kindWords: readonly (readonly [LocalChangeKind, RegExp])[] = [
  ['opening', /개업|개점|오픈|새\s*(?:카페|가게|매장|점포)|새로\s*(?:생긴|생기|문\s*연)|경쟁\s*(?:업체|점|가게)/u],
  ['closing', /폐업|문\s*닫/u],
  ['event', /행사|축제|공연/u],
  ['construction', /공사|정비|보수/u],
];
const ackVerb = /확인\s*(?:했|함|처리|끝(?!낸))|접어\s*(?:줘|둬|주세요)|다\s*봤|봤어/u;
const unnamedAcknowledgment = /^다\s*봤(?:어|어요)\s*확인[.!]?$/u;
const reopenVerb = /새\s*소식으로|확인\s*안\s*한\s*걸로|확인\s*필요로|다시\s*(?:살려|열어)|살려\s*줘|되돌려|돌려\s*줘/u;
const openVerb = /열어|보여|펼쳐|보기|상세|자세히|이동|넘어가|눌러|가줘/u;
const changeScope = /동네\s*(?:변화|소식|알림)|새로\s*확인할\s*(?:변화|소식)|몇\s*미터\s*안\s*소식|확인\s*안\s*한\s*걸로|확인\s*필요로|주변\s*(?:변화|소식)|접어\s*둔|접은\s*(?:변화|소식|거)|확인\s*(?:안|끝낸)\s*(?:한|낸)?\s*(?:동네|변화|소식)|(?:행사|공사)\s*(?:장소|소식|알림)|경쟁\s*(?:업체|점|가게)|같은\s*업종/u;
const areaScope = /유동\s*인구|상권|지나가|지나다|다니는|다녀|길에는|붐비|피크\s*시간|한가한\s*시간|조용한\s*시간|사람\s*(?:수|이\s*많|많|더\s*많|제일|없는)/u;
const trendFeature = /검색어|검색\s*관심도|키워드|트렌드|유행/u;
const trendQuestion = /얼마나|몇\s*(?:퍼센트|%)|증가율|추세|오른|늘|줄었|줄어|내림세|감소|하락|어때|비교/u;
const trendScope = (value: string) => trendFeature.test(value) || /언급|관심\s*지표|증가율|비교\s*기간/u.test(value);
const whereIs = /어디\s*(?:있|서\s*봐|에\s*있|메뉴)|위치\s*알려|어느\s*메뉴/u;
/** The marketing widget a location question names. */
const whereFeature = (value: string) => /상권|유동\s*인구/u.test(value) ? AREA : trendFeature.test(value) ? TRENDS : /동네\s*(?:변화|소식|알림)|경쟁점/u.test(value) ? CHANGES : undefined;
const competitor = /(?:경쟁|옆\s*가게|다른\s*(?:카페|가게)).*(?:매출|팔아|얼마|가격|받아)/u;

function kindsOf(value: string): LocalChangeKind[] { return kindWords.filter(([, pattern]) => pattern.test(value)).map(([kind]) => kind); }
const words = (title: string) => title.split(/[\s·]+/u).filter(word => normalizeNavisName(word).length >= 2);
function targetRows(value: string, rows: readonly ChangeRow[], t: Translator) {
  const key = normalizeNavisName(value);
  const exact = rows.filter(row => key.includes(normalizeNavisName(titleOf(row, t))));
  if (exact.length) return exact;
  const kinds = kindsOf(value);
  const scoped = kinds.length ? rows.filter(row => kinds.includes(row.kind)) : rows;
  const titled = scoped.filter(row => words(titleOf(row, t)).some(word => key.includes(normalizeNavisName(word))));
  return titled.length || !kinds.length ? titled : scoped;
}
/** A shop type the owner can name (“새 카페”). Generic words (가게, 매장, 점포) name no type. */
const shopType = /카페|커피(?:숍|샵|전문점)?|빵집|베이커리|식당|음식점|편의점|서점|꽃집|치킨집|술집|미용실|헬스장|약국/u;
/** D-327 Q3: the shop type said when none of the matched opening titles holds it, so the match cannot be assumed. */
function unnamedShopType(value: string, picked: readonly ChangeRow[], t: Translator): string | undefined {
  const type = shopType.exec(value)?.[0];
  const openings = picked.filter(row => row.kind === 'opening');
  const key = type ? normalizeNavisName(type) : '';
  return type && openings.length > 0 && openings.every(row => !normalizeNavisName(titleOf(row, t)).includes(key)) ? type : undefined;
}
const numberWords = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5 } as const;
function countOf(value: string): number {
  const digits = /(\d)\s*(?:개|군데|곳|위)|top\s*(\d)/iu.exec(value);
  if (digits) return Math.min(5, Number(digits[1] ?? digits[2]));
  const native = /(한|하나|두|둘|세|셋|네|넷|다섯)\s*(?:개|군데|곳)/u.exec(value);
  return native ? numberWords[native[1] as keyof typeof numberWords] : 3;
}
/** Local hour in the 0-23 data window: the sample covers 08-21, so a bare small number reads as the afternoon. */
function hourOf(value: string): number | undefined {
  const time = parseNavisTime(value);
  if (!time) return undefined;
  let hour = Number(time.slice(0, 2));
  if (/저녁|밤|퇴근|오후/u.test(value) && hour < 12) hour += 12;
  else if (!/오전|아침|새벽/u.test(value) && hour < 8) hour += 12;
  return hour;
}
function hourRange(value: string): { start: number; end: number } | undefined {
  const match = /(?:(오전|오후)\s*)?(\d{1,2})\s*시\s*(?:부터|~|～|에서)\s*(?:(오전|오후)\s*)?(\d{1,2})\s*시/u.exec(value);
  if (!match) return undefined;
  let start = Number(match[2]), end = Number(match[4]);
  if (match[1] === '오후' && start < 12) start += 12;
  if (match[3] === '오후' && end < 12) end += 12;
  if (end <= start && end < 12) end += 12;
  return end > start && end <= 24 ? { start, end } : undefined;
}
const read = (featureId: FeatureId, factKeys: readonly string[], condition: QueryCondition = defaultCondition): DomainRoute =>
  ({ intent: { kind: 'read', featureId, condition }, factKeys });
const answer = (text: string): DomainRoute => ({ kind: 'answer', answer: text });

const ordinals = { 첫: 1, 둘: 2, 셋: 3, 넷: 4, 다섯: 5, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 } as const;
/** “10월 셋째 주”: the Nth Monday-start week that begins inside the month. */
function weekOfMonth(value: string, day: string): QueryCondition | undefined {
  const match = /(\d{1,2})\s*월\s*(첫|둘|셋|넷|다섯|[1-5])\s*(?:째|번째)?\s*주/u.exec(value);
  if (!match) return undefined;
  const month = Number(match[1]);
  if (month < 1 || month > 12) return undefined;
  const first = `${day.slice(0, 4)}-${String(month).padStart(2, '0')}-01`;
  const monday = addDays(first, (8 - weekdayOf(first)) % 7);
  const start = addDays(monday, (ordinals[match[2] as keyof typeof ordinals] - 1) * 7);
  return start.slice(0, 7) === first.slice(0, 7) ? { kind: 'dateRange', start, end: addDays(start, 6) } : undefined;
}
function pastCondition(value: string, day: string): QueryCondition | undefined {
  const nth = weekOfMonth(value, day);
  if (nth) return nth;
  if (/작년|지난해/u.test(value)) return { kind: 'dateRange', start: addDays(day, -365), end: addDays(day, -365) };
  const period = parseNavisPeriod(value, day);
  return period ? { kind: 'dateRange', ...period } : undefined;
}

function changeRoute(value: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const l = labels(locale), { t } = l, day = businessDate(snapshot);
  const rows = changeRows(snapshot);
  const matched = targetRows(value, rows, t);
  const lookup = (state: ChangeState, picked: readonly ChangeRow[]): DomainRoute => ({
    intent: { kind: 'command', command: state === 'open' ? 'localChanges.acknowledge' : 'localChanges.unacknowledge', args: {} },
    slots: { changeId: encodeQuery({ state, kinds: [], ids: picked.map(row => row.changeId), words: [] }), navisLocale: locale },
    lookups: [{ kind: 'localChange', querySlot: 'changeId', bind: ['changeId'] }],
  });
  const selectChange = (state: 'open' | 'folded', row: ChangeRow): DomainRoute => {
    if (state === 'open' && row.folded) return answer(l.alreadyChecked);
    if (state === 'folded' && !row.folded) return answer(l.alreadyNew);
    return lookup(state, [row]);
  };
  const askChange = (state: 'open' | 'folded', choices: readonly ChangeRow[], question = l.chooseChange): DomainRoute => {
    return { kind: 'clarification', field: 'changeId', answer: question,
      choices: choices.map(row => ({ id: row.changeId, label: titleOf(row, t) })),
      resume: id => { const row = choices.find(item => item.changeId === id); return row ? selectChange(state, row) : undefined; } };
  };
  const acknowledging = ackVerb.test(value);
  if (acknowledging || reopenVerb.test(value)) {
    if (!rows.length) return answer(l.noRows);
    const state = acknowledging ? 'open' : 'folded';
    const pool = matched.length ? matched : rows;
    const type = unnamedShopType(value, pool, t);
    if (type) return askChange(state, pool.filter(row => row.kind === 'opening'), l.noTypeInTitle(type));
    if (matched.length === 1) return selectChange(state, matched[0]);
    if (matched.length > 1) return askChange(state, matched);
    const eligible = rows.filter(row => row.folded === !acknowledging);
    if (!eligible.length) return answer(acknowledging ? l.nothingOpen : l.nothingFolded);
    return askChange(state, eligible);
  }
  const past = /지난주|저번\s*주|지난\s*주|\d{1,2}월/u.test(value) ? pastCondition(value, day) : undefined;
  const real = snapshot.tables.realLocal;
  if (real) {
    if (past) return read(CHANGES, ['localChanges.week.count'], past);
    if (/접어\s*둔|접은|확인\s*안|안\s*본|새로\s*확인/u.test(value)) return read(CHANGES, ['localChanges.open.count', 'localChanges.folded.count']);
    if (/몇\s*(?:개|건)|개수|떴어/u.test(value)) return read(CHANGES, ['localChanges.week.count', 'localChanges.open.count', 'localChanges.folded.count']);
    const keys = sourcedFacts(real, CHANGES, t).map(item => item.key);
    if (matched.length) {
      return read(CHANGES, ['localChanges.coverage', ...matched.flatMap(row => {
        const index = rows.indexOf(row);
        return index < MAX_ROWS ? ['title', 'when', 'source'].map(field => changeKey(index, field)) : [];
      })].slice(0, 12));
    }
    return read(CHANGES, keys.slice(0, 12));
  }
  if (past) {
    const ranged = changeRows(snapshot, past.kind === 'dateRange' ? past.start : WEEK_START, past.kind === 'dateRange' ? past.end : WEEK_END);
    const kinds = kindsOf(value);
    const keys = ranged.slice(0, MAX_ROWS).flatMap((row, index) => !kinds.length || kinds.includes(row.kind)
      ? [changeKey(index, 'title'), changeKey(index, 'when'), changeKey(index, 'distance')] : []);
    return read(CHANGES, ['localChanges.range.count', 'localChanges.open.count', 'localChanges.folded.count', ...keys], past);
  }
  const pick = matched.length ? matched : rows;
  const indexes = pick.map(row => rows.indexOf(row)).slice(0, MAX_ROWS);
  const perRow = (...fields: string[]) => indexes.flatMap(index => fields.map(field => changeKey(index, field)));
  if (/몇\s*미터\s*안|반경|출처|언제\s*갱신|갱신|자료\s*(?:언제|어디)/u.test(value)) return read(CHANGES, ['localChanges.radius', 'localChanges.source', 'localChanges.updated']);
  if (/이름이\s*뭐|정확한\s*(?:위치|주소)|어느\s*골목|주소/u.test(value)) {
    const lines = pick.slice(0, MAX_ROWS).map(row => `${titleOf(row, t)} · ${distanceText(row, t)}`);
    return answer(lines.length ? `${lines.join('\n')}\n${l.noAddress}` : l.noRows);
  }
  if (/손님.*(?:늘|줄|뺏|올)|매출.*(?:줄|늘)|장사\s*잘|영향/u.test(value)) return read(CHANGES, ['localChanges.forecast.count', ...perRow('title', 'forecast')]);
  if (/같은\s*업종|경쟁/u.test(value)) return read(CHANGES, perRow('title', 'category'));
  if (/가까|멀|몇\s*미터|거리/u.test(value)) return read(CHANGES, perRow('distance'));
  if (/접어\s*둔|접은|확인\s*안|안\s*본|새로\s*확인/u.test(value)) return read(CHANGES, ['localChanges.open.count', 'localChanges.folded.count']);
  if (/몇\s*(?:개|건)|개수|떴어/u.test(value)) return read(CHANGES, ['localChanges.week.count', 'localChanges.open.count', 'localChanges.folded.count']);
  return read(CHANGES, ['localChanges.week.count', ...perRow('title', 'when', 'distance')]);
}

function areaRoute(value: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const l = labels(locale), { t } = l;
  const real = snapshot.tables.realLocal;
  if (real) {
    const range = hourRange(value);
    if (range) return read(AREA, ['tradeArea.period', ...Array.from({ length: range.end - range.start }, (_, offset) => {
      const hour = range.start + offset;
      return [`tradeArea.band.${hour}`, `tradeArea.sales.${hour}`];
    }).flat()]);
    if (/점심/u.test(value)) return read(AREA, ['tradeArea.lunch.average', 'tradeArea.sales.12', 'tradeArea.sales.13']);
    const hour = hourOf(value);
    if (hour !== undefined) return read(AREA, ['tradeArea.period', `tradeArea.band.${hour}`, `tradeArea.sales.${hour}`]);
    const populated = real.trade.population.items.slice(0, 5).map(row => `tradeArea.band.${row.startHour}`);
    const sold = real.trade.sales.items.slice(0, 5).map(row => `tradeArea.sales.${row.hour}`);
    return populated.length || sold.length ? read(AREA, ['tradeArea.period', ...populated, ...sold]) : answer(t.t('data.real.local.noData'));
  }
  const model = readModel(snapshot, AREA);
  const total = (range: { start: number; end: number }): DomainRoute => {
    const parts = model.hours.filter(item => item.hour >= range.start && item.hour < range.end);
    if (!parts.length) return read(AREA, ['tradeArea.period']);
    const sum = parts.reduce((acc, item) => acc + item.people, 0);
    const heading = `${hourTick(t, range.start)}~${hourTick(t, range.end)} ${l.tr('유동인구 합계', 'foot traffic total', '人流合计', '人流合計')} ${t.format.count(sum, 'person')}`;
    return answer(`${heading}\n${parts.map(item => `${hourTick(t, item.hour)} ${t.format.count(item.people, 'person')}`).join(' + ')}`);
  };
  const range = hourRange(value);
  if (range) return total(range);
  // D-327 Q1: 점심 is 12~14시, fixed; the answer says so. Hours the owner names win above.
  if (/점심/u.test(value)) {
    const lunch = total({ start: 12, end: 14 });
    return 'kind' in lunch && lunch.kind === 'answer' ? answer(`${l.lunchBasis(hourTick(t, 12), hourTick(t, 14))}\n${lunch.answer}`) : lunch;
  }
  if (/(?:두|세|\d)\s*시간\s*동안/u.test(value)) {
    return { kind: 'clarification', field: 'hours', answer: l.chooseHours, resume(text) {
      const next = hourRange(text);
      return next ? areaRoute(`${next.start}시부터 ${next.end}시까지 유동인구`, snapshot, locale) : undefined;
    } };
  }
  if (/지금|실시간|현재|방금/u.test(value)) {
    const hour = Number(NOW.slice(11, 13)), current = model.hours.find(item => item.hour === hour);
    return answer(current ? `${l.noLive}\n${hourTick(t, hour)} ${t.format.count(current.people, 'person')} (${t.t('widget.trade-area.estimate')})` : l.noLive);
  }
  if (/요일별|주말|평일|토요일/u.test(value)) return answer(l.noWeekday);
  if (/유동인구\s*대비|전환율|비율|비교해줘|방문객|우리\s*(?:가게\s*)?손님|손님\s*적|비는\s*시간|한산한\s*시간|쿠폰\s*쏘/u.test(value) && /손님|방문객|가게|전환|우리/u.test(value)) return answer(l.noCompare);
  if (/제일\s*(?:적|한가|조용)|가장\s*(?:적|한가|조용)|한가한|조용한|없는\s*시간|제일\s*없/u.test(value)) return read(AREA, ['tradeArea.lowest']);
  if (/하루|시간대\s*다\s*더|다\s*합|전체\s*지나가|전체\s*유동/u.test(value) && /합|전체|몇\s*명|더하면|지나가/u.test(value)) return read(AREA, ['tradeArea.total']);
  if (/오전.*오후|오후.*오전|아침.*저녁|오후가\s*더|오전이/u.test(value)) return read(AREA, ['tradeArea.am.total', 'tradeArea.pm.total']);
  if (/기준|출처|어떻게\s*센|반경|언제\s*기준|자료/u.test(value)) return read(AREA, ['tradeArea.period', 'tradeArea.source', 'tradeArea.updated', 'tradeArea.estimate']);
  if (/(?:많은|붐비는|붐벼|피크|top|상위)/iu.test(value) && /\d|세|세\s*군데|top|순서|개만|군데/iu.test(value)) {
    return read(AREA, Array.from({ length: countOf(value) }, (_, index) => `tradeArea.top.${index + 1}`));
  }
  const hour = hourOf(value);
  if (hour !== undefined) return read(AREA, [`tradeArea.hour.${hour}`]);
  return read(AREA, ['tradeArea.peak.people', 'tradeArea.peak.hour']);
}

function namedTrendRows(value: string, items: readonly TrendRankRow[]) {
  const text = normalizeNavisName(value);
  return items.map((row, index) => ({ row, index })).filter(({ row }) => [row.keyword, row.menuName].some(label => {
    const name = label && normalizeNavisName(label);
    return Boolean(name && name.length > 1 && text.includes(name));
  }));
}

function namesTrend(value: string, snapshot: DataSnapshot) {
  const ranking = getLocalTrendRanking(snapshot);
  return ranking?.status === 'ready' && namedTrendRows(value, ranking.items).length > 0;
}

type TrendOverview = Extract<DomainRoute, { kind: 'answer' }>;

function trendOverview(
  ranking: TrendRanking,
  t: Translator,
  selected: readonly TrendRankRow[],
  forShop: boolean,
): TrendOverview {
  const rows = selected.map(row => `${trendRowLabel(row, t)} · ${trendMenuLabel(row, t) ?? '우리 메뉴 여부를 확인하지 못했어요'}`);
  const suggested = forShop && ranking.items.find(row => row.isMenu && row.menuName && row.changePercent >= 0.05
    && row.classification !== 'steady' && row.classification !== 'cooling');
  if (suggested) {
    rows.push(`홍보 영상에 우리 메뉴 ‘${suggested.menuName}’ 소개를 넣어 볼 수 있어요. 검색어 ‘${suggested.keyword}’는 4주 대비 ${trendPercent(suggested.changePercent, t)}예요.`);
  } else if (forShop) {
    rows.push('우리 메뉴와 연결된 상승 검색어가 없어요.');
  }
  return { kind: 'answer', answer: [...rows, trendSourceLine(ranking)].join('\n'),
    readScope: { featureId: TRENDS, condition: defaultCondition },
    ...(suggested && { destination: { featureId: 'promo-video', step: 'place-video' } }) };
}

/** A classified current ranking read uses the same overview as a direct W20 read. */
export function routeClassifiedTrendOverview(
  snapshot: DataSnapshot, locale: Locale, hints: readonly string[], text: string,
): TrendOverview | undefined {
  const ranking = getLocalTrendRanking(snapshot);
  if (ranking && namedTrendRows(hints.join(' '), ranking.items).length) return undefined;
  const routed = trendRoute(normalizeNavisInput(text), snapshot, locale, hints.includes('가게 활용'));
  return 'kind' in routed && routed.kind === 'answer' ? routed : undefined;
}

function trendRoute(value: string, snapshot: DataSnapshot, locale: Locale, forShop = false): DomainRoute {
  const { t } = labels(locale);
  const ranking = getLocalTrendRanking(snapshot);
  if (!ranking) return read(TRENDS, ['localTrends.source']);
  const method = /무슨\s*뜻|뭘\s*말|관심\s*지표|어디서\s*센|이\s*숫자|출처|기준|왜/u.test(value);
  if (ranking.status !== 'ready' || !ranking.items.length) {
    const key = ranking.status === 'disabled' ? 'data.real.local.trends.disabled'
      : ranking.status === 'unavailable' ? 'data.real.error' : 'data.real.local.noData';
    return answer(`${t.t(key)}. ${trendSource}`);
  }
  const scope = ['localTrends.period', 'localTrends.source'];
  const asksPeriod = /비교\s*기간|언제\s*(?:부터|대비)|기준이\s*언제|기준.*언제부터/u.test(value);
  const explicitMonth = /지난달|작년|지난해|\d{1,2}월/u.test(value);
  const priorWeek = /지난\s*주|저번\s*주/u.test(value) && !/대비|보다|비교/u.test(value);
  const past = !asksPeriod && (explicitMonth || priorWeek)
    ? pastCondition(value, businessDate(snapshot)) : undefined;
  if (past) return read(TRENDS, scope, past);
  if (/언급.*(?:몇|횟수|얼마)|몇.*언급|검색\s*횟수/u.test(value)) return read(TRENDS, ['localTrends.interest.mentions', 'localTrends.source']);
  if (asksPeriod) return read(TRENDS, scope);
  if (method) return read(TRENDS, [...scope, 'localTrends.definition', 'localTrends.updated']);
  const named = namedTrendRows(value, ranking.items);
  if (named.length) return read(TRENDS, [...scope, ...named.flatMap(({ index }) => ['change', 'menu', 'year'].map(field => trendRowKey(index, field)))]);
  const entries = ranking.items.map((row, index) => ({ row, index }));
  if (!forShop && value.includes('메뉴')) return read(TRENDS, [...scope, 'localTrends.menu.missing',
    ...entries.filter(({ row }) => row.isMenu !== null).slice(0, 4).map(({ index }) => trendRowKey(index, 'menu'))]);
  const selected = /줄었|줄어|내림세|감소|하락/u.test(value) ? entries.filter(({ row }) => row.changePercent < 0) : entries;
  if (!selected.length) return answer(`순위에 검색 관심도가 줄어든 검색어가 없어요. ${trendSource}`);
  const limit = /제일|가장|1위/u.test(value) ? 1 : countOf(value);
  return trendOverview(ranking, t, selected.slice(0, limit).map(({ row }) => row), forShop);
}

function route(raw: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const value = normalizeNavisInput(raw);
  const l = labels(locale);
  if (competitor.test(value)) return answer(l.noCompetitor);
  const asked = whereIs.test(value) ? whereFeature(value) : undefined;
  if (asked) return answer(`${l.t.t(`widget.${asked}.title`)} · ${l.t.t('app.layer.marketing')} > ${l.t.t('group.neighborhood')}`);
  const kinds = kindsOf(value);
  const changes = changeScope.test(value) || kinds.includes('opening') || kinds.length > 0 && (ackVerb.test(value) || reopenVerb.test(value) || /손님|매출|장사|거리|가까|멀|미터|같은\s*업종|이름|위치|주소|장소|소식|알림|지난주|저번\s*주/u.test(value))
    || (ackVerb.test(value) || reopenVerb.test(value)) && (/변화|소식|알림/u.test(value) || changeRows(snapshot).some(row => targetRows(value, [row], l.t).length > 0));
  if (changes) return changeRoute(value, snapshot, locale);
  if (areaScope.test(value)) return areaRoute(value, snapshot, locale);
  if (trendScope(value) || trendQuestion.test(value) && namesTrend(value, snapshot)) return trendRoute(value, snapshot, locale);
  return undefined;
}

/* ---------- opening a widget's detail ---------- */
const cafeReceiptQuery = /카페.*(?:올린\s*글|게시한\s*글|게시\s*영수증|게시\s*결과)/u;
function cafeReceiptRoute(raw: string, snapshot: DataSnapshot): DomainRoute | undefined {
  const value = normalizeNavisInput(raw);
  if (!cafeReceiptQuery.test(value) || /수정|고쳐|삭제|지워|다시\s*올/u.test(value)) return;
  const local = snapshot.tables.realLocal;
  if (!local) return;
  const t = translator('ko');
  if (/영수증|링크/u.test(value) && openVerb.test(value)) {
    return { kind: 'refusal', reason: 'widget_only', answer: '커뮤니티에서 올린 글과 링크를 확인해 주세요',
      alternative: { featureId: 'community', step: 'cafe-post' } };
  }
  const posts = local.cafePosts;
  if (posts?.status !== 'available') return answer(t.t('data.real.local.cafe.postsUnavailable'));
  if (!posts.items.length) return answer(t.t('data.real.local.cafe.noPosts'));
  const recent = [...posts.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const named = recent.filter(row => normalizeNavisName(value).includes(normalizeNavisName(row.subject)));
  const rows = named.length ? named : recent;
  return answer(rows.slice(0, 4).map(row => `${row.subject} · ${t.t(`data.real.local.cafe.state.${row.state}`)}`).join('\n'));
}

function navigation(raw: string, snapshot: DataSnapshot): DomainDetail | null | undefined {
  const value = normalizeNavisInput(raw);
  if (snapshot.tables.realLocal && cafeReceiptQuery.test(value)) return null;
  // A location question is answered from the catalog path, so generic panel navigation must not claim it.
  if (whereIs.test(value) && whereFeature(value)) return null;
  if ((ackVerb.test(value) || reopenVerb.test(value)) && (changeScope.test(value) || kindsOf(value).length > 0 || /변화|소식/u.test(value))) return null;
  const wantsOpen = openVerb.test(value);
  if (wantsOpen && /열어|보기|화면|위젯|패널|근거|상세|눌러|펼쳐|이동|넘어가/u.test(value)) {
    const ranking = getLocalTrendRanking(snapshot);
    const matches = ranking?.status === 'ready' ? namedTrendRows(value, ranking.items) : [];
    if (trendFeature.test(value) || matches.length === 1 && !changeScope.test(value) && !areaScope.test(value)) {
      const view = { featureId: TRENDS, view: 'keywords' } as const;
      const item = matches.length === 1 && { ...view, itemId: matches[0].row.id };
      return { args: item && validateAgentNavigationArgs('ui.openDetail', item) ? item : view };
    }
  }
  if (/상권|유동\s*인구|시간대|막대|칸/u.test(value) && wantsOpen) {
    const hour = hourOf(value);
    if (/상권분석|상권\s*(?:보여|열어)|유동인구\s*위젯|위젯/u.test(value) && hour === undefined) return { args: { featureId: AREA } };
    if (hour !== undefined && /시간대|막대|칸|상세|자세히/u.test(value)) return { args: { featureId: AREA, view: 'hour', hour } };
    if (/상권|유동/u.test(value)) return { args: { featureId: AREA } };
  }
  if (wantsOpen && (/동네\s*(?:변화|소식|알림)|경쟁점\s*알림|접어\s*둔|접은|확인한\s*소식|확인\s*끝낸/u.test(value))) {
    return /접어\s*둔|접은|확인한\s*소식|확인\s*끝낸/u.test(value) ? { args: { featureId: CHANGES, view: 'folded' } } : { args: { featureId: CHANGES } };
  }
  return undefined;
}

/** A refused change command still opens the row in its own list. */
function handoff(command: string, draft: Readonly<Record<string, unknown>>): DetailRef | undefined {
  if (command !== 'localChanges.acknowledge' && command !== 'localChanges.unacknowledge') return;
  return { featureId: CHANGES, view: command === 'localChanges.unacknowledge' ? 'folded' : 'open',
    ...(typeof draft.changeId === 'string' ? { itemId: draft.changeId } : {}) };
}

export const localDomain: DomainAdapter = {
  featureIds,
  commands: [commandAdapter('localChanges.acknowledge'), commandAdapter('localChanges.unacknowledge')],
  reads: [recordReader],
  projectWidget, route, navigation, handoff,
  // A stored change title or an explicit local-change phrase wins over shop-type wording in settings.
  routePresentation(text, snapshot, locale, run) {
    const cafeReceipt = cafeReceiptRoute(text, snapshot);
    if (cafeReceipt) return cafeReceipt;
    const value = normalizeNavisInput(text), { t } = labels(locale);
    if (run?.layer === 'marketing' && unnamedAcknowledgment.test(value)) return changeRoute(value, snapshot, locale);
    // A widget that is on the board is answered by its board placement (layout); one that is not is answered by where it lives in the catalog.
    const asked = whereIs.test(value) ? whereFeature(value) : undefined;
    if (asked && !run?.boards.marketing.pages.some(page => page.panels.some(panel => panel.featureId === asked))) return route(text, snapshot, locale);
    const named = changeRows(snapshot).some(row => normalizeNavisName(value).includes(normalizeNavisName(titleOf(row, t))));
    // Marking or reopening a stored change is a card turn, ahead of the briefing's own acknowledge wording.
    const bookkeeping = (ackVerb.test(value) || reopenVerb.test(value)) && kindsOf(value).length > 0;
    // Candidate names overlap with the shop catalog. An implicit match needs search context and yields to shop metrics.
    const keyword = (trendFeature.test(value) || !/가격|판매|팔렸|매출/u.test(value) && trendQuestion.test(value)) && namesTrend(value, snapshot);
    return named || bookkeeping || changeScope.test(value) || keyword ? route(text, snapshot, locale) : undefined;
  },
};
