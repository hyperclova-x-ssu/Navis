import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import { handlers, type HandlerContext, type HandlerResult } from '../../../data/commands/handlers';
import type { DataCommandResult } from '../../../data/commands/types';
import { addDays, isIsoDate, isTime, LAST_MONTH_END, LAST_MONTH_START, NOW, TODAY } from '../../../data/db/time';
import type { DataSnapshot, DataText } from '../../../data/db/types';
import { couponRow, routeNameKey, SHOT_OPTION_ID } from '../../../data/marketing/derive';
import { NIGHT_SEND_RESTRICTION, ratePercent, SLOT_BENEFIT_IDS } from '../../../data/marketing/calc';
import { benefitName, benefitPrice, benefitProblem, couponBenefit, COUPON_BENEFIT_KINDS } from '../../../data/marketing/benefit';
import type { CouponBenefit, CouponRow, ExpiryItem, MarketingCommand, MarketingModelMap, QuietSlot, SlotBenefitId } from '../../../data/marketing/types';
import { expiryDiscount, EXTEND_DAYS, PUBLIC_ISSUE_LIMIT, readDemand, resolveDataText, selectWidget } from '../../../data/widget-data';
import {
  validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill,
  type AgentFact, type AgentRecordMatch, type AgentWireArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import { navisTranslator } from '../messages';
import { navisMoneySpans, normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisNumber, parseNavisTime } from '../navis-input';
import type {
  CommandAdapter, DomainAdapter, DomainDetail, DomainRoute, DomainTurnInput, LocalSlots,
  ReadToolAdapter, RecordAdapter, RecordSearch, RecordTargets, RunActionOutcome, RunCommandAdapter,
} from './registry';

const slotFeature = 'slot-coupon';
const expiryFeature = 'expiry-coupon';
const statusFeature = 'coupon-status';
type CouponFeature = typeof slotFeature | typeof expiryFeature | typeof statusFeature;
const defaultCondition = { kind: 'default' } as const;
const dash = '—';
const businessDay = (snapshot: DataSnapshot) => snapshot.pos?.businessDate ?? TODAY;
const clockAt = (snapshot: DataSnapshot) => `${businessDay(snapshot)}${NOW.slice(10)}`;
const ref = (slot: string) => ({ slot });
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
const isStamp = (value: unknown): value is string => typeof value === 'string' && value.length === 16
  && value[10] === 'T' && isIsoDate(value.slice(0, 10)) && isTime(value.slice(11));
const isRate = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isBenefit = (value: unknown): value is SlotBenefitId => SLOT_BENEFIT_IDS.some(benefit => value === benefit);
const asLocale = (value: unknown): Locale => value === 'en' || value === 'zh-Hans' || value === 'zh-Hant' ? value : 'ko';

function words(locale: Locale) {
  const tr = navisTranslator(locale);
  const { format: f, t } = tr;
  const l = (ko: string, en: string, hans: string, hant: string) => ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];
  const dt = (value: DataText) => resolveDataText(t, value);
  return { l, t, f, dt, people: (n: number) => f.count(n, 'person'), money: (n: number) => f.money(n, 'full'),
    status: (s: CouponRow['status']) => ({
      active: l('진행 중', 'Active', '进行中', '進行中'),
      paused: l('일시 중지됨', 'Paused', '已暂停', '已暫停'),
      ended: l('종료됨', 'Ended', '已结束', '已結束'),
    })[s],
    coupon: l('쿠폰', 'Coupon', '优惠券', '優惠券'),
    slots: l('시간대', 'Time slot', '时段', '時段'),
    end: l('종료일', 'End date', '结束日期', '結束日期'),
    benefit: l('혜택', 'Benefit', '优惠', '優惠'),
    recipients: l('받는 사람', 'Recipients', '收件人', '收件者'),
    message: l('문자 내용', 'Message', '短信内容', '簡訊內容'),
    sendAt: l('발송 시각', 'Send time', '发送时间', '傳送時間'),
    route: l('경로', 'Channel', '渠道', '管道'),
    issued: l('발행', 'Issued', '已发放', '已發放'),
    used: l('사용', 'Used', '已使用', '已使用'),
    estimate: l('예상', 'Estimate', '预计', '預計'),
    discounted: l('할인가', 'Discounted price', '折后价', '折後價'),
    marginEach: l('개당 남는 돈', 'Margin per item', '每件利润', '每件利潤'),
    published: l('게시', 'Published', '发布', '發布'),
    quantity: l('수량', 'Quantity', '数量', '數量'),
  };
}
type Words = ReturnType<typeof words>;
const slotLabel = (s: QuietSlot, w: Words) => `${w.f.date(s.date, 'short')} ${w.f.time(`${String(s.startHour).padStart(2, '0')}:00`)}–${w.f.time(`${String(s.endHour).padStart(2, '0')}:00`)}`;
const countUsage = (row: CouponRow, w: Words) => row.used === null ? w.t('common.navis.noData')
  : w.l(`${row.issued}장 중 ${row.used}장 사용`, `${row.used} of ${row.issued} used`, `已用 ${row.used}/${row.issued} 张`, `已用 ${row.used}/${row.issued} 張`);
const eligible = (m: MarketingModelMap['slot-coupon'], slotId: string) =>
  m.recipients.filter(row => row.selectable && row.slotIds.includes(slotId));
const defaultSlot = (m: MarketingModelMap['slot-coupon']) =>
  m.openSlots.find(row => eligible(m, row.slotId).length > 0) ?? m.openSlots[0];

function model<F extends CouponFeature>(snapshot: DataSnapshot, feature: F): MarketingModelMap[F] | undefined {
  const view = selectWidget(snapshot, feature, defaultCondition, 'normal');
  return view.status === 'ready' ? view.model : undefined;
}

function fact(key: string, label: string, value: number | string, display = String(value), unit = 'text', date?: string): AgentFact {
  return { key, label, value: typeof value === 'string' ? value.slice(0, 500) : value, display: display.slice(0, 500),
    unit, ...(date ? { date } : {}) };
}

function couponFacts(row: CouponRow, w: Words, prefix: string) {
  const name = w.dt(row.name), benefit = couponBenefit(row);
  const benefitText = benefit?.kind === 'percent' ? w.f.percent(benefit.value)
    : benefit?.kind === 'amount' || benefit?.kind === 'setPrice' ? w.money(benefit.value)
      : w.l('무료 품목', 'Free item', '免费商品', '免費品項');
  return [
    fact(`${prefix}.row`, w.coupon, name, `${name} · ${w.status(row.status)} · ${w.f.date(row.endsOn, 'short')} · ${countUsage(row, w)}`, 'text', row.endsOn),
    fact(`${prefix}.benefit`, name, benefitText),
    fact(`${prefix}.end`, name, row.endsOn, `${w.f.date(row.endsOn, 'short')} · ${w.f.count(Math.max(0, row.daysLeft), 'day')}`, 'date', row.endsOn),
    ...row.routes.filter(route => route.active).map(route => fact(`${prefix}.route`, w.t(route.routeNameKey), route.issued,
      `${name} · ${w.t(route.routeNameKey)} · ${countUsage({ ...row, used: route.used, issued: route.issued }, w)}`, 'count')),
  ];
}

function statusRows(snapshot: DataSnapshot) {
  const store = snapshot.tables.marketing;
  return store.coupon.map(coupon => couponRow(store, coupon));
}

function projectWidget(snapshot: DataSnapshot, feature: FeatureId, condition: QueryCondition, locale: Locale) {
  if (feature !== slotFeature && feature !== expiryFeature && feature !== statusFeature) return;
  if (condition.kind !== 'default') return { status: 'unsupported_period' as const };
  const w = words(locale);
  if (feature === slotFeature) {
    const m = model(snapshot, feature);
    const sent = (m?.sent ?? statusRows(snapshot).filter(row => row.origin === 'slot')).slice(0, 6);
    if (!m && !sent.length) return { status: 'missing' as const };
    const body = m && [w.l('(광고)', '(Ad)', '（广告）', '（廣告）'), w.dt(m.message.body),
      w.l('수신 거부', 'Opt out', '退订', '退訂')].join(' · ');
    const shotCost = snapshot.tables.menuOption.find(option => option.optionId === SHOT_OPTION_ID)?.cost;
    const activeCount = model(snapshot, statusFeature)?.activeCount ?? 0;
    return { facts: [
      fact('slot.quietHours.count', w.slots, m?.slotCount ?? 0, w.f.count(m?.slotCount ?? 0, 'count'), 'count'),
      fact('slot.regulars.count', w.recipients, m?.regularsCount ?? 0, w.people(m?.regularsCount ?? 0), 'person'),
      ...(m ? m.slots.slice(0, 12).map(s => fact('slot.row', w.slots, s.expected, `${slotLabel(s, w)} · ${w.estimate} ${w.people(s.expected)} · ${w.people(s.average)} ${w.l('평소', 'usual', '平常', '平常')} · ${w.people(eligible(m, s.slotId).length)} ${w.recipients}`, 'person', s.date)) : []),
      ...(m ? [fact('slot.message', w.message, body ?? '')] : []),
      ...(m && m.menu.price > 0 ? [fact('slot.benefit.basis', w.t(m.menu.nameKey), m.benefits.differenceVsNext,
        [`${w.t(m.menu.nameKey)} ${w.money(m.menu.price)}`, `${w.money(m.menu.unitCost)} ${w.l('원가', 'cost', '成本', '成本')}`,
          ...(shotCost == null ? [] : [`${w.money(shotCost)} ${w.l('샷 원가', 'extra shot cost', '浓缩成本', '濃縮成本')}`])].join(' · '), 'KRW'),
      ...m.benefits.options.map(o => fact('slot.benefit.kept', w.dt(o.name), o.marginPerCoupon, `${w.dt(o.name)} · ${w.money(o.marginPerCoupon)}`, 'KRW'))] : []),
      fact('slot.sent.count', w.l('보낸 쿠폰', 'Sent coupons', '已发送优惠券', '已傳送優惠券'), m?.sent.length ?? sent.length, w.f.count(m?.sent.length ?? sent.length, 'count'), 'count'),
      { ...fact('slot.status.active', w.status('active'), activeCount, couponCount(activeCount, w), 'count'), source: statusFeature },
      ...sent.map(row => fact('slot.sent.row', w.coupon, w.dt(row.name), `${w.dt(row.name)} · ${countUsage(row, w)} · ${w.f.date(row.endsOn, 'short')}`, 'text', row.endsOn)),
      fact('slot.send.rule', w.sendAt, Number(NIGHT_SEND_RESTRICTION), sendRule(w), 'rule'),
      ...readDemand(snapshot).hourly.flatMap(({ date, hours }) => hours.map(hour => fact(`slot.hour.${date}.${hour.hour}`, w.slots, hour.expected,
        `${w.f.date(date, 'short')} ${w.f.time(`${String(hour.hour).padStart(2, '0')}:00`)} · ${w.estimate} ${w.people(hour.expected)} · ${w.people(hour.average)} ${w.l('평소', 'usual', '平常', '平常')}`, 'person', date))),

    ] };
  }
  if (feature === expiryFeature) {
    const m = model(snapshot, feature);
    if (!m) return { status: 'missing' as const };
    return { facts: [
      ...m.items.slice(0, 8).flatMap(item => [
        fact('expiry.item.qty', w.t(item.nameKey), item.qty, `${w.t(item.nameKey)} · ${w.f.quantity(item.qty, item.unit)}`, item.unit, item.expiresOn),
        ...(item.atRecommended ? discountFacts(item, item.atRecommended, w) : []),
        ...(item.handled ? [fact('expiry.item.handled', w.t(item.nameKey), w.t('data.marketing.error.expiryAlreadyMade'))] : []),
      ]),
      ...m.pendingPosts.slice(0, 5).map(post => fact('expiry.pending.route', w.route, post.route, w.t(routeNameKey(post.route)))),
    ] };
  }
  const m = model(snapshot, feature);
  const rows = m ? [...m.rows, ...m.ended] : statusRows(snapshot).filter(row => row.status === 'ended' && row.endsOn.slice(0, 7) === businessDay(snapshot).slice(0, 7));
  const performance = selectWidget(snapshot, 'marketing-performance', defaultCondition, 'normal');
  const perf = performance.status === 'ready' ? performance.model : undefined;
  return { facts: [
    fact('coupons.active', w.status('active'), m?.activeCount ?? 0, couponCount(m?.activeCount ?? 0, w), 'count'),
    fact('coupons.paused', w.status('paused'), m?.pausedCount ?? 0, couponCount(m?.pausedCount ?? 0, w), 'count'),
    fact('coupons.endingSoon', w.l('곧 끝나는 쿠폰', 'Ending soon', '即将到期', '即將到期'), m?.endingSoonCount ?? 0, couponCount(m?.endingSoonCount ?? 0, w), 'count'),
    ...(m?.monthUsed == null ? [] : [fact('coupons.used.month', w.used, m.monthUsed, couponCount(m.monthUsed, w), 'count')]),
    ...(perf?.rate == null ? [] : [{ ...fact('coupons.performance.rate', w.l('사용률', 'Redemption rate', '使用率', '使用率'), perf.rate, w.f.percent(perf.rate), 'percent'), source: 'marketing-performance' }]),
    ...(perf ? [{ ...fact('coupons.performance.profit', w.l('할인 후 이익', 'Profit after discounts', '折后利润', '折後利潤'), perf.profit, w.money(perf.profit), 'KRW'), source: 'marketing-performance' }] : []),
    ...rows.flatMap(row => {
      const rate = row.used === null ? null : ratePercent(row.used, row.issued);
      return rate === null ? [] : [{ row, rate }];
    }).sort((a, b) => b.rate - a.rate).slice(0, 5).map(({ row, rate }) => fact('coupons.rank', w.dt(row.name), rate, w.f.percent(rate), 'percent')),
    ...rows.slice(0, 15).flatMap(row => [
      ...couponFacts(row, w, `coupon.${row.couponId}`),
      ...(row.endingSoon ? [fact('coupons.ending.row', w.coupon, w.dt(row.name),
        `${w.dt(row.name)} · ${w.f.date(row.endsOn, 'short')} · ${w.f.count(row.daysLeft, 'day')}`, 'text', row.endsOn)] : []),
      ...(row.status === 'ended' ? [fact('coupons.ended.row', w.coupon, w.dt(row.name),
        `${w.dt(row.name)} · ${w.f.date(row.endsOn, 'short')} · ${countUsage(row, w)}`, 'text', row.endsOn)] : []),
    ]),
  ].slice(0, 128) };
}

const couponCount = (n: number, w: Words) => w.l(`${n}장`, String(n), `${n} 张`, `${n} 張`);
function discountFacts(item: ExpiryItem, discount: ReturnType<typeof expiryDiscount>, w: Words) {
  const metrics = [
    ['price', w.discounted, discount.discountedPrice],
    ['each', w.marginEach, discount.marginEach],
    ['total', w.l('다 팔았을 때', 'If all sell', '全部售出时', '全部售出時'), discount.ifAllSold],
    ['discard', w.l('버리면 드는 손해', 'Loss if discarded', '报废损失', '報廢損失'), discount.lossIfDiscarded],
  ] as const;
  return [
    ...metrics.map(([key, label, value]) => fact(`expiry.discount.${key}`, `${w.estimate} ${label}`, value, w.money(value), 'KRW', item.expiresOn)),
    fact('expiry.discount.max', w.l('할인 한도', 'Discount limit', '折扣上限', '折扣上限'), discount.maxRatePercent, w.f.percent(discount.maxRatePercent), 'percent'),
  ];
}

function slotMatches(text: string, snapshot: DataSnapshot, slots: readonly QuietSlot[]): QuietSlot[] {
  const weekdays = '월화수목금토일';
  const day = /([월화수목금토일])(?:요일|욜|(?=\s*\d+\s*시))/u.exec(text)?.[1];
  const dated = parseNavisDate(text, businessDay(snapshot));
  const hour = parseNavisTime(text, clockAt(snapshot));
  return slots.filter(row => (!day || row.weekday === weekdays.indexOf(day) + 1)
    && (!dated || row.date === dated)
    && (!hour || Number(hour.slice(0, 2)) >= row.startHour && Number(hour.slice(0, 2)) < row.endHour)
    && (!/오전/u.test(text) || row.startHour < 12));
}

const couponAliases = [
  /화요일|화욜|샷\s*쿠폰|샷\s*추가/u, /첫\s*방문/u, /고마워요|다시\s*와\s*주셔서/u,
  /가을\s*(?:신메뉴|맛보기)/u, /비\s*오는\s*날/u,
];
function namedCoupons(query: string, rows: readonly CouponRow[], w: Words): CouponRow[] {
  const normalized = normalizeNavisName(query);
  const requestedWeekday = /([월화수목금토일])(?:요일|욜)/u.exec(query)?.[1];
  return rows.filter(row => {
    const name = w.dt(row.name);
    if (row.couponId === query || normalized.length > 2 && normalized.includes(normalizeNavisName(name))) return true;
    if (requestedWeekday && !name.includes(`${requestedWeekday}요일`)) return false;
    return couponAliases.some(alias => alias.test(query) && alias.test(name));
  });
}

type Entry = { id: string; label: string; fields?: AgentRecordMatch['fields'] };
function recordReader(kind: 'coupon' | 'couponCode' | 'slot', entries: (input: RecordSearch) => readonly Entry[]): RecordAdapter {
  const matches = (input: RecordSearch) => entries(input).slice(0, 5);
  const handle = (i: number) => `n16-${kind}-${i + 1}`;
  return {
    kind,
    search: input => matches(input).map(({ label, fields }, i) => ({
      handle: handle(i), match: 'exact', ...(fields && { fields }), ...(!input.privateLookup ? { label: label.slice(0, 180) } : {}),
    })),
    resolve: (input, key) => matches(input).find((_, i) => handle(i) === key)?.id,
    describe: match => match.label,
  };
}
const slotReader = recordReader('slot', ({ query, snapshot, locale, privateLookup }) => {
  const m = model(snapshot, slotFeature);
  if (!m) return [];
  const exact = m.slots.find(row => row.slotId === query);
  if (!exact && query === '*') return m.regularsCount ? [{ id: 'all', label: m.recipients.filter(row => row.selectable).map(row => words(locale).dt(row.name)).join(' · ') }] : [];
  return (exact ? [exact] : slotMatches(query, snapshot, m.slots)).map(row => {
    const w = words(locale), recipients = eligible(m, row.slotId);
    return { id: row.slotId, label: privateLookup ? slotLabel(row, w) :
      [slotLabel(row, w), w.people(recipients.length), ...recipients.map(person => w.dt(person.name))].join(' · '),
      fields: { date: row.date, hour: row.startHour, handled: row.handled, recipientCount: recipients.length } };
  });
});
const couponReader = recordReader('coupon', ({ query, snapshot, locale }) => {
  const rows = statusRows(snapshot), w = words(locale);
  return namedCoupons(query, rows, w).map(row => ({
    id: row.couponId, label: w.dt(row.name), fields: { status: row.status, date: row.endsOn,
      endingSoon: row.endingSoon, reminderRecipients: row.reminderRecipients },
  }));
});
/** D-326 Q19: Place News codes already posted and still shown, for the unpublish card. */
function publishedCodes(snapshot: DataSnapshot) {
  const store = snapshot.tables.marketing, rows = statusRows(snapshot);
  return store.couponCode.filter(code => code.route === 'place_news' && code.activatedAt !== null && !code.unpublishedAt
    && rows.some(row => row.couponId === code.couponId && row.status !== 'ended'));
}
const codeReader = recordReader('couponCode', ({ query, snapshot, locale, command }) => {
  const m = model(snapshot, expiryFeature);
  const rows = statusRows(snapshot);
  if (command === 'coupon.unpublish') {
    return publishedCodes(snapshot).filter(code => code.codeId === query || query === '*').map(code => ({
      id: code.codeId, label: `${words(locale).t(routeNameKey(code.route))} · ${code.code}`,
      fields: { route: code.route, activated: true, eligible: true, unpublished: false },
    }));
  }
  return (m?.pendingPosts ?? []).filter(post => post.codeId === query || query === '*')
    .filter(post => post.route === 'place_news' && rows.some(row => row.couponId === post.couponId && row.status === 'active'))
    .map(post => ({ id: post.codeId, label: `${words(locale).t(routeNameKey(post.route))} · ${post.code}`,
      fields: { route: post.route, activated: false, eligible: true, unpublished: false } }));
});

function expand(wire: unknown, slots: LocalSlots, targets: RecordTargets): Record<string, unknown> {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return {};
  return Object.fromEntries(Object.entries(wire).map(([key, value]) => [key,
    value && typeof value === 'object' && 'handle' in value ? targets.get(value.handle)?.id
      : value && typeof value === 'object' && 'slot' in value ? slots[value.slot] : value]));
}

type Lifecycle = 'coupon.pause' | 'coupon.resume' | 'coupon.extend';
type Outbound = 'coupon.sendSlot' | 'coupon.notifyEnding' | 'coupon.markPosted';
// D-326 Q19: create (당일 소진, Place News), edit, end early and unpublish are local cards with a receipt undo.
type Editing = 'coupon.createExpiry' | 'coupon.update' | 'coupon.endEarly' | 'coupon.unpublish';
type Action = Lifecycle | Outbound | Editing;
const features: Record<Action, CouponFeature> = {
  'coupon.pause': statusFeature, 'coupon.resume': statusFeature, 'coupon.extend': statusFeature,
  'coupon.sendSlot': slotFeature, 'coupon.notifyEnding': statusFeature, 'coupon.markPosted': expiryFeature,
  'coupon.createExpiry': expiryFeature, 'coupon.update': statusFeature, 'coupon.endEarly': statusFeature, 'coupon.unpublish': statusFeature,
};
const allowed = (row: CouponRow, command: Lifecycle) =>
  command === 'coupon.pause' ? row.canPause : command === 'coupon.resume' ? row.canResume : row.canExtend;
const actionTitles = (w: Words) => ({
  'coupon.pause': w.l('쿠폰 일시 중지', 'Pause coupon', '暂停优惠券', '暫停優惠券'),
  'coupon.resume': w.l('쿠폰 다시 시작', 'Resume coupon', '恢复优惠券', '恢復優惠券'),
  'coupon.extend': w.l('쿠폰 7일 늘리기', 'Extend coupon 7 days', '优惠券延长 7 天', '優惠券延長 7 天'),
  'coupon.sendSlot': w.l('빈 시간 쿠폰 보내기', 'Send quiet-hour coupon', '发送空闲时段优惠券', '傳送空閒時段優惠券'),
  'coupon.notifyEnding': w.l('쿠폰 종료 알림 보내기', 'Send expiration reminder', '发送到期提醒', '傳送到期提醒'),
  'coupon.markPosted': w.l('쿠폰 올렸다고 표시하기', 'Mark coupon as posted', '标记优惠券已发布', '標記優惠券已發布'),
  'coupon.createExpiry': w.l('당일 소진 쿠폰 만들기', 'Create sell-today coupon', '创建当日售完优惠券', '建立當日售完優惠券'),
  'coupon.update': w.l('쿠폰 고치기', 'Edit coupon', '修改优惠券', '修改優惠券'),
  'coupon.endEarly': w.l('쿠폰 일찍 끝내기', 'End coupon early', '提前结束优惠券', '提前結束優惠券'),
  'coupon.unpublish': w.l('쿠폰 게시 취소', 'Unpublish coupon', '取消发布优惠券', '取消發布優惠券'),
});

type ActionDraft = { args: Record<string, unknown>; locale: Locale };
function resolveAction(type: Action, wire: unknown, slots: LocalSlots, targets: RecordTargets): ActionDraft | undefined {
  if (!validateAgentDraft(type, wire)) return;
  const args = expand(wire, slots, targets);
  if (type === 'coupon.createExpiry' && args.benefit) args.benefit = expand(args.benefit, slots, targets);
  if (validateAgentCommandArgs(type, args)) return { args, locale: asLocale(slots.navisLocale) };
}

function lifecycle(type: Lifecycle): CommandAdapter<Extract<MarketingCommand, { type: Lifecycle }>, ActionDraft> {
  return {
    command: type, featureId: statusFeature, slots: {},
    resolve: (wire, slots, _snapshot, targets) => resolveAction(type, wire, slots, targets),
    preflight({ args, locale }, { snapshot }) {
      const row = statusRows(snapshot).find(coupon => coupon.couponId === args.couponId);
      if (!row) return { kind: 'conflict' };
      if (!allowed(row, type)) return { kind: 'unchanged' };
      const w = words(locale), name = w.dt(row.name);
      const fields = [{ label: w.coupon, before: name, after: name },
        type === 'coupon.extend'
          ? { label: w.end, before: w.f.date(row.endsOn, 'short'), after: w.f.date(addDays(row.endsOn, EXTEND_DAYS), 'short') }
          : { label: w.coupon, before: w.status(row.status), after: w.status(type === 'coupon.pause' ? 'paused' : 'active') }];
      return { kind: 'ready', command: { type, couponId: row.couponId }, preview: { title: actionTitles(w)[type], target: name, fields } };
    },
    undoToken: result => result.undoToken,
  };
}

/** Runs the same handler the widget does on the captured snapshot, so the card only opens for an applicable change. */
function simulate(snapshot: DataSnapshot, command: MarketingCommand, proposalId: string) {
  let seq = snapshot.seq;
  const context: HandlerContext = { snapshot, tables: snapshot.tables, nextId: prefix => `${prefix}-navis-${proposalId}-${++seq}` };
  return (handlers[command.type] as (input: HandlerContext, command: MarketingCommand) => HandlerResult)(context, command);
}
const rejected = (result: Extract<HandlerResult, { ok: false }>) => ({
  kind: result.reason === 'TRANSACTION_BUSY' ? 'busy' as const : result.code === 'CONFLICT' || result.code === 'NOT_FOUND' ? 'conflict' as const : 'invalid' as const,
  field: result.field, messageKey: result.messageKey,
});
/** The future issue limit as the edit handler reads it: the stored limit, else the Place News code's own count. */
const issueLimit = (store: DataSnapshot['tables']['marketing'], coupon: DataSnapshot['tables']['marketing']['coupon'][number]) =>
  coupon.futureIssueCount ?? (store.couponCode.find(code => code.couponId === coupon.couponId && code.route === 'place_news' && !code.activatedAt)
    ?? store.couponCode.find(code => code.couponId === coupon.couponId && code.route === 'place_news' && code.activatedAt && !code.unpublishedAt))?.issueCount ?? PUBLIC_ISSUE_LIMIT;
const benefitText = (row: Pick<CouponRow, 'benefitType' | 'benefitValue'>, w: Words) => {
  const benefit = couponBenefit(row);
  return benefit?.kind === 'percent' ? w.f.percent(benefit.value) : benefit ? w.money(benefit.value) : w.l('무료 품목', 'Free item', '免费商品', '免費品項');
};

/**
 * D-326 Q19. Every card is local: it changes this store only, keeps already issued customer terms and offers a receipt undo.
 * The widget's own discount limit and margin check run inside the handler for a new coupon and for an edited benefit.
 */
function editing(type: Exclude<Editing, 'coupon.createExpiry'>): CommandAdapter<MarketingCommand, ActionDraft> {
  return {
    command: type, featureId: features[type],
    slots: type === 'coupon.update' ? { benefitValue: isCount, quantity: isCount } : {},
    resolve: (wire, slots, _snapshot, targets) => resolveAction(type, wire, slots, targets),
    preflight({ args, locale }, { snapshot, proposalId, idempotencyKey }) {
      const w = words(locale), title = actionTitles(w)[type], store = snapshot.tables.marketing;
      const field = (label: string, before: string, after: string) => ({ label, before, after });
      if (type === 'coupon.unpublish') {
        const code = store.couponCode.find(row => row.codeId === args.codeId);
        const coupon = store.coupon.find(row => row.couponId === code?.couponId);
        if (!code || !coupon) return { kind: 'conflict' };
        const command = { type, codeId: code.codeId, idempotencyKey } as const;
        const result = simulate(snapshot, command, proposalId);
        if (!result.ok) return rejected(result);
        if (result.tables === snapshot.tables) return { kind: 'unchanged' };
        return { kind: 'ready', command, tier: 'extra-confirm', preview: { title, target: w.dt(coupon.name), fields: [
          field(w.route, w.t(routeNameKey(code.route)), w.t(routeNameKey(code.route))),
          field(w.l('쿠폰 코드', 'Coupon code', '优惠码', '優惠碼'), code.code, code.code),
          field(w.published, w.l('게시 중', 'Published', '已发布', '已發布'), w.l('게시 안 함', 'Not published', '未发布', '未發布')),
        ] } };
      }
      const coupon = store.coupon.find(row => row.couponId === args.couponId);
      if (!coupon) return { kind: 'conflict' };
      const command = (type === 'coupon.endEarly' ? { type, couponId: coupon.couponId, idempotencyKey }
        : { type, couponId: coupon.couponId, ...(isCount(args.benefitValue) ? { benefitValue: args.benefitValue } : {}),
          ...(isCount(args.quantity) ? { quantity: args.quantity } : {}), idempotencyKey }) as MarketingCommand;
      const result = simulate(snapshot, command, proposalId);
      if (!result.ok) return rejected(result);
      if (result.tables === snapshot.tables) return { kind: 'unchanged' };
      const next = result.tables.marketing.coupon.find(row => row.couponId === coupon.couponId);
      if (!next) return { kind: 'conflict' };
      const before = couponRow(store, coupon), after = couponRow(result.tables.marketing, next);
      const fields = type === 'coupon.endEarly'
        ? [field(w.coupon, w.status(before.status), w.status(after.status)), field(w.end, w.f.date(before.endsOn, 'short'), w.f.date(after.endsOn, 'short'))]
        : [...(benefitText(before, w) !== benefitText(after, w) ? [field(w.benefit, benefitText(before, w), benefitText(after, w))] : []),
          ...(isCount(args.quantity) && issueLimit(store, coupon) !== args.quantity
            ? [field(w.quantity, couponCount(issueLimit(store, coupon), w), couponCount(args.quantity, w))] : [])];
      if (!fields.length) return { kind: 'unchanged' };
      return { kind: 'ready', command, preview: { title, target: w.dt(coupon.name), fields },
        ...(type === 'coupon.endEarly' ? { tier: 'extra-confirm' as const } : {}) };
    },
    undoToken: result => result.undoToken,
  };
}

function createBenefit(args: ActionDraft['args']): CouponBenefit | undefined {
  if (isRate(args.discountRate)) return { kind: 'percent', value: args.discountRate };
  const value = args.benefit as Partial<CouponBenefit> | undefined;
  const kind = COUPON_BENEFIT_KINDS.find(kind => kind === value?.kind);
  if (kind && isCount(value?.value)) return { kind, value: value.value };
}

const createExpiry: RunCommandAdapter<ActionDraft> = {
  command: 'coupon.createExpiry', slots: { discountRate: isRate, benefitValue: isCount },
  resolve: (wire, slots, _snapshot, targets) => resolveAction('coupon.createExpiry', wire, slots, targets),
  preflight({ args, locale }, { snapshot, proposalId, idempotencyKey }) {
    const w = words(locale), item = model(snapshot, expiryFeature)?.items.find(row => row.itemId === args.itemId);
    const benefit = createBenefit(args);
    if (!item || !benefit || item.unitCost === null) return { kind: 'conflict' };
    const command = { type: 'coupon.createExpiry', itemId: item.itemId, benefit, route: 'place_news', idempotencyKey } as const;
    const result = simulate(snapshot, command, proposalId);
    if (!result.ok) return rejected(result);
    const price = benefitPrice(item.price, benefit);
    const field = (label: string, before: string, after: string) => ({ label, before, after });
    return { kind: 'ready', preview: { title: actionTitles(w)['coupon.createExpiry'], target: w.t(item.nameKey), fields: [
      field(w.benefit, dash, w.dt(benefitName(benefit))),
      field(w.discounted, w.money(item.price), w.money(price)),
      field(w.marginEach, dash, w.money(price - item.unitCost)),
      field(w.route, dash, w.t(routeNameKey('place_news'))),
    ] },
    execute(_run, store) {
      if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
      const applied = store.dispatch({ ...command, baseRevision: snapshot.revision });
      if (!applied.ok) return outboundResult(expiryFeature, applied);
      if (applied.duplicate || !applied.noticeKey) return { kind: 'unchanged' };
      const { undoToken } = applied;
      return { kind: 'applied', notice: { kind: 'success', featureId: expiryFeature, messageKey: applied.noticeKey, params: applied.params },
        ...(undoToken ? { undo: () => store.undo(undoToken).ok } : {}) };
    } };
  },
};

const invalid = (messageKey: string) => ({ kind: 'invalid' as const, messageKey });
function outboundResult(featureId: CouponFeature, result: DataCommandResult): RunActionOutcome {
  if (!result.ok) return result.reason === 'TRANSACTION_BUSY' ? { kind: 'busy' }
    : result.code === 'CONFLICT' || result.code === 'NOT_FOUND' ? { kind: 'conflict' }
      : { kind: 'invalid', field: result.field, messageKey: result.messageKey };
  if (result.duplicate || !result.noticeKey) return { kind: 'unchanged' };
  return { kind: 'applied', notice: { kind: 'success', featureId, messageKey: result.noticeKey, params: result.params } };
}
function outbound(type: Outbound): RunCommandAdapter<ActionDraft> {
  return {
    command: type, slots: type === 'coupon.sendSlot' ? { body: isText, sendAt: isStamp } : {},
    resolve: (wire, slots, _snapshot, targets) => resolveAction(type, wire, slots, targets),
    preflight({ args, locale }, { snapshot, idempotencyKey }) {
      const feature = features[type], w = words(locale), title = actionTitles(w)[type];
      const field = (label: string, after: string) => ({ label, before: dash, after });
      const ready = (command: MarketingCommand, target: string, fields: readonly ReturnType<typeof field>[]) => ({
        kind: 'ready' as const, preview: { title, target, fields },
        execute(_run: unknown, store?: import('../../../data/widget-data').WidgetDataStore): RunActionOutcome {
          if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
          return outboundResult(feature, store.dispatch({ ...command, baseRevision: snapshot.revision }));
        },
      });
      if (type === 'coupon.sendSlot') {
        const m = model(snapshot, slotFeature);
        const slot = m?.openSlots.find(row => row.slotId === args.slotId);
        const benefit = args.benefitId, body = args.body, sendAt = args.sendAt;
        if (!m || !slot) return { kind: 'conflict' };
        if (!isBenefit(benefit) || (body !== undefined && !isText(body))) return invalid('data.marketing.error.benefitInvalid');
        if (sendAt !== undefined && (!isStamp(sendAt) || sendAt < clockAt(snapshot))) return invalid('data.marketing.error.sendAtPast');
        const recipients = eligible(m, slot.slotId);
        if (!recipients.length) return invalid('data.marketing.error.noRecipients');
        const target = slotLabel(slot, w);
        return ready({ type, slotIds: [slot.slotId], recipientIds: recipients.map(row => row.customerId), benefit, idempotencyKey,
          ...(body && { messageEdits: body.trim() }), ...(sendAt && { sendAt }) }, target, [
          field(w.slots, target), field(w.benefit, w.dt(m.benefits.options.find(row => row.id === benefit)!.name)),
          field(w.recipients, w.people(recipients.length)), field(w.message, body?.trim() ?? w.dt(m.message.bodies[benefit])),
          field(w.sendAt, sendAt ? w.f.dateTime(sendAt) : w.l('지금', 'Now', '现在', '現在')),
        ]);
      }
      if (type === 'coupon.notifyEnding') {
        const row = statusRows(snapshot).find(coupon => coupon.couponId === args.couponId);
        if (!row?.endingSoon || !row.canNotify) return invalid('data.marketing.error.couponNotActive');
        if (!row.reminderRecipients) return invalid('data.marketing.error.noReminderRecipients');
        const target = w.dt(row.name);
        return ready({ type, couponId: row.couponId, idempotencyKey }, target, [
          field(w.coupon, target), field(w.end, w.f.date(row.endsOn, 'short')),
          field(w.recipients, w.people(row.reminderRecipients)), field(w.message, w.t('data.marketing.sms.reminder')),
        ]);
      }
      const code = snapshot.tables.marketing.couponCode.find(row => row.codeId === args.codeId);
      const row = statusRows(snapshot).find(coupon => coupon.couponId === code?.couponId);
      if (!code || code.route !== 'place_news' || code.activatedAt || row?.origin !== 'expiry' || row.status !== 'active') return { kind: 'conflict' };
      if (!model(snapshot, expiryFeature)?.pendingPosts.some(post => post.codeId === code.codeId)) return { kind: 'conflict' };
      const target = w.dt(row.name);
      return { ...ready({ type, codeId: code.codeId, idempotencyKey }, target, [
        field(w.coupon, target), field(w.route, w.t(routeNameKey(code.route))),
        field(w.l('쿠폰 코드', 'Coupon code', '优惠码', '優惠碼'), code.code), field(w.issued, couponCount(code.issueCount, w)),
      ]), tier: 'extra-confirm' };
    },
  };
}

const calcTool: ReadToolAdapter<'calc_expiry_discount'> = {
  tool: 'calc_expiry_discount',
  read(snapshot, args, locale, slots, targets) {
    const rate = slots[args.rate.slot];
    const itemId = 'handle' in args.itemId ? targets.get(args.itemId.handle)?.id : undefined;
    const item = model(snapshot, expiryFeature)?.items.find(row => row.itemId === itemId);
    if (args.withSet) return { status: 'unavailable' };
    if (!item || item.unitCost === null || !isRate(rate)) return { status: 'missing' };
    return { facts: discountFacts(item, expiryDiscount(item.price, item.unitCost, rate, item.qty), words(locale)) };
  },
};

const couponWord = /쿠폰|coupon|优惠券|優惠券/iu;
const slotWord = /빈\s*시간|한산|빈\s*자리|quiet.hour|空闲|空閒/iu;
const expiryWord = /당일\s*소진|소진\s*쿠폰|sell.today|expiry coupon|当日售完|當日售完/iu;
const expiryItemWord = /크[루로]아상|크로와상|치즈케이크|바스크|소금빵/u;
const openWords = /열어|화면|세팅|설정|맞춰|준비|띄워|펼쳐|위치|줄\s*보여|어디\s*있|open|prefill|打开|開啟/iu;
const sendWords = /보내\s*줘|보내기\s*(?:버튼\s*)?눌러|발송(?:해|\s*걸어)|쏴\s*줘|돌려\s*줘|문자\s*예약|뿌려\s*줘|\bsend\b|发送|傳送/iu;
const scheduleWords = /예약|스케줄|schedule|定时|排程/iu;
const reminderWords = /알림|끝난다고|끝나기\s*전|remind|提醒/iu;
const markWords = /올렸.*(?:표시|체크|눌러)|올렸다고|게시\s*(?:완료|했).*(?:처리|표시|코드)|코드\s*세기|mark.*post|标记.*已发布|標記.*已發布/iu;
const prepareWords = /열어|화면|창|준비|세팅|맞춰|보여|빼\s*줘|open|prefill|打开|開啟/iu;
const readWords = /뭐|몇|얼마|누구|알려|어떻게|이유|나갔|현황|명단|언제|있(?:어|냐|나요|어요)|했(?:어|어요)\?|how|which|what/iu;
const weekdayWords = /[월화수목금토일](?:요일|욜|(?=\s*\d+\s*시))/u;
const modifyExpiry = /만들|발행(?!\s*(?:수|량))|생성|create|创建|建立/iu;
const directPublish = /올려\s*(?:줘|주세요)|올리고|바로\s*(?:올려|게시)|게시\s*(?:해|하고|까지)|공개\s*해|\bpublish\b|发布|發布/iu;
const bundledItems = /묶음|번들|세트로|세트\s*(?:구성|메뉴)|(?:두|2)\s*(?:품목|메뉴|가지)|\bbundle\b/iu;
const periodWords = /까지로|종료일을|기간을\s*바꿔|end date|结束日期|結束日期/iu;
const statusText = /진행\s*중|끝난|끝나가는|만료|종료된|일시\s*중지|중지된|멈춰둔|첫\s*방문|고마워요|가을\s*맛보기|샷\s*쿠폰|화요일|active|paused|ended/iu;
const expireCalc = /할인.*계산|할인가|반값|깎으면|남는\s*돈|(?:다|안)\s*팔|손해야|손해|세트.*(?:얼마|추천|가격)|estimate|margin/iu;
const unsafeConsent = /동의\s*(?:안|않|없)|거부한\s*손님|without consent|未同意/iu;
const contactExport = /전화\s*번호|연락처|번호.*(?:엑셀|내려)|excel|phone number|电话号码|電話號碼/iu;
const bulk = /전부|전체|모두|한꺼번에|다\s*(?:정지|멈춰|\d+일)|\ball coupons\b/iu;
// D-326 Q19: one coupon's edit, early end and unpublish are cards; deleting or changing several stays in the widget.
const endEarlyWords = /종료\s*(?:시켜|해)|일찍\s*(?:끝|종료)|조기\s*종료|지금\s*(?:끝|종료)|그만\s*(?:해|할래|두)|end early|提前结束|提前結束/iu;
const unpublishWords = /게시\s*(?:취소|해제|내려|중단)|(?:플레이스|소식).*(?:내려|내리|취소)|unpublish|取消发布|取消發布/iu;
const editWords = /(?:혜택|할인(?:율|액)?|발행\s*수|장수|수량).*(?:바꿔|바꾸|올려|내려|늘려|줄여|변경|수정|고쳐)|\d+\s*장\s*(?:더\s*발행|으로|로)/u;

const namesExpiry = (text: string, coupon: boolean) => expiryWord.test(text) ||
  expiryItemWord.test(text) && (coupon || expireCalc.test(text) || /할인|깎|퍼센트|%/u.test(text));

const parseRate = (text: string): number | undefined => {
  if (/반값/u.test(text)) return 50;
  if (/할인\s*없이/u.test(text)) return 0;
  const found = /(?:마이너스\s*|[-−]\s*)?(\d+(?:\.\d+)?|[영일이삼사오육칠팔구십백열한두세네]+)\s*(?:%|퍼센트|프로|퍼|percent)/iu.exec(text);
  if (!found) return;
  const rate = parseNavisNumber(found[1]);
  return rate === undefined ? undefined : /마이너스|[-−]/u.test(found[0]) ? -rate : rate;
};
function expiryBenefit(text: string, rate: number | undefined): CouponBenefit | undefined {
  const amounts = navisMoneySpans(text);
  const setPrice = /세트\s*가격|가격\s*지정|지정\s*가(?:격)?|판매가|원\s*(?:에|으로|로)\s*팔|set\s*price|指定价|指定價/iu.test(text);
  if (rate !== undefined) return amounts.length || setPrice ? undefined : { kind: 'percent', value: rate };
  if (amounts.length !== 1) return;
  if (setPrice) return { kind: 'setPrice', value: amounts[0].value };
  if (/할인|깎|\b(?:off|discount)\b|减|減/iu.test(text)) return { kind: 'amount', value: amounts[0].value };
}
function draftBody(text: string) {
  return /[“「『"']([^”」』"']+)[”」』"']/u.exec(text)?.[1]?.trim()
    ?? /(?:내용|문구).*?(?:[:：])\s*(.+)$/u.exec(text)?.[1]?.trim();
}
function scheduleTime(text: string, snapshot: DataSnapshot) {
  return parseNavisTime(text.replace(/밤|저녁/gu, '오후').replace(/아침|새벽/gu, '오전'), clockAt(snapshot));
}
function slotBenefit(text: string): SlotBenefitId | undefined {
  const rate = parseRate(text);
  return rate === 10 ? 'percent-10' : /500\s*원|오백\s*원/u.test(text) ? 'amount-500'
    : /샷.*무료|무료.*샷|free shot/iu.test(text) ? 'free-shot' : undefined;
}
function expiryItem(text: string, m: MarketingModelMap['expiry-coupon'] | undefined, w: Words) {
  const key = normalizeNavisName(text);
  const matches = m?.items.filter(item => {
    const label = w.t(item.nameKey);
    return [label, ...label.split(/\s|\(/u)].some(part => part.length > 2 && key.includes(normalizeNavisName(part)));
  }) ?? [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 || /크[루로]아상|크로와상|치즈케이크|바스크|소금빵/u.test(text)) return undefined;
  return m?.target ?? undefined;
}

const answer = (text: string): DomainRoute => ({ kind: 'answer', answer: text });
const clarify = (field: string, text: string, resume?: (value: string) => DomainRoute | undefined): DomainRoute =>
  ({ kind: 'clarification', field, answer: text, ...(resume && { resume }) });
const widgetRef = (featureId: CouponFeature, view: string, itemId?: string, prefill?: AgentWireArgs): DetailRef =>
  ({ featureId, view, focus: 'action', ...(itemId && { itemId }),
    ...(prefill && validateAgentPrefill(featureId, prefill) && { prefill: { kind: 'widget-draft', command: 'ui.openDetail', fields: prefill } }) });
function refuse(text: string, detail: DetailRef, reason: 'unsupported' | 'invalid_target' = 'unsupported'): DomainRoute {
  const { featureId, itemId, view, prefill } = detail;
  const fields = prefill?.kind === 'widget-draft' ? prefill.fields : undefined;
  const alternative = featureId === expiryFeature
    ? { featureId, command: 'coupon.createExpiry', draft: {
        ...(itemId && { itemId }), ...(typeof fields?.rate === 'number' && { discountRate: fields.rate }), route: 'place_news',
      } }
    : featureId === statusFeature && view === 'reminder' && itemId
      ? { featureId, command: 'ui.setDraftField', draft: { featureId, view, field: 'couponId', value: itemId } }
      : { featureId };
  return { kind: 'refusal', reason, answer: text, alternative };
}
const read = (featureId: CouponFeature, factKeys?: readonly string[], missing?: string): DomainTurnInput =>
  ({ intent: { kind: 'read', featureId, condition: defaultCondition }, factKeys, ...(missing && { onMissing: { answer: missing } }) });
function propose(command: Action, kind: 'slot' | 'coupon' | 'couponCode' | 'stock', field: string, query: string, locale: Locale,
  args: AgentWireArgs = {}, slots: LocalSlots = {}): DomainTurnInput {
  return { intent: { kind: 'command', command, args },
    slots: { ...slots, [field]: query, navisLocale: locale }, lookups: [{ kind, querySlot: field, bind: [field] }] };
}

function sendRule(w: Words) {
  return NIGHT_SEND_RESTRICTION ? w.t('data.marketing.error.nightConsent') :
    w.l('야간에도 예약할 수 있어요. 문자에 동의한 손님에게만 보내요.',
      'Night scheduling is available for customers who consented to SMS.',
      '可以在夜间安排发送，仅发给同意接收短信的顾客。', '可以在夜間安排傳送，僅傳給同意接收簡訊的顧客。');
}

function slotSend(text: string, snapshot: DataSnapshot, locale: Locale, scopedSlotId?: string): DomainRoute {
  const w = words(locale), m = model(snapshot, slotFeature);
  if (unsafeConsent.test(text)) return refuse(w.t('data.marketing.error.noConsent'), widgetRef(slotFeature, 'send'));
  if (/보내(?:진|지)\s*말|(?:보내|발송).*(?:말고|하지\s*마)/u.test(text)) return read(slotFeature, ['slot.message']);
  if (!m) return refuse(w.t('data.state.slot-coupon.no-slots'), widgetRef(slotFeature, 'send'));
  const selectiveAudience = /빼고|제외|(?:[가-힣]씨|[○＊*]{2})|(?:손님|사람)\s*(?:한\s*명|\d+명)만|exclude/iu;
  if (selectiveAudience.test(text)) {
    return refuse(w.l('쿠폰 화면에서 받는 사람을 골라 주세요', 'Choose recipients in the coupon widget.',
      '请在优惠券组件中选择收件人。', '請在優惠券元件中選擇收件人。'), widgetRef(slotFeature, 'send'));
  }
  const named = weekdayWords.test(text);
  const narrowed = scopedSlotId ? m.openSlots.filter(row => row.slotId === scopedSlotId)
    : named ? slotMatches(text, snapshot, m.slots) : m.openSlots.filter(row => eligible(m, row.slotId).length > 0);
  const selected = narrowed.length === 1 ? narrowed[0] : undefined;
  if (!selected) return clarify('slotId', w.t('data.marketing.error.slotRequired'));
  if (selected.handled) return answer(w.l('이 시간에는 쿠폰을 이미 보냈어요', 'A coupon was already sent for this slot.', '此时段已发送优惠券。', '此時段已傳送優惠券。'));
  if (!eligible(m, selected.slotId).length) return refuse(w.t('data.marketing.error.noRecipients'), widgetRef(slotFeature, 'send', selected.slotId));
  const benefitId = slotBenefit(text) ?? m.benefits.recommendedId;
  if (/할인|[%％]/u.test(text) && !slotBenefit(text)) {
    return clarify('benefitId', w.t('data.marketing.error.benefitInvalid'));
  }
  const later = scheduleWords.test(text), time = later ? scheduleTime(text, snapshot) : undefined;
  const date = later ? parseNavisDate(text, businessDay(snapshot)) ?? addDays(businessDay(snapshot), 1) : undefined;
  if (later && !time) return clarify('sendAt', w.l('예약 발송 시각을 알려 주세요', 'Enter a time for the scheduled send.', '请输入定时发送的时间。', '請輸入排程傳送的時間。'),
    value => slotSend(`${text} ${value}`, snapshot, locale, scopedSlotId));
  const sendAt = time && date ? `${date}T${time}` : undefined;
  if (sendAt && sendAt < clockAt(snapshot)) return answer(w.t('data.marketing.error.sendAtPast'));
  const body = draftBody(text);
  return propose('coupon.sendSlot', 'slot', 'slotId', selected.slotId, locale,
    { benefitId, ...(sendAt && { sendAt: ref('sendAt') }), ...(isText(body) && { body: ref('body') }) },
    { ...(sendAt && { sendAt }), ...(isText(body) && { body }) });
}

function statusAction(text: string, snapshot: DataSnapshot, locale: Locale, type: Lifecycle | 'coupon.notifyEnding' | 'coupon.endEarly' | 'coupon.update', selectedId?: string): DomainRoute {
  const w = words(locale), rows = statusRows(snapshot);
  const specific = namedCoupons(selectedId ?? text, rows, w);
  const statedTarget = /화요일|화욜|샷\s*(?:추가|쿠폰)|첫\s*방문|고마워요|다시\s*와\s*주셔서|가을|비\s*오는\s*날/u.test(text);
  const permitted = (row: CouponRow) => type === 'coupon.notifyEnding' ? row.endingSoon && row.canNotify && row.reminderRecipients > 0
    : type === 'coupon.endEarly' || type === 'coupon.update' ? row.status !== 'ended' : allowed(row, type);
  const infer = type === 'coupon.notifyEnding' || type === 'coupon.resume';
  const candidates = specific.length ? specific : statedTarget || !infer ? [] : rows.filter(permitted);
  const choose = w.l('어떤 쿠폰인지 알려 주세요', 'Which coupon?', '请指定优惠券。', '請指定優惠券。');
  const target = candidates.length === 1 ? candidates[0] : undefined;
  if (candidates.length > 1) {
    const choices = candidates.slice(0, 5).map((row, index) => ({ id: `coupon-${index + 1}`, label: w.dt(row.name) }));
    return { kind: 'clarification', field: 'couponId', answer: choose, choices,
      resume(value) {
        const index = choices.findIndex(choice => choice.id === value);
        return index >= 0 ? statusAction(text, snapshot, locale, type, candidates[index].couponId) : undefined;
      },
    };
  }
  if (!target) {
    if (type === 'coupon.notifyEnding') return refuse(w.t('data.marketing.error.noReminderRecipients'), widgetRef(statusFeature, 'reminder'), 'invalid_target');
    if (type === 'coupon.resume' && !statedTarget) return answer(w.l('지금 일시 중지된 쿠폰이 없어요', 'There are no paused coupons.', '目前没有已暂停的优惠券。', '目前沒有已暫停的優惠券。'));
    return clarify('couponId', choose, value => statusAction(`${text} ${value}`, snapshot, locale, type));
  }
  if (!permitted(target)) {
    if (type === 'coupon.notifyEnding') return refuse(w.t(target.endingSoon ? 'data.marketing.error.noReminderRecipients' : 'data.marketing.error.couponNotActive'),
      widgetRef(statusFeature, 'reminder', target.couponId), 'invalid_target');
    return answer(`${w.dt(target.name)} · ${w.status(target.status)} · ${w.f.date(target.endsOn, 'short')}`);
  }
  // A chosen end date ("11월 30일까지") is a custom date: it stays in the widget. Only the widget's own 7 days is a card.
  if (type === 'coupon.extend' && (periodWords.test(text) || /까지|으로|로\s*(?:연장|늘)/u.test(text) && parseNavisDate(text, businessDay(snapshot)))) {
    return refuse(extensionRule(w), widgetRef(statusFeature, 'active', target.couponId));
  }
  const duration = /(\d+|이|삼|사|오|육|칠|팔|구|십)\s*일(?=\s*(?:만|연장|늘))/u.exec(text)?.[1];
  if (type === 'coupon.extend' && (/이틀|사흘/u.test(text) || duration && parseNavisNumber(duration) !== EXTEND_DAYS)) {
    return clarify('extendDays', extensionRule(w), value => /7|칠일|일주일|^네$|^예$/u.test(value)
      ? propose(type, 'coupon', 'couponId', target.couponId, locale) : undefined);
  }
  if (type === 'coupon.update') return updateCard(text, target, locale);
  return propose(type, 'coupon', 'couponId', target.couponId, locale);
}

/** D-326 Q19: the new benefit value keeps the coupon's own kind (percent or won); the quantity is the future issue limit. */
function updateCard(text: string, target: CouponRow, locale: Locale): DomainRoute {
  const w = words(locale), benefit = couponBenefit(target);
  // The coupon's own name can hold numbers ("1,000원 할인"), so the new value is read after the last 쿠폰.
  const tail = text.split(/쿠폰/u).at(-1) || text;
  const percent = parseRate(tail), won = navisMoneySpans(tail).at(-1)?.value;
  const relative = /더\s*발행|장수\s*추가|추가로/u.test(tail);
  const piece = /(\d[\d,]*|[영일이삼사오육칠팔구십백]+)\s*장/u.exec(tail)?.[1];
  const quantity = piece && !relative ? parseNavisNumber(piece) : undefined;
  const editsBenefit = /혜택|할인/u.test(tail) || (quantity === undefined && !relative && (percent !== undefined || won !== undefined));
  const benefitValue = !editsBenefit ? undefined : benefit?.kind === 'percent' ? percent : benefit ? won : undefined;
  if (editsBenefit && !benefit) return refuse(w.l('이 쿠폰은 위젯에서 확인해 주세요', 'Check this coupon in the widget.', '请在组件中查看此优惠券。', '請在元件中查看此優惠券。'), widgetRef(statusFeature, 'active', target.couponId));
  if (relative) return clarify('quantity', w.l('몇 장으로 할까요?', 'How many coupons?', '改为几张？', '改為幾張？'));
  if (editsBenefit && benefitValue === undefined) return clarify('benefitValue', benefit?.kind === 'percent'
    ? w.l('몇 %로 할까요?', 'What percent?', '改为多少 %？', '改為多少 %？') : w.l('얼마로 할까요?', 'What amount?', '改为多少韩元？', '改為多少韓元？'));
  if (benefitValue === undefined && quantity === undefined) return clarify('benefitValue', w.l('무엇을 바꿀까요?', 'What should change?', '要修改什么？', '要修改什麼？'));
  if (benefitValue === target.benefitValue && quantity === undefined) return answer(w.l('이미 같아요.', 'Already set.', '已经相同。', '已經相同。'));
  return propose('coupon.update', 'coupon', 'couponId', target.couponId, locale,
    { ...(benefitValue !== undefined ? { benefitValue: ref('benefitValue') } : {}), ...(quantity !== undefined ? { quantity: ref('quantity') } : {}) },
    { ...(benefitValue !== undefined ? { benefitValue } : {}), ...(quantity !== undefined ? { quantity } : {}) });
}
/** D-326 Q19: one posted Place News code comes down by a card with extra confirmation; issued customer coupons stay valid. */
function unpublishAction(text: string, snapshot: DataSnapshot, locale: Locale, pickedId?: string): DomainRoute {
  const w = words(locale), rows = statusRows(snapshot);
  const posted = publishedCodes(snapshot);
  if (!posted.length) return answer(w.l('게시 중인 플레이스 소식 쿠폰이 없어요', 'No Place News coupon is published.', '没有已发布的 Place 动态优惠券。', '沒有已發布的 Place 動態優惠券。'));
  const named = namedCoupons(text, rows, w);
  const candidates = pickedId ? posted.filter(code => code.codeId === pickedId)
    : named.length ? posted.filter(code => named.some(row => row.couponId === code.couponId)) : posted;
  if (!candidates.length) return answer(w.l('해당 쿠폰은 게시 중이 아니에요', 'That coupon is not published.', '该优惠券未发布。', '該優惠券未發布。'));
  if (candidates.length > 1) {
    const choices = candidates.slice(0, 5).map((code, index) => ({ id: `code-${index + 1}`,
      label: `${w.dt(rows.find(row => row.couponId === code.couponId)!.name)} · ${code.code}` }));
    return { kind: 'clarification', field: 'codeId', answer: w.l('어떤 쿠폰인지 알려 주세요', 'Which coupon?', '请指定优惠券。', '請指定優惠券。'), choices,
      resume(value) {
        const index = choices.findIndex(choice => choice.id === value);
        return index >= 0 ? unpublishAction(text, snapshot, locale, candidates[index].codeId) : undefined;
      } };
  }
  return propose('coupon.unpublish', 'couponCode', 'codeId', candidates[0].codeId, locale);
}
const extensionRule = (w: Words) => w.l('쿠폰은 7일씩 늘릴 수 있어요', 'Coupons can be extended in 7-day increments.',
  '优惠券每次可延长 7 天。', '優惠券每次可延長 7 天。');

function route(raw: string, snapshot: DataSnapshot, locale: Locale, run?: Parameters<NonNullable<DomainAdapter['route']>>[3]): DomainRoute | undefined {
  if (run && run.layer !== 'marketing') return;
  const text = normalizeNavisInput(raw), w = words(locale);
  const coupon = couponWord.test(text);
  const datedSlot = weekdayWords.test(text);
  const slotRegulars = /단골/u.test(text) && (coupon || datedSlot && /\d+\s*시/u.test(text));
  const slotContext = slotWord.test(text) || coupon && datedSlot || slotRegulars || /예약\s*발송|쿠폰\s*발송|문자\s*(?:내용|예약)|추천\s*이유|샷.*무료/u.test(text);
  const expiry = namesExpiry(text, coupon) || /플레이스\s*소식/u.test(text) && modifyExpiry.test(text)
    || expireCalc.test(text) && /쿠폰|세트|팔면|깎으면|할인가|오십|칠십/u.test(text);
  const createsExpiry = expiry && modifyExpiry.test(text);
  const restriction = w.l('이 쿠폰 변경은 위젯에서 확인해 주세요', 'Check the available changes in the coupon widget.',
    '请在优惠券组件中查看可用操作。', '請在優惠券元件中查看可用操作。');
  if ((coupon || slotContext || /보낼\s*손님/u.test(text)) && contactExport.test(text)) {
    return refuse(w.l('가린 이름만 볼 수 있어요', 'Only masked names are available.', '只能查看已隐藏部分的姓名。', '只能查看已遮蔽部分的姓名。'), widgetRef(slotFeature, 'send'), 'unsupported');
  }
  if ((coupon || slotContext || sendWords.test(text)) && unsafeConsent.test(text)) {
    return refuse(w.t('data.marketing.error.noConsent'), widgetRef(slotFeature, 'send'), 'unsupported');
  }
  if (markWords.test(text) && !createsExpiry && !/영상|클립|릴스|쇼츠|video/iu.test(text)) {
    const matches = codeReader.search({ snapshot, locale, query: '*', privateLookup: true });
    if (!matches.length && !coupon && !/플레이스|쿠폰\s*코드/u.test(text)) return;
    if (!matches.length) return answer(w.l('표시할 쿠폰 게시가 없어요', 'There is no coupon post to mark.', '没有可标记的优惠券发布。', '沒有可標記的優惠券發布。'));
    return propose('coupon.markPosted', 'couponCode', 'codeId', '*', locale);
  }
  const extension = /연장|늘려|늘리|일주일\s*늘|extend/iu.test(text) || periodWords.test(text);
  const pause = /멈춰\s*(?:줘|ㅠ|$)|정지\s*(?:해|시켜|$)|중지\s*(?:해|시켜|$)|\bpause\b|暂停|暫停/iu.test(text);
  const resume = /다시\s*(?:시작|켜|돌려)|\bresume\b|恢复|恢復/iu.test(text);
  const endEarly = endEarlyWords.test(text), unpublish = unpublishWords.test(text), editBenefit = editWords.test(text);
  if (coupon && (bulk.test(text) || /삭제|지워|없애/u.test(text))
    && (extension || pause || endEarly || unpublish || editBenefit || /삭제|지워|없애|혜택|할인|장수|발행/u.test(text))) {
    return refuse(restriction, widgetRef(statusFeature, 'active'));
  }
  if (coupon && endEarly && !readWords.test(text)) return statusAction(text, snapshot, locale, 'coupon.endEarly');
  if (unpublish && (coupon || /플레이스|소식/u.test(text))) return unpublishAction(text, snapshot, locale);
  if (coupon && editBenefit && !createsExpiry) return statusAction(text, snapshot, locale, 'coupon.update');
  if ((coupon || /또\s*일주일|한\s*번\s*더\s*연장|중지한.*다시/u.test(text)) && (extension || pause || resume)) {
    return statusAction(text, snapshot, locale, extension ? 'coupon.extend' : pause ? 'coupon.pause' : 'coupon.resume');
  }
  if (coupon && /보낸.*진행\s*중|보낸.*현황.*진행/u.test(text)) return read(slotFeature, ['slot.sent.count', 'slot.sent.row', 'slot.status.active']);
  if (reminderWords.test(text) && (coupon || /끝나기\s*전/u.test(text)) && !openWords.test(text)
    && (sendWords.test(text) || /문자로|문자\s*돌려|쏴/u.test(text))) {
    if (scheduleWords.test(text) || /내일|모레/u.test(text)) return refuse(w.l(
      '종료 알림은 예약할 수 없어요', 'Expiration reminders can only be sent now.',
      '到期提醒只能立即发送。', '到期提醒只能立即傳送。'), widgetRef(statusFeature, 'reminder'));
    return statusAction(text, snapshot, locale, 'coupon.notifyEnding');
  }
  if (expiry) {
    const m = model(snapshot, expiryFeature);
    const item = expiryItem(text, m, w);
    const rate = parseRate(text);
    if (createsExpiry) {
      if (/또|한\s*번\s*더|하나\s*더/u.test(text) && m?.created.length) return answer(w.t('data.marketing.error.expiryAlreadyMade'));
      if (rate !== undefined && (!isRate(rate) || rate === 0)) return answer(w.t('data.marketing.error.percentRange'));
      if (!item) return refuse(m?.items.length ? w.l('이 품목은 오늘 소진 대상에 없어요', 'This item is absent from today’s sell-today list.',
        '此商品不在当天售完清单中。', '此商品不在當天售完清單中。') : w.t('data.marketing.error.noExpiryStock'),
        widgetRef(expiryFeature, 'create'), 'invalid_target');
      if (item.handled) return answer(w.t('data.marketing.error.expiryAlreadyMade'));
      const benefit = expiryBenefit(text, rate);
      if (/문자|sms|短信|簡訊/iu.test(text) || directPublish.test(text) || markWords.test(text)
        || bundledItems.test(text) || /세트/u.test(text) && benefit?.kind !== 'setPrice') {
        return refuse(w.l('당일 소진 쿠폰에서 내용을 확인하고 만들어 주세요', 'Review and create the coupon in the sell-today widget.',
          '请在当天售完组件中确认并创建。', '請在當日售完元件中確認並建立。'),
          widgetRef(expiryFeature, 'create', item.itemId, rate ? { rate } : undefined));
      }
      if (!benefit) return clarify('benefit', w.l('할인율, 할인 금액, 또는 지정 가격을 알려 주세요', 'Enter a discount rate, discount amount, or set price.',
        '请输入折扣率、优惠金额或指定价格。', '請輸入折扣率、優惠金額或指定價格。'));
      const problem = benefitProblem(benefit, item.price, item.unitCost);
      if (problem) return answer(w.t(`data.marketing.error.${problem === 'kind' ? 'benefitInvalid' : problem}`));
      return propose('coupon.createExpiry', 'stock', 'itemId', w.t(item.nameKey), locale,
        { benefit: { kind: benefit.kind, value: ref('benefitValue') }, route: 'place_news' }, { benefitValue: benefit.value });
    }
    if (/세트/u.test(text) && expireCalc.test(text)) return answer(w.l('묶음 판매 계산은 제공되지 않아요', 'Bundle pricing is unavailable.', '暂不提供组合售价计算。', '暫不提供組合售價計算。'));
    if (rate !== undefined && isRate(rate)) {
      if (!item) return answer(w.t('data.marketing.error.noExpiryStock'));
      return { intent: { kind: 'read', tool: 'calc_expiry_discount' },
        slots: { itemQuery: w.t(item.nameKey), rate },
        reading: { tool: 'calc_expiry_discount', args: { itemId: { handle: 'pending' }, rate: ref('rate') } },
        lookups: [{ kind: 'stock', querySlot: 'itemQuery', readingBind: ['itemId'] }],
        onMissing: { answer: w.t('data.marketing.error.noExpiryStock') } };
    }
    return read(expiryFeature, ['expiry.item.qty', 'expiry.discount.each', 'expiry.discount.total', 'expiry.discount.discard', 'expiry.discount.max'],
      w.t('data.marketing.error.noExpiryStock'));
  }
  if (/밤|저녁\s*늦/u.test(text) && /돼|되나|되는/u.test(text)) return read(slotFeature, ['slot.send.rule'], sendRule(w));
  if ((coupon || slotContext) && sendWords.test(text) && !openWords.test(text) &&
      (slotContext || /쿠폰\s*보내기|쿠폰\s*지금\s*보내/u.test(text))) return slotSend(text, snapshot, locale);
  if (coupon && !readWords.test(text) && (modifyExpiry.test(text) || sendWords.test(text))) {
    return refuse(restriction, widgetRef(slotFeature, 'send'));
  }
  if (/예상\s*손님|\d+시.*\d+시|시간별로\s*손님/u.test(text)) {
    const daily = readDemand(snapshot);
    const iso = parseNavisDate(text, businessDay(snapshot));
    const date = iso ?? daily.day.date;
    const hours = [...text.matchAll(/(\d{1,2})\s*시/gu)].map(match => Number(match[1]));
    const selected = daily.hourly.find(row => row.date === date)?.hours.filter(row =>
      hours.length ? hours.includes(row.hour) : !/오전/u.test(text) || row.hour < 12) ?? [];
    return read(slotFeature, selected.map(row => `slot.hour.${date}.${row.hour}`), w.t('common.navis.noData'));
  }
  if (slotContext || /보낼\s*손님\s*명단|문자\s*내용\s*알려|손님한테\s*나가는\s*문자/u.test(text)) {
    if (/단골.*(?:누구|몇\s*명|이름|명단|\?)|(?:보낼|받을)\s*손님.*(?:누구|명단)/u.test(text)) {
      return { intent: { kind: 'read', recordKind: 'slot', querySlot: 'slotQuery' }, browse: true,
        slots: { slotQuery: weekdayWords.test(text) ? text : '*' },
        onMissing: { answer: w.t('data.marketing.error.noRecipients') } };
    }
    if (/샷.*이득|추천.*이유|왜.*추천/u.test(text)) return read(slotFeature, ['slot.benefit.basis', 'slot.benefit.kept']);
    if (/문자.*(?:내용|뭐라고|뭐예요)/u.test(text)) return read(slotFeature, ['slot.message']);
    if (/보낸|사용\s*현황|얼마나\s*썼/u.test(text) && !statusText.test(text)) {
      return read(slotFeature, ['slot.sent.count', 'slot.sent.row']);
    }
    if (/다음\s*주|담주/u.test(text) && weekdayWords.test(text) && openWords.test(text)) {
      return clarify('slotId', w.t('data.marketing.error.slotRequired'));
    }
    if ((coupon || slotWord.test(text)) && (readWords.test(text) || openWords.test(text))) {
      const m = model(snapshot, slotFeature), matching = m && weekdayWords.test(text) ? slotMatches(text, snapshot, m.slots) : [];
      if (matching.length === 1 && matching[0].handled) return read(slotFeature, ['slot.sent.row']);
      if (/보낸/u.test(text)) return read(slotFeature, ['slot.sent.count', 'slot.sent.row']);
      if (!statusText.test(text)) return read(slotFeature, ['slot.quietHours.count', 'slot.regulars.count', 'slot.row']);
    }
  }
  if (coupon || statusText.test(text) && /멈춰둔|중지된/u.test(text)) {
    const rows = statusRows(snapshot), targets = namedCoupons(text, rows, w);
    if (/지난\s*달|저번\s*달/u.test(text)) return { intent: { kind: 'read', featureId: 'marketing-performance',
      condition: { kind: 'dateRange', start: LAST_MONTH_START, end: LAST_MONTH_END } }, factKeys: ['perf.rate', 'perf.used'] };
    if (/이익/u.test(text)) return read(statusFeature, ['coupons.used.month', 'coupons.performance.profit']);
    if (/성과/u.test(text) && /같이|둘|한\s*번에|하고|랑/u.test(text)) return read(statusFeature, ['coupons.active', 'coupons.performance.rate']);
    if (/사용률\s*(?:순위|제일)|사용률.*높|가장.*잘/u.test(text)) return read(statusFeature, ['coupons.rank']);
    if (/대시보드|보드에서|(?:위젯|패널).*어디/u.test(text)) {
      const index = run?.boards.marketing.pages.findIndex(page => page.panels.some(panel => panel.featureId === statusFeature)) ?? -1;
      if (index >= 0) return answer(w.l(`마케팅 보드 ${index + 1}페이지에 있어요`, `On marketing board page ${index + 1}.`,
        `位于营销看板第 ${index + 1} 页。`, `位於行銷看板第 ${index + 1} 頁。`));
      if (run) return answer(w.l('마케팅 보드에 이 위젯이 놓여 있지 않아요', 'This widget is absent from the marketing board.',
        '营销看板上没有此组件。', '行銷看板上沒有此元件。'));
    }
    if (!targets.length && openWords.test(text) && couponAliases.some(alias => alias.test(text))) return answer(w.l(
      '해당 쿠폰을 찾을 수 없어요', 'No matching coupon was found.', '找不到对应的优惠券。', '找不到對應的優惠券。'));
    if (targets.length === 1) {
      const key = `coupon.${targets[0].couponId}`;
      if (/경로|어디에.*올렸|플레이스|블로그|채널/u.test(text)) return read(statusFeature, [`${key}.route`]);
      if (/혜택|할인액|얼마\s*깎/u.test(text)) return read(statusFeature, [`${key}.benefit`]);
      if (/언제|며칠|종료일/u.test(text)) return read(statusFeature, [`${key}.end`]);
    }
    if (/곧\s*끝|임박|끝나가|문제|챙길|신경/u.test(text)) return read(statusFeature, ['coupons.endingSoon', 'coupons.ending.row']);
    if (/끝난|종료된/u.test(text)) return read(statusFeature, ['coupons.ended.row']);
    if (/일시\s*중지|중지된|멈춰둔/u.test(text)) return read(statusFeature,
      ['coupons.paused', ...rows.filter(row => row.status === 'paused').map(row => `coupon.${row.couponId}.row`)]);
    if (readWords.test(text)) return read(statusFeature, ['coupons.active', 'coupons.used.month', ...targets.map(row => `coupon.${row.couponId}.row`)]);
  }
}

function navigation(raw: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | null | undefined {
  const text = normalizeNavisInput(raw), w = words(locale);
  const coupon = couponWord.test(text), expiry = namesExpiry(text, coupon) || /할인율.*세팅|퍼센트로\s*준비/u.test(text);
  if (/기능\s*(?:목록|찾기|서랍)|위젯\s*검색/u.test(text)) return;
  const slotDraft = coupon && (slotWord.test(text) || /발송\s*(?:창|화면)|보내는\s*화면|보낼\s*준비|[월화수목금토일](?:요일|욜).*준비/u.test(text))
    || /혜택.*준비|할인으로\s*(?:맞춰|세팅)|(?:김|이|박|최|정)(?:씨|○○).*빼|(?:문구|문자\s*내용).*(?:고쳐|바꿔서|수정).*?(?:열어|세팅|준비)|예약.*(?:준비|세팅|맞춰|보내게)/u.test(text);
  if (coupon && /대시보드|보드|패널|위젯\s*위치|추가/u.test(text) && !/샷\s*추가/u.test(text)) return;
  if (coupon && /지금\s*칸|쿠폰\s*보내기\s*버튼/u.test(text)) {
    if (model(snapshot, slotFeature)) return { args: { featureId: slotFeature, view: 'send', focus: 'action' } };
    return null;
  }
  if (expiry && prepareWords.test(text) && !sendWords.test(text) && !modifyExpiry.test(text)) {
    const m = model(snapshot, expiryFeature);
    const item = expiryItem(text, m, w), rate = parseRate(text);
    const itemId = item?.itemId;
    const valid = rate !== undefined && rate >= 1 && rate <= (item?.maxSliderRate ?? 100);
    return { args: { featureId: expiryFeature, view: 'create', focus: 'action',
      ...(itemId && { itemId }), ...(valid && { prefill: { rate } }) },
    ...(itemId && { target: { kind: 'stock', id: itemId } }) };
  }
  if (reminderWords.test(text) && prepareWords.test(text) && (coupon || /끝나기\s*전/u.test(text))) {
    const rows = statusRows(snapshot), named = namedCoupons(text, rows, w);
    const itemId = named.length === 1 ? named[0].couponId : undefined;
    return { args: { featureId: statusFeature, view: 'reminder', focus: 'action', ...(itemId && { itemId }) },
      ...(itemId && { target: { kind: 'coupon', id: itemId } }) };
  }
  if (slotDraft && prepareWords.test(text) && !unsafeConsent.test(text) && !contactExport.test(text)
    && !/발송해\s*줘|보내\s*줘/u.test(text)) {
    const m = model(snapshot, slotFeature);
    const scheduled = scheduleWords.test(text), named = !scheduled && weekdayWords.test(text) && !draftBody(text);
    const matching = named && m ? slotMatches(text, snapshot, m.slots) : [];
    if (named && (matching.length !== 1 || matching[0].handled)) return null;
    const picked = named ? matching[0] : m && defaultSlot(m);
    const benefit = slotBenefit(text), messageText = draftBody(raw);
    const sendTime = scheduled ? scheduleTime(text, snapshot) : undefined;
    const family = /([가-힣])(?:씨|○○)/u.exec(text)?.[1];
    const subset = family && m && picked ? eligible(m, picked.slotId).filter(row => w.dt(row.name).startsWith(family)) : [];
    const prefill = { ...(named && picked && { slotId: picked.slotId }), ...(benefit && { benefit }),
      ...(isText(messageText) && { messageText }), ...(sendTime && { sendMode: 'schedule', sendTime }),
      ...(subset.length === 1 && { excludeRecipients: [subset[0].customerId] }) } satisfies AgentWireArgs;
    return { args: { featureId: slotFeature, view: 'send', focus: 'action', ...(Object.keys(prefill).length && { prefill }) } };
  }
  if (coupon && openWords.test(text) && !/보내|발송|만들|중지|멈춰|늘려|연장|삭제|지워|사용률|두\s*개|둘\s*다|같이|한\s*번에/u.test(text)) {
    const matches = namedCoupons(text, statusRows(snapshot), w);
    const itemId = matches.length === 1 ? matches[0].couponId : undefined;
    const ended = /끝난|종료된/u.test(text) || matches[0]?.status === 'ended';
    if (itemId || ended) return { args: { featureId: statusFeature, view: ended ? 'ended' : 'active', ...(itemId && { itemId, focus: 'action' }) },
      ...(itemId && { target: { kind: 'coupon', id: itemId } }) };
    if (couponAliases.some(alias => alias.test(text))) return null;
  }
  if (coupon && (sendWords.test(text) || expiry
    || /기간|정지|연장|멈춰|다시\s*켜|종료시켜|지난\s*달|저번\s*달|성과.*같이/u.test(text))) return null;
}

function handoff(command: string, args: Readonly<Record<string, unknown>>): DetailRef | undefined {
  if (command === 'coupon.createExpiry') {
    const { itemId, discountRate, route } = args;
    const target = widgetRef(expiryFeature, 'create', typeof itemId === 'string' ? itemId : undefined);
    const fields = { ...(typeof discountRate === 'number' && { rate: discountRate }) };
    if (!validateAgentPrefill(expiryFeature, fields)) return target;
    return { ...target, prefill: { kind: 'widget-draft', command, fields: {
      ...fields, ...(route === 'place_news' && { route }),
    } } };
  }
  if (command === 'coupon.sendSlot') {
    const { slotId, benefitId, body, sendAt } = args;
    return widgetRef(slotFeature, 'send', typeof slotId === 'string' ? slotId : undefined,
      { ...(isBenefit(benefitId) && { benefit: benefitId }), ...(isText(body) && { messageText: body }),
        ...(isStamp(sendAt) && { sendMode: 'schedule', sendTime: sendAt.slice(11) }) });
  }
  if (command === 'ui.setDraftField' && args.featureId === statusFeature && args.view === 'reminder'
    && args.field === 'couponId' && typeof args.value === 'string') return widgetRef(statusFeature, 'reminder', args.value);
  if (command === 'coupon.notifyEnding') return widgetRef(statusFeature, 'reminder', typeof args.couponId === 'string' ? args.couponId : undefined);
  if (command === 'coupon.markPosted') return widgetRef(expiryFeature, 'create');
}

/**
 * D-326 Q19: the stock lookup also says whether today's sell-today coupon can be made for the item and whether it already was.
 * The registry composes this onto the inventory domain; the item rows themselves stay the inventory reader's.
 */
export function withExpiryStock(inventory: DomainAdapter): DomainAdapter {
  return { ...inventory, reads: inventory.reads.map(reader => reader.kind !== 'stock' ? reader : {
    ...reader,
    search(input) {
      const items = model(input.snapshot, expiryFeature)?.items ?? [];
      return reader.search(input).map(match => {
        const id = reader.resolve?.(input, match.handle), item = items.find(row => row.itemId === id);
        return { ...match, fields: { ...match.fields, expiryEligible: !!item && !item.handled, expiryHandled: !!item?.handled } };
      });
    },
  }) };
}

export const couponsDomain: DomainAdapter = {
  featureIds: [slotFeature, expiryFeature, statusFeature],
  commands: [lifecycle('coupon.pause'), lifecycle('coupon.resume'), lifecycle('coupon.extend'),
    ...(['coupon.update', 'coupon.endEarly', 'coupon.unpublish'] as const).map(editing)],
  runCommands: [outbound('coupon.sendSlot'), outbound('coupon.notifyEnding'), outbound('coupon.markPosted'), createExpiry],
  reads: [couponReader, codeReader, slotReader],
  tools: [calcTool],
  projectWidget, route, navigation, handoff,
  routePresentation(text, snapshot, locale, run) {
    // Marketing can have both a notice composer and a coupon sender. Unqualified
    // one-time scheduling refers to the slot form only on this board.
    if (run?.layer !== 'marketing' || /공지|예약\s*손님|예약\s*확정/u.test(text)) return;
    // D-326 Q19: taking a posted Place News coupon down is explicit; the performance and promotion reads must not catch it.
    const phrase = normalizeNavisInput(text);
    if (unpublishWords.test(phrase) && couponWord.test(phrase) && !readWords.test(phrase) && !bulk.test(phrase)) return unpublishAction(phrase, snapshot, locale);
    if (/지금\s*(?:칸|할)\s*홍보.*(?:처리|대신)/u.test(text)) {
      const view = selectWidget(snapshot, 'marketing-today', defaultCondition, 'normal');
      const cell = view.status === 'ready' ? view.model.cells.find(row => row.slot === 'now') : undefined;
      if (cell?.kind === 'quiet-hours') return slotSend(text, snapshot, locale, cell.quietSlot.slotId);
    }
    const timingQuestion = /밤|저녁\s*늦/u.test(text) && /돼|되나|되는/u.test(text);
    if (timingQuestion && /쿠폰|예약\s*발송|보내/u.test(text)) return read(slotFeature, ['slot.send.rule'], sendRule(words(locale)));
    if (/쿠폰.*단골.*누구|보낼\s*손님\s*명단|단골\s*이름|샷.*(?:이득|추천)|추천\s*이유|예상\s*손님|\d+시.*\d+시.*몇\s*명|시간별로\s*손님/u.test(text)) {
      return route(text, snapshot, locale, run);
    }
    if (!reminderWords.test(text) && scheduleWords.test(text) && /발송|쿠폰\s*문자/u.test(text) && sendWords.test(text) && !openWords.test(text)) {
      return slotSend(text, snapshot, locale);
    }
  },
};
