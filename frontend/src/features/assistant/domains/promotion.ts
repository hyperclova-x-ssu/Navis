/**
 * N18 promotion adapter: promo video, customer groups, marketing performance and today's promotion.
 *
 * Every number and sentence comes from the four widgets' selectors and their own message bundles. Chat never writes:
 * the owner's card press runs exactly the widget's own command, including the promo session's start and retry.
 */
import type { DetailRef, FeatureId, Locale, QueryCondition } from '../../../contracts';
import type { DataCommandResult } from '../../../data/commands/types';
import { TODAY } from '../../../data/db/time';
import type { DataSnapshot, DataText } from '../../../data/db/types';
import { failure } from '../../../data/reality/00';
import { saveDraftCommand } from '../../../data/reality/16/commands';
import { openDraft } from '../../../data/reality/16/dto';
import { CONCEPTS, LENGTHS, MOODS, REFERENCE_IDS } from '../../../data/marketing/derive';
import { MIN_PROMO_PHOTOS } from '../../../data/marketing/calc';
import { previewReachOut, previewVideoMake, previewVideoMarkPosted } from '../../../data/marketing/commands';
import type {
  CouponRoute, MarketingCommand, MarketingModelMap, PromoMenuModel, PromoReferenceId,
  PromoVideoInput, PromoVideoRowModel, VideoConcept, VideoMood, VideoPostRoute,
} from '../../../data/marketing/types';
import { dataBundles, resolveDataText, selectWidget, type WidgetDataStore } from '../../../data/widget-data';
import { baseBundles, createTranslator, type MessageBundle, type Translator } from '../../../i18n';
import {
  validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill, type AgentFact, type AgentRecordMatch, type AgentWireArgs,
} from '../../../../shared/navis-agent-schema.mjs';
import { couponChatCopy } from './coupons.messages';
import { mktCouponBundle } from '../../widgets/mkt-coupon/messages';
import { mktLocalBundle } from '../../widgets/mkt-local/messages';
import { cellText } from '../../widgets/mkt-promo/marketing-today';
import { lookupEstimate, estimateCostText, estimateTimeText, roundEstimateSeconds } from '../../widgets/mkt-promo/promo-format';
import { mktPromoBundle } from '../../widgets/mkt-promo/messages';
import { EMPTY_DRAFT, inputOfDraft, offlinePromoRetry, peekPromoSession, promoSession, type PromoDraft } from '../../widgets/mkt-promo/promo-session';
import { normalizeNavisInput, normalizeNavisName, parseNavisNumber } from '../navis-input';
import { matchWidget } from '../question';
import type {
  DomainAdapter, DomainDetail, DomainRoute, DomainTurnInput, LocalSlots, ReadToolAdapter, RecordAdapter, RecordSearch,
  RecordTargets, RunActionOutcome, RunCommandAdapter,
} from './registry';

const promoFeature = 'promo-video';
const groupsFeature = 'customer-groups';
const todayFeature = 'marketing-today';
type PromotionFeature = typeof promoFeature | typeof groupsFeature | typeof todayFeature | 'coupon-status';
const defaultCondition = { kind: 'default' } as const;
/** The data command's own memo limit (DATA_MODEL 10.16.9). */
const MEMO_LIMIT = 100;
const ref = (slot: string) => ({ slot });
const asLocale = (value: unknown): Locale => value === 'en' || value === 'zh-Hans' || value === 'zh-Hant' ? value : 'ko';
const isStrings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const isMemo = (value: unknown): value is string => typeof value === 'string' && Array.from(value).length <= MEMO_LIMIT;
const memoLength = (value: string) => Array.from(value).length;

/* ───────────── words: the widgets' own bundles ───────────── */
const translators = new Map<Locale, Translator>();
function translator(locale: Locale): Translator {
  let t = translators.get(locale);
  if (!t) {
    t = createTranslator(locale, ...baseBundles, mktPromoBundle, mktCouponBundle as unknown as MessageBundle<string>, mktLocalBundle as unknown as MessageBundle<string>, ...dataBundles) as unknown as Translator;
    translators.set(locale, t);
  }
  return t;
}
function words(locale: Locale) {
  const tr = translator(locale);
  const { format: f, t } = tr;
  const l = (ko: string, en: string, hans: string, hant: string) => ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];
  const dt = (value: DataText) => resolveDataText(t, value);
  const count = (n: number) => l(`${n}장`, String(n), `${n} 张`, `${n} 張`);
  return { tr, f, t, l, dt, count, people: (n: number) => f.count(n, 'person'), money: (n: number) => f.money(n, 'full'),
    dash: '—' };
}
type Words = ReturnType<typeof words>;

function referenceName(id: string, w: Words) {
  return w.t(`promo.ref.${id}.name`);
}

function fact(key: string, label: string, value: number | string, display = String(value), unit = 'text', date?: string): AgentFact {
  // The grounded answer reads "{label} {display}"; a display that starts with its own label would say it twice.
  const shown = display.startsWith(label) && display.length > label.length ? display.slice(label.length).replace(/^[\s·:,]+/u, '') : display;
  return { key, label: label.slice(0, 120), value: typeof value === 'string' ? value.slice(0, 500) : value,
    display: shown.slice(0, 500), unit, ...(date ? { date } : {}) };
}

/* ───────────── models and the owner's own draft ───────────── */
type ModelByFeature = MarketingModelMap & { 'ai-response': { readonly waitingCount: number } };
function model<F extends PromotionFeature | 'ai-response'>(snapshot: DataSnapshot, feature: F, condition: QueryCondition = defaultCondition): ModelByFeature[F] | undefined {
  const view = selectWidget(snapshot, feature, condition, 'normal');
  return view.status === 'ready' ? view.model as unknown as ModelByFeature[F] : undefined;
}
const promoModel = (snapshot: DataSnapshot) => model(snapshot, promoFeature);
const groupsModel = (snapshot: DataSnapshot) => model(snapshot, groupsFeature);
const sessionOf = (snapshot: DataSnapshot) => peekPromoSession(snapshot.runId ?? 'run');
const draftOf = (snapshot: DataSnapshot): PromoDraft => sessionOf(snapshot)?.getState().draft
  ?? { ...EMPTY_DRAFT, ...openDraft(snapshot.tables.realPromo)?.input };
const isMaking = (snapshot: DataSnapshot) => snapshot.tables.marketing.promoVideo.some(video => video.status === 'making');

const stageKey = (stage: string | null) => `promo.stage.${stage ?? 'look'}`;
const latest = (rows: readonly PromoVideoRowModel[], status: PromoVideoRowModel['status']) => rows.filter(row => row.status === status).at(-1);

/* ───────────── facts ───────────── */
function estimateFacts(snapshot: DataSnapshot, w: Words) {
  const state = sessionOf(snapshot)?.getState();
  if (state?.estimate.status !== 'ready' || state.draft.photoIds.length < MIN_PROMO_PHOTOS) return [];
  const photos = state.draft.photoIds.length;
  return LENGTHS.flatMap(length => {
    const cell = lookupEstimate(state.estimate.value, length, photos);
    if (!cell) return [];
    return [fact(`video.estimate.${length}`, w.t('promo.len.sec', { n: length }), cell.seconds,
      [w.t('promo.len.sec', { n: length }), w.t('promo.sum.photoN', { n: photos }),
        w.t('promo.est.time', { t: estimateTimeText(w.tr, cell.seconds) }), w.t('promo.est.cost', { c: estimateCostText(w.tr, cell.costKrw) }),
        w.t('promo.est.costNote')].join(' · '), 'seconds')];
  });
}

function promoFacts(snapshot: DataSnapshot, w: Words) {
  const view = selectWidget(snapshot, promoFeature, defaultCondition, 'normal');
  if (view.status !== 'ready') {
    return { facts: [fact('video.state', w.l('영상', 'Video', '视频', '影片'), 'few-photos', w.t(view.messageKey))] };
  }
  const m = view.model;
  const current = m.current;
  const place = (route: VideoPostRoute | 'place-news' | null) => route === 'place-news'
    ? w.t('data.marketing.route.placeNews') : w.t(`promo.place.${route ?? 'clip'}`);
  const state = m.state === 'before' || m.state === 'few-photos' ? w.t('widget.promo-video.materials.sr', { n: m.materialsCount })
    : m.state === 'making' ? w.t('widget.promo-video.making') : m.state === 'done' ? w.t('widget.promo-video.done')
      : m.state === 'failed' ? w.t('widget.promo-video.failed')
        : w.t('promo.posted.line', { n: m.postedCount, place: place(m.lastPublication?.channel ?? m.lastPostedRoute) });
  const withPhotos = m.menus.filter(menu => menu.hasPhotos);
  const references = REFERENCE_IDS.map((id, index) => fact('video.reference.row', w.t('promo.sum.ref'), id,
    `${index + 1}. ${referenceName(id, w)}`));
  return { facts: [
    fact('video.materials', w.t('widget.promo-video.materials.label'), m.materialsCount, w.t('widget.promo-video.materials.sr', { n: m.materialsCount }), 'count'),
    fact('video.canMake', w.t('marketing.makeVideo'), m.canMake ? 1 : 0, m.canMake
      ? w.l(`사진 ${m.photoCount}장이 모였어요. 사진 ${m.minPhotos}장부터 영상을 만들 수 있어요`,
        `${m.photoCount} photos are ready. A video needs at least ${m.minPhotos}.`,
        `已有 ${m.photoCount} 张照片。至少需要 ${m.minPhotos} 张才能制作视频。`, `已有 ${m.photoCount} 張照片。至少需要 ${m.minPhotos} 張才能製作影片。`)
      : w.t('data.state.promo-video.few-photos')),
    fact('video.state', w.l('영상', 'Video', '视频', '影片'), m.state, state),
    ...(current && m.state === 'making' ? [
      fact('video.current.stage', w.t('widget.promo-video.making'), current.stage ?? 'look',
        `${w.t('widget.promo-video.making')} · ${w.t(stageKey(current.stage))} · ${w.t('widget.promo-video.bar', { n: (current.stage ? ['look', 'story', 'scenes', 'merge'].indexOf(current.stage) : 0) + 1 })}`),
      fact('video.current.meta', w.t('widget.promo-video.making'), current.lengthSec, w.t('widget.promo-video.makingMeta', { s: current.lengthSec, n: current.photoCount }), 'seconds'),
    ] : []),
    ...(current?.failReason ? [fact('video.current.fail', w.t('promo.fail.title'), current.failReason, `${w.t('promo.fail.title')} · ${w.t(`promo.fail.${current.failReason}`)}`)] : []),
    fact('video.posted.count', w.t('widget.promo-video.postedLabel'), m.postedCount,
      `${w.t('widget.promo-video.postedLabel')} ${m.postedCount}${w.t('widget.promo-video.postedUnit')}`, 'count'),
    ...(m.lastPostedRoute ? [fact('video.posted.last', w.t('widget.promo-video.postedLabel'), m.lastPostedRoute,
      `${w.t('widget.promo-video.postedTo', { place: place(m.lastPostedRoute) })} · ${m.postedCount}${w.t('widget.promo-video.postedUnit')}`)] : []),
    fact('video.menu.withPhotos', w.l('사진이 있는 메뉴', 'Menus with photos', '有照片的菜品', '有照片的品項'), withPhotos.length,
      w.l(`${withPhotos.length}개`, String(withPhotos.length), `${withPhotos.length} 个`, `${withPhotos.length} 個`), 'count'),
    ...withPhotos.slice(0, 10).map(menu => fact('video.menu.row', w.dt(menu.name), menu.photos.length, `${w.dt(menu.name)} · ${w.t('promo.menu.photos', { n: menu.photos.length })}`, 'count')),
    ...references,
    ...estimateFacts(snapshot, w),
  ].slice(0, 128) };
}

const consentLabel = (w: Words, consent: boolean) => w.t(consent ? 'widget.customer-groups.consentYes' : 'widget.customer-groups.consentNo');
function groupsFacts(snapshot: DataSnapshot, w: Words) {
  const m = groupsModel(snapshot);
  if (!m) {
    const view = selectWidget(snapshot, groupsFeature, defaultCondition, 'normal');
    return view.status === 'ready' ? { status: 'missing' as const } : { facts: [fact('groups.state', w.t('widget.customer-groups.title'), 'empty', w.t(view.messageKey))] };
  }
  const customer = (c: MarketingModelMap['customer-groups']['churnRisk'][number]) =>
    `${w.dt(c.name)} · ${w.t('widget.customer-groups.lastVisit', { date: w.f.date(c.lastVisit, 'short') })} · ${w.l(`${c.daysSinceLast}일`, `${c.daysSinceLast} days`, `${c.daysSinceLast} 天`, `${c.daysSinceLast} 天`)} · ${consentLabel(w, c.consentSms)}`;
  const byAge = [...m.churnRisk].sort((a, b) => a.lastVisit.localeCompare(b.lastVisit));
  const blocked = m.churnRisk.filter(c => !c.selectable);
  const sent = m.sent;
  return { facts: [
    ...m.groups.map(g => fact(`groups.count.${g.id}`, w.t(g.nameKey), g.count, w.t('widget.customer-groups.groupLine', { group: w.t(g.nameKey), n: w.people(g.count) }), 'person', TODAY)),
    fact('groups.churn.count', w.t('data.marketing.group.churnRisk'), m.counts['churn-risk'], w.people(m.counts['churn-risk']), 'person', TODAY),
    ...(byAge[0] ? [fact('groups.churn.oldest', w.t('data.marketing.group.churnRisk'), byAge[0].daysSinceLast, customer(byAge[0]), 'day', byAge[0].lastVisit)] : []),
    ...byAge.slice(0, 12).map(c => fact('groups.churn.row', w.dt(c.name), c.daysSinceLast, customer(c), 'day', c.lastVisit)),
    fact('groups.consent.blocked', w.t('widget.customer-groups.consentNo'), blocked.length,
      [w.people(blocked.length), ...blocked.slice(0, 8).map(c => w.dt(c.name))].join(' · '), 'person'),
    ...(['churn-risk', 'first-visit', 'regular'] as const).map(id => fact(`groups.rule.${id}`, w.t(m.groups.find(g => g.id === id)?.nameKey ?? 'data.marketing.group.churnRisk'),
      id === 'regular' ? m.rule.regularDays : m.rule.churnGapDays,
      w.t(`widget.customer-groups.basis.${id}`, { days: id === 'regular' ? m.rule.regularDays : m.rule.churnGapDays, n: m.rule.regularVisits }))),
    fact('groups.basis', w.t('widget.customer-groups.groupsLabel'), m.basisKey, w.t(m.basisKey)),
    fact('groups.reachOut.eligibleCount', w.t('marketing.reachOutToThese'), m.reachOut.count, w.people(m.reachOut.count), 'person'),
    fact('groups.reachOut.history', w.t('widget.customer-groups.sentTitle'), sent.length, sent.length
      ? sent.map(row => `${w.dt(row.name)} · ${w.t('widget.slot-coupon.sentLine', { name: w.dt(row.name), used: row.used ?? 0, issued: row.issued, left: w.t('widget.coupon-status.daysLeft', { n: row.daysLeft }) })}`).join(' / ')
      : w.l('챙기기로 보낸 쿠폰이 아직 없어요', 'No coupon has been sent from this screen yet.', '尚未通过此功能发送过优惠券。', '尚未透過此功能傳送過優惠券。'), 'count'),
  ].slice(0, 128) };
}

function todayFacts(snapshot: DataSnapshot, w: Words) {
  const view = selectWidget(snapshot, todayFeature, defaultCondition, 'normal');
  const replies = snapshot.tables.realGroups && !snapshot.tables.realInbox ? undefined : model(snapshot, 'ai-response');
  if (view.status !== 'ready') {
    const display = w.t(view.messageKey);
    return { facts: [fact('today.none', display,
      snapshot.tables.realGroups && view.messageKey.includes('unavailable') ? 'unavailable' : 0, display)] };
  }
  const m = view.model;
  const visible = m.cells.filter(cell => cell.kind !== 'quiet-hours' || cell.params.regulars > 0);
  const repliesCell = visible.find(cell => cell.kind === 'replies');
  const empty = w.t('data.state.marketing-today.none');
  return { facts: [
    ...visible.map(cell => {
      const display = cellText(w.tr, cell).first;
      return fact(`today.cell.${cell.kind}`, display,
        cell.kind === 'quiet-hours' ? cell.params.regulars : cell.kind === 'video' ? cell.params.photos : cell.params.count, display, 'count');
    }),
    ...(visible.length ? [] : [fact('today.none', empty, 0, empty)]),
    fact('today.cells.count', w.t('widget.marketing-today.title'), visible.length,
      visible.length ? w.l(`${visible.length}가지가 있어요`, `${visible.length} to do`, `有 ${visible.length} 项待办`, `有 ${visible.length} 項待辦`) : w.t('widget.marketing-today.sr.nothing'), 'count', TODAY),
    ...(m.missing ?? []).map(source => fact(`today.missing.${source}`, w.t('widget.marketing-today.title'), 'unavailable', w.t(`data.real.groups.today.missing.${source}`))),
    ...(replies && !m.missing?.includes('replies') ? [{ ...fact('today.replies.compare', w.t('widget.ai-response.waiting'), replies.waitingCount,
      repliesCell?.kind === 'replies'
        ? `${w.t('widget.ai-response.title')} ${w.count(replies.waitingCount).replace('장', '건')} · ${w.t('widget.marketing-today.title')} ${w.count(repliesCell.params.count).replace('장', '건')} · ${replies.waitingCount === repliesCell.params.count ? w.l('같아요', 'They match', '一致', '一致') : w.l('달라요', 'They differ', '不一致', '不一致')}`
        : `${w.t('widget.ai-response.title')} ${w.count(replies.waitingCount).replace('장', '건')} · ${w.t('widget.marketing-today.title')} ${w.l('0건', '0', '0 条', '0 則')}`,
      'count'), source: 'ai-response' }] : []),
  ].slice(0, 128) };
}

function projectWidget(snapshot: DataSnapshot, feature: FeatureId, condition: QueryCondition, locale: Locale) {
  if (feature !== promoFeature && feature !== groupsFeature && feature !== todayFeature) return undefined;
  const w = words(locale);
  if (condition.kind !== 'default') return { status: 'unsupported_period' as const };
  if (feature === promoFeature) return promoFacts(snapshot, w);
  if (feature === groupsFeature) return groupsFacts(snapshot, w);
  return todayFacts(snapshot, w);
}

/* ───────────── records the owner can point at ───────────── */
function videoRows(snapshot: DataSnapshot) {
  return promoModel(snapshot)?.videos ?? [];
}
const videoReader: RecordAdapter = {
  kind: 'promoVideo',
  search({ snapshot, locale, query, privateLookup }: RecordSearch): readonly AgentRecordMatch[] {
    const w = words(locale);
    return videoRows(snapshot).filter(row => query === '*' || row.videoId === query).slice(0, 5).map((row, index) => ({
      handle: `n18-promoVideo-${index + 1}`, match: 'exact' as const,
      fields: { date: row.createdAt.slice(0, 10), status: row.status },
      ...(!privateLookup ? { label: `${w.t('widget.promo-video.title')} · ${w.t('promo.done.meta', { s: row.lengthSec, n: row.photoCount })}`.slice(0, 180) } : {}),
    }));
  },
  resolve: (input, handle) => videoRows(input.snapshot).filter(row => input.query === '*' || row.videoId === input.query)
    .slice(0, 5).find((_, index) => `n18-promoVideo-${index + 1}` === handle)?.videoId,
  describe: match => match.label,
};

const preflightTool: ReadToolAdapter<'get_promotion_preflight'> = {
  tool: 'get_promotion_preflight',
  read(snapshot, args, locale) {
    const w = words(locale);
    if (args.action === 'make') {
      const busy = isMaking(snapshot);
      return { facts: [fact('promo.video.busy', w.t('widget.promo-video.making'), busy ? 1 : 0,
        busy ? w.t('data.marketing.error.busy') : w.l('만드는 중인 영상이 없어요', 'No video is being made.', '没有正在制作的视频。', '沒有正在製作的影片。'), 'count')] };
    }
    const m = groupsModel(snapshot);
    if (!m) return { status: 'missing' };
    return { facts: [fact('groups.reachOut.eligibleCount', w.t('marketing.reachOutToThese'), m.reachOut.count, w.people(m.reachOut.count), 'person')] };
  },
};

/* ───────────── cards: the owner's press runs the widget's own command ───────────── */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Patch = Mutable<Partial<Omit<PromoVideoInput, 'locale'>>>;
type CardDraft = { readonly args: Readonly<Record<string, unknown>>; readonly locale: Locale };
function expand(wire: unknown, slots: LocalSlots, targets: RecordTargets): Record<string, unknown> {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return {};
  return Object.fromEntries(Object.entries(wire).map(([key, value]) => [key,
    value && typeof value === 'object' && 'handle' in value ? targets.get(String(value.handle))?.id
      : value && typeof value === 'object' && 'slot' in value ? slots[String(value.slot)] : value]));
}
function resolveCard(type: string, wire: unknown, slots: LocalSlots, targets: RecordTargets): CardDraft | undefined {
  if (!validateAgentDraft(type, wire)) return undefined;
  const args = expand(wire, slots, targets);
  return validateAgentCommandArgs(type, args) ? { args, locale: asLocale(slots.navisLocale) } : undefined;
}
const moodsOk = (value: unknown): value is readonly VideoMood[] => isStrings(value) && value.every(item => MOODS.some(mood => mood === item));
const conceptsOk = (value: unknown): value is readonly VideoConcept[] => isStrings(value) && value.every(item => CONCEPTS.some(concept => concept === item));
const cardSlots = { menuIds: isStrings, photoIds: isStrings, moods: moodsOk, concepts: conceptsOk, memo: isMemo };
const field = (label: string, before: string, after: string) => ({ label, before, after });
const detail = (label: string, text: string) => field(label, text, text);

function unpostedNote(snapshot: DataSnapshot, w: Words) {
  const n = snapshot.tables.marketing.promoVideo.filter(video => video.status === 'done').length;
  return n > 0 ? w.l(`아직 안 올린 영상이 ${n}개 있어요`, `${n} finished ${n === 1 ? 'video is' : 'videos are'} still unposted.`,
    `还有 ${n} 个视频未发布。`, `還有 ${n} 部影片未發布。`) : undefined;
}

function unpostedFields(snapshot: DataSnapshot, w: Words) {
  const note = unpostedNote(snapshot, w);
  return note ? [detail(w.l('게시', 'Posting', '发布', '發佈'), note)] : [];
}

function applyOutcome(featureId: PromotionFeature, result: DataCommandResult): RunActionOutcome {
  if (!result.ok) return result.reason === 'TRANSACTION_BUSY' || result.messageKey === 'data.marketing.error.busy' ? { kind: 'busy' }
    : result.code === 'CONFLICT' || result.code === 'NOT_FOUND' ? { kind: 'conflict' }
      : { kind: 'invalid', field: result.field, messageKey: result.messageKey };
  if (result.duplicate || !result.noticeKey) return { kind: 'unchanged' };
  return { kind: 'applied', notice: { kind: 'success', featureId, messageKey: result.noticeKey, params: result.params } };
}

const draftSetter: RunCommandAdapter<CardDraft> = {
  command: 'promo.draft.set', slots: cardSlots,
  resolve: (wire, slots, _snapshot, targets) => resolveCard('promo.draft.set', wire, slots, targets),
  preflight({ args, locale }, { snapshot, idempotencyKey }) {
    if (isMaking(snapshot)) return { kind: 'busy' };
    const m = promoModel(snapshot);
    if (!m) return { kind: 'conflict' };
    const w = words(locale), current = draftOf(snapshot);
    const patch: Patch = {
      ...(isStrings(args.menuIds) && { menuIds: [...args.menuIds] }), ...(isStrings(args.photoIds) && { photoIds: [...args.photoIds] }),
      ...(moodsOk(args.moods) && { moods: [...args.moods] }), ...(conceptsOk(args.concepts) && { concepts: [...args.concepts] }),
      ...(typeof args.memo === 'string' && { memo: args.memo }),
      ...(typeof args.referenceId === 'string' && REFERENCE_IDS.some(id => id === args.referenceId) && { referenceId: args.referenceId as PromoReferenceId }),
      ...(typeof args.lengthSec === 'number' && LENGTHS.some(length => length === args.lengthSec) && { lengthSec: args.lengthSec as 10 | 15 | 30 }),
    };
    if (!Object.keys(patch).length) return { kind: 'invalid' };
    const menus = patch.menuIds ?? current.menuIds;
    if (menus.some(id => !m.menus.some(menu => menu.menuId === id))) return { kind: 'invalid', field: 'menuIds', messageKey: 'data.error.notFound' };
    const allowed = new Set(m.menus.filter(menu => menus.includes(menu.menuId)).flatMap(menu => menu.photos.map(photo => photo.photoId)));
    if (patch.photoIds && patch.photoIds.some(id => !allowed.has(id))) return { kind: 'invalid', field: 'photoIds', messageKey: 'data.marketing.error.photosInvalid' };
    if (patch.menuIds && !patch.photoIds && current.photoIds.some(id => !allowed.has(id))) {
      patch.photoIds = current.photoIds.filter(id => allowed.has(id));
    }
    const named = (ids: readonly string[]) => ids.map(id => w.dt(m.menus.find(menu => menu.menuId === id)?.name ?? { raw: id })).join(', ') || w.t('promo.sum.none');
    const fields = [
      ...(patch.menuIds ? [field(w.t('promo.sum.menu'), named(current.menuIds), named(patch.menuIds))] : []),
      ...(patch.photoIds ? [field(w.t('promo.sum.photos'), w.t('promo.sum.photoN', { n: current.photoIds.length }), w.t('promo.sum.photoN', { n: patch.photoIds.length }))] : []),
      ...(patch.moods ? [field(w.t('promo.sum.mood'), current.moods.map(id => w.t(`data.marketing.mood.${id}`)).join(', ') || w.t('promo.sum.none'), patch.moods.map(id => w.t(`data.marketing.mood.${id}`)).join(', '))] : []),
      ...(patch.concepts ? [field(w.t('promo.sum.concept'), current.concepts.map(id => w.t(`data.marketing.concept.${id}`)).join(', ') || w.t('promo.sum.none'), patch.concepts.map(id => w.t(`data.marketing.concept.${id}`)).join(', '))] : []),
      ...(patch.memo !== undefined ? [field(w.t('promo.sum.memo'), current.memo || w.t('promo.sum.noMemo'), patch.memo || w.t('promo.sum.noMemo'))] : []),
      ...(patch.referenceId ? [field(w.t('promo.sum.ref'), current.referenceId ? referenceName(current.referenceId, w) : w.t('promo.sum.none'), referenceName(patch.referenceId, w))] : []),
      ...(patch.lengthSec ? [field(w.t('promo.len.title'), current.lengthSec ? w.t('promo.len.sec', { n: current.lengthSec }) : w.t('promo.sum.none'), w.t('promo.len.sec', { n: patch.lengthSec }))] : []),
      ...unpostedFields(snapshot, w),
    ];
    const composing = m.state === 'done' || m.state === 'posted' || m.state === 'failed' ? { composing: true } : {};
    const applied: Partial<PromoDraft> = { ...patch, ...composing };
    const changedKeys = Object.keys(applied) as (keyof PromoDraft)[];
    const dependentKeys = patch.photoIds || patch.menuIds ? [...changedKeys, 'menuIds', 'photoIds'] as const : changedKeys;
    const matches = (draft: PromoDraft, expected: Partial<PromoDraft>, keys: readonly (keyof PromoDraft)[]) =>
      keys.every(key => JSON.stringify(draft[key]) === JSON.stringify(expected[key]));
    const saved = openDraft(snapshot.tables.realPromo);
    return { kind: 'ready', preview: { title: w.l('영상 재료 고르기', 'Choose video options', '选择视频素材', '選擇影片素材'), target: w.t('widget.promo-video.title'), fields },
      ...(snapshot.tables.realPromo && { featureId: promoFeature, realCommand: saveDraftCommand({ ...patch, locale }, saved, idempotencyKey) }),
      execute(_run, store?: WidgetDataStore): RunActionOutcome {
        if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
        const session = promoSession(store);
        const before = session.getState().draft;
        if (!matches(before, current, dependentKeys)) return { kind: 'conflict' };
        session.setDraft(applied);
        return { kind: 'applied', undo: () => {
          if (store.getSnapshot() !== snapshot || !matches(session.getState().draft, { ...before, ...applied }, dependentKeys)) return false;
          session.setDraft(Object.fromEntries(changedKeys.map(key => [key, before[key]])) as Partial<PromoDraft>);
          return true;
        } };
      } };
  },
};

function makeSelection(snapshot: DataSnapshot, locale: Locale) {
  const model = promoModel(snapshot), state = sessionOf(snapshot)?.getState();
  if (!model || state?.estimate.status !== 'ready') return undefined;
  const photoOrder = model.menus.flatMap(menu => menu.photos.map(photo => photo.photoId));
  const checked = previewVideoMake(snapshot, inputOfDraft(state.draft, photoOrder, locale) ?? undefined);
  if (!checked.ok) return undefined;
  const { input } = checked;
  const estimate = lookupEstimate(state.estimate.value, input.lengthSec, input.photoIds.length);
  return estimate ? { input, estimate, model } : undefined;
}

function sameVideoInput(input: PromoVideoInput, fields: Readonly<Record<string, unknown>>) {
  return Object.entries(input).every(([key, value]) => JSON.stringify(value) === JSON.stringify(fields[key]));
}

const videoMake: RunCommandAdapter<CardDraft & { live: boolean }> = {
  command: 'video.make', slots: cardSlots,
  resolve(wire, slots, _snapshot, targets) {
    const draft = resolveCard('video.make', wire, slots, targets);
    return draft && { ...draft, live: slots.promoRetryLive === true };
  },
  preflight({ args, locale, live }, { snapshot, idempotencyKey }) {
    if (isMaking(snapshot)) return { kind: 'busy' };
    const selected = makeSelection(snapshot, locale);
    if (!selected || !sameVideoInput(selected.input, args)) return { kind: 'conflict' };
    const { input, estimate, model } = selected, w = words(locale);
    const menus = model.menus.filter(menu => input.menuIds.includes(menu.menuId));
    const fields = [
      detail(w.t('promo.sum.menu'), menus.map(menu => w.dt(menu.name)).join(', ')),
      detail(w.t('promo.sum.photos'), w.t('promo.sum.photoN', { n: input.photoIds.length })),
      detail(w.t('promo.sum.mood'), input.moods.map(id => w.t(`data.marketing.mood.${id}`)).join(', ')),
      detail(w.t('promo.sum.concept'), input.concepts.map(id => w.t(`data.marketing.concept.${id}`)).join(', ')),
      detail(w.t('promo.sum.memo'), input.memo || w.t('promo.sum.noMemo')),
      detail(w.t('promo.sum.ref'), referenceName(input.referenceId, w)),
      detail(w.t('promo.len.title'), w.t('promo.len.sec', { n: input.lengthSec })),
      detail(w.l('예상', 'Estimate', '预计', '預計'),
        `${w.t('promo.est.time', { t: estimateTimeText(w.tr, estimate.seconds) })} · ${w.t('promo.est.cost', { c: estimateCostText(w.tr, estimate.costKrw) })}`),
      ...unpostedFields(snapshot, w),
    ];
    let checkedOnPress = false;
    return { kind: 'ready', preview: { title: w.t('marketing.makeVideo'), target: w.t('widget.promo-video.title'), fields },
      ...(snapshot.tables.realPromo && { featureId: promoFeature, realAction: {
        domain: 'promo' as const, fingerprint: JSON.stringify(input),
        bindings: [{ type: 'video.make', input, idempotencyKey }, saveDraftCommand(input)],
        execute(store: WidgetDataStore) {
          if (!checkedOnPress) {
            const check = makeSelection(store.getSnapshot(), locale);
            if (!check || !sameVideoInput(check.input, args) || check.estimate.seconds !== estimate.seconds || check.estimate.costKrw !== estimate.costKrw) {
              return Promise.resolve(failure('CONFLICT', 'STALE_REVISION', 'data.real.error.STALE_REVISION'));
            }
            checkedOnPress = true;
          }
          return promoSession(store).makeConfirmed(input, roundEstimateSeconds(estimate.seconds));
        },
      } }),
      execute(_run, store) {
        if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
        const current = makeSelection(snapshot, locale);
        if (!current || !sameVideoInput(current.input, args) || current.estimate.seconds !== estimate.seconds
          || current.estimate.costKrw !== estimate.costKrw) return { kind: 'conflict' };
        const result = promoSession(store).make(input, roundEstimateSeconds(estimate.seconds), live ? undefined : offlinePromoRetry.startJob);
        return applyOutcome(promoFeature, result);
      } };
  },
};

const videoRetry: RunCommandAdapter<CardDraft & { live: boolean }> = {
  command: 'video.retry', slots: {},
  resolve(wire, slots, _snapshot, targets) {
    const draft = resolveCard('video.retry', wire, slots, targets);
    return draft && { ...draft, live: slots.promoRetryLive === true };
  },
  preflight({ args, locale, live }, { snapshot, idempotencyKey }) {
    const video = videoRows(snapshot).at(-1);
    if (video?.status !== 'failed' || video.videoId !== args.videoId) return { kind: 'conflict' };
    if (isMaking(snapshot)) return { kind: 'busy' };
    const w = words(locale);
    return { kind: 'ready', preview: {
      title: w.l('홍보 영상 다시 만들기', 'Retry promo video', '重新制作宣传视频', '重新製作宣傳影片'),
      target: w.t('widget.promo-video.title'),
      fields: [field(w.t('promo.len.title'), w.dash, w.t('promo.len.sec', { n: video.lengthSec })),
        field(w.t('promo.sum.photos'), w.dash, w.t('promo.sum.photoN', { n: video.photoCount }))],
    }, ...(snapshot.tables.realPromo && { featureId: promoFeature, realAction: {
      domain: 'promo' as const, fingerprint: JSON.stringify({ videoId: video.videoId, input: video.input }),
      bindings: [{ type: 'video.retry', videoId: video.videoId, idempotencyKey }, saveDraftCommand(video.input)],
      execute: (store: WidgetDataStore) => promoSession(store).retryConfirmed(video.videoId),
    } }), execute(_run, store) {
      if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
      const result = promoSession(store).retry(video.videoId, live ? undefined : offlinePromoRetry);
      if (!result.ok || result.duplicate) return applyOutcome(promoFeature, result);
      if (!result.value) return { kind: 'unchanged' };
      return { kind: 'applied', notice: { kind: 'success', featureId: promoFeature,
        messageKey: 'data.marketing.notice.videoStarted', params: { videoId: video.videoId } } };
    } };
  },
};

const markPosted: RunCommandAdapter<CardDraft> = {
  command: 'video.markPosted', slots: {},
  resolve: (wire, slots, _snapshot, targets) => resolveCard('video.markPosted', wire, slots, targets),
  preflight({ args, locale }, { snapshot, idempotencyKey }) {
    if (snapshot.tables.realPromo) return { kind: 'invalid', field: 'link', messageKey: 'data.real.error.VALIDATION' };
    const { videoId, route } = args;
    const m = promoModel(snapshot);
    const video = m?.videos.find(row => row.videoId === videoId);
    if (!m || !video || typeof videoId !== 'string' || !(['clip', 'reels', 'shorts'] as const).some(value => value === route)) return { kind: 'conflict' };
    const checked = previewVideoMarkPosted(snapshot, videoId, route);
    if (!checked.ok) return checked.code === 'CONFLICT' && video.status === 'posted' ? { kind: 'unchanged' }
      : checked.code === 'NOT_FOUND' ? { kind: 'conflict' } : { kind: 'invalid', field: checked.field, messageKey: checked.messageKey };
    const w = words(locale), postRoute = route as VideoPostRoute;
    const coupon = checked.couponId ? snapshot.tables.marketing.coupon.find(row => row.couponId === checked.couponId) : undefined;
    const command: MarketingCommand = { type: 'video.markPosted', videoId, route: postRoute, idempotencyKey };
    return { kind: 'ready', tier: 'extra-confirm',
      preview: { title: w.t('promo.btn.posted'), target: w.t('promo.done.meta', { s: video.lengthSec, n: video.photoCount }), fields: [
        field(w.t('promo.place.title'), w.dash, w.t(`promo.place.${postRoute}`)),
        field(w.l('안내', 'Note', '说明', '說明'), w.dash, w.t('promo.place.note')),
        ...(coupon && checked.couponIssueCount > 0 ? [field(w.l('쿠폰 코드', 'Coupon code', '优惠码', '優惠碼'), w.dash,
          `${w.dt(coupon.name)} · ${w.count(checked.couponIssueCount)}`)] : []),
      ] },
      execute(_run, store?: WidgetDataStore): RunActionOutcome {
        if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
        return applyOutcome(promoFeature, store.dispatch({ ...command, baseRevision: snapshot.revision }));
      } };
  },
};

const reachOut: RunCommandAdapter<CardDraft> = {
  command: 'coupon.sendReachOut', slots: { body: (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 },
  resolve: (wire, slots, _snapshot, targets) => resolveCard('coupon.sendReachOut', wire, slots, targets),
  preflight({ args, locale }, { snapshot, idempotencyKey }) {
    const m = groupsModel(snapshot);
    if (!m) return { kind: 'conflict' };
    if (args.groupId !== 'churn-risk') return { kind: 'invalid' };
    const recipients = m.churnRisk.filter(row => m.reachOut.recipientIds.includes(row.customerId));
    if (!m.canReachOut || !recipients.length) return { kind: 'invalid', field: 'recipientIds', messageKey: 'data.marketing.error.noRecipients' };
    if (!m.real) {
      const checked = previewReachOut(snapshot, recipients.map(row => row.customerId));
      if (!checked.ok) return { kind: 'invalid', field: checked.field, messageKey: checked.messageKey };
    }
    const w = words(locale);
    const defaultBody = w.t('data.marketing.sms.reachOut');
    const edited = typeof args.body === 'string' && args.body.trim() !== defaultBody.trim() ? args.body.trim() : undefined;
    const command: MarketingCommand = { type: 'coupon.sendReachOut', recipientIds: recipients.map(row => row.customerId), idempotencyKey,
      ...(edited && { messageEdits: edited }) };
    return { kind: 'ready', realCommand: command, featureId: groupsFeature,
      preview: { title: w.t('marketing.reachOutToThese'), target: w.t('data.marketing.group.churnRisk'), fields: [
      field(w.l('받는 사람', 'Recipients', '收件人', '收件者'), w.dash, [w.people(recipients.length), ...recipients.slice(0, 5).map(row => w.dt(row.name))].join(' · ')),
      field(w.t('widget.customer-groups.consentNo'), w.dash, w.people(m.churnRisk.length - recipients.length)),
      field(w.l('문자 내용', 'Message', '短信内容', '簡訊內容'), w.dash, edited ?? defaultBody),
      field(w.l('발송 시각', 'Send time', '发送时间', '傳送時間'), w.dash, w.l('지금', 'Now', '现在', '現在')),
    ] },
    execute(_run, store?: WidgetDataStore): RunActionOutcome {
      if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
      return applyOutcome(groupsFeature, store.dispatch({ ...command, baseRevision: snapshot.revision }));
    } };
  },
};

/* ───────────── understanding the owner's sentence ───────────── */
const answer = (text: string): DomainRoute => ({ kind: 'answer', answer: text });
const clarify = (field: string, text: string, choices?: readonly { id: string; label: string }[],
  resume?: (value: string) => DomainRoute | undefined): DomainRoute =>
  ({ kind: 'clarification', field, answer: text, ...(choices && { choices }), ...(resume && { resume }) });
const refuse = (text: string, alternative?: { featureId: string; command?: string; draft?: Record<string, unknown> },
  reason: 'unsupported' | 'invalid_target' | 'widget_only' = 'widget_only'): DomainRoute => ({ kind: 'refusal', reason, answer: text, ...(alternative && { alternative }) });
const read = (featureId: PromotionFeature, factKeys: readonly string[], missing?: string, condition: QueryCondition = defaultCondition): DomainTurnInput =>
  ({ intent: { kind: 'read', featureId, condition }, factKeys, ...(missing && { onMissing: { answer: missing } }) });

const questionWords = /몇|얼마|어떻게|어떤|왜|뭐|무엇|어디|언제|알려|가능|있(?:어|나|냐|니|는지|어요|나요)|모였|모인|된\s*거|했(?:어|지)|\?|요\s*$|인가|할\s*수/u;
const videoWords = /영상|동영상|비디오|릴스|쇼츠|클립|\bvideo\b/iu;
const makeVerbs = /만들어\s*(?:줘|줘요|주세요|봐)?(?:[.!?]|$)|만들어줘|뽑아\s*줘|돌려\s*줘|제작해|생성해|만들자|준비해\s*줘|만들게\s*해|뽑아줘|돌려줘/u;
const photoAllWords = /전부|전체|다\s*(?:넣|써|골라|선택)|싹|모두|\ball\b/iu;
const photoChoiceWords = /사진.*(?:골라|선택|써|넣)|사진.*(?:전부|전체|싹|모두)|사진.*\d+\s*장|\d+\s*번\s*사진/u;
const photoRange = /(?:1|일)\s*번\s*부터\s*(\d+|[일이삼사오육칠팔구십]+)\s*번\s*사진/u;
const duration = /(\d+|[영일이삼사오육칠팔구십]+)\s*(초|분)/u;
const memoWords = /메모|원하는\s*느낌/u;
const unpostWords = /(?:올렸다고|올림)\s*(?:표시)?.*(?:취소|되돌|없애)|(?:취소|되돌|없애).*(?:올렸|올림)|잘못\s*눌렀/u;
const quotedSpans = /[“「『"'‘][^”」』"'’]*[”」』"'’]/gu;
const postedAttestation = /(?:올렸(?:어요?|습니다|음|다|네요)|올림|업로드\s*(?:완료|끝(?:냈어요?|냈습니다)?|했어요?|했습니다))(?=\s|[.!?,]|$)|올렸다고\s*(?:(?:또|다시(?:\s*한\s*번)?)\s*)?(?:표시|처리)/u;
const makeEstimateWords = /시간|비용|돈|얼마|걸려/u;
const promoStepWords = /분위기|느낌|주제|메모|레퍼런스|디자인|길이|\d+\s*초|십오초|사진|골라/u;
const normalizePromoName = (text: string) => normalizeNavisName(text).replaceAll('크로아상', '크루아상');
const mentionsPromoMenu = (text: string, menu: PromoMenuModel, w: Words) => {
  const name = normalizePromoName(w.dt(menu.name));
  return name.length > 0 && normalizePromoName(text).includes(name);
};
const namedPhotoChoice = (text: string, m: MarketingModelMap['promo-video'] | undefined, w: Words) =>
  photoChoiceWords.test(text) && m?.menus.some(menu => mentionsPromoMenu(text, menu, w));
const retryWords = /재시도|다시\s*만들기|\bretry\b|重新制作|重新製作/iu;
const wantsRetry = (text: string) => retryWords.test(text) || /다시|또\s*돌/u.test(text) && makeVerbs.test(text);
const screenWords = /열어|화면|창\s*(?:띄|열)|띄워|가자|단계|눌러/u;
const openWords = /열어|화면|창\s*(?:띄|열)|성과\s*창|띄워|가자|보여\s*줘|보여줘|틀어|확인할래|눌러\s*줘|누르|단계|이동|들어가|가줘|go to|open/iu;

function postRouteOf(text: string): VideoPostRoute | 'other' | 'multiple' | undefined {
  const routes = [
    ...(/클립/u.test(text) ? ['clip' as const] : []),
    ...(/릴스|인스타/u.test(text) ? ['reels' as const] : []),
    ...(/쇼츠|유튜브/u.test(text) ? ['shorts' as const] : []),
    ...(/틱톡|블로그|카카오|페이스북|트위터|당근|네이버\s*카페/u.test(text) ? ['other' as const] : []),
  ];
  return routes.length > 1 ? 'multiple' : routes[0];
}

function routeChoices(w: Words) {
  return (['clip', 'reels', 'shorts'] as const).map(id => ({ id, label: w.t(`promo.place.${id}`) }));
}

function markPostedRoute(text: string, snapshot: DataSnapshot, locale: Locale, chosen?: VideoPostRoute): DomainRoute {
  if (snapshot.tables.realPromo) return refuse('AI 홍보 영상에서 게시 링크를 입력한 뒤 확인해 주세요.', { featureId: promoFeature, command: 'video.markPosted' });
  const w = words(locale), m = promoModel(snapshot);
  const rows = m?.videos ?? [];
  const target = latest(rows, 'done');
  if (!target) {
    if (latest(rows, 'posted') && !rows.some(row => row.status === 'making' || row.status === 'done')) {
      const posted = latest(rows, 'posted')!;
      return answer(`${w.t('widget.promo-video.postedTo', { place: w.t(`promo.place.${posted.postedRoute ?? 'clip'}`) })} · ${w.l('이미 올렸다고 표시했어요', 'Already marked as posted.', '已标记为已发布。', '已標記為已發布。')}`);
    }
    return answer(w.t('data.marketing.error.notReady'));
  }
  const route = chosen ?? postRouteOf(text);
  if (route === undefined || route === 'other' || route === 'multiple') {
    const choices = routeChoices(w);
    return clarify('route', w.t('promo.place.need'), choices, value => choices.some(choice => choice.id === value)
      ? markPostedRoute(text, snapshot, locale, value as VideoPostRoute) : undefined);
  }
  return { intent: { kind: 'command', command: 'video.markPosted', args: { videoId: { handle: 'pending' }, route } },
    slots: { videoQuery: target.videoId, navisLocale: locale },
    lookups: [{ kind: 'promoVideo', querySlot: 'videoQuery', bind: ['videoId'] }] };
}

/* — choosing the draft — */
const moodWords: readonly [VideoMood, RegExp][] = [
  ['warm', /따뜻|포근|훈훈|warm/iu], ['clean', /깔끔|깨끗|단정|심플|clean/iu],
  ['lively', /활기|발랄|신나|경쾌|생동|lively/iu], ['elegant', /고급|우아|세련|품격|elegant/iu],
];
const conceptWords: readonly [VideoConcept, RegExp][] = [
  ['review-roundup', /매장\s*(?:소개|분위기)|가게\s*소개/u], ['behind-the-scenes', /비하인드|뒷\s*이야기|만드는\s*과정|behind/iu],
  ['todays-deal', /오늘의?\s*(?:특가|할인)|특가|today'?s\s*deal/iu], ['new-item', /신메뉴|신상|새\s*메뉴|new\s*item/iu],
  ['day-at-shop', /하루|일상|day\s*at/iu],
];

function numberBefore(text: string, unit: RegExp): number | undefined {
  const found = new RegExp(`(?<![\\p{L}\\p{N}])([0-9]+|[영일이삼사오육칠팔구십백한두세네다섯여섯일곱여덟아홉열스무]+)\\s*(?:${unit.source})`, 'u').exec(text);
  return found ? parseNavisNumber(found[1]) : undefined;
}

function draftRoute(text: string, snapshot: DataSnapshot, locale: Locale, forced?: Patch): DomainRoute | undefined {
  const w = words(locale), m = promoModel(snapshot), current = draftOf(snapshot);
  if (isMaking(snapshot)) return answer(w.t('data.marketing.error.busy'));
  const patch: Patch = { ...forced };
  // Memo contents are data, including any field names or numbers inside them.
  const fieldsText = memoWords.test(text) ? text.split(memoWords, 1)[0] : text;
  const normalized = normalizePromoName(fieldsText);

  const reviewTheme = /(?:리뷰|후기)\s*(?:모음|모아서|모아\s*보여)/u.test(fieldsText);
  const retiredDesign = /말풍선/u.test(fieldsText);
  if (reviewTheme && !retiredDesign) {
    const themes = CONCEPTS.map(id => w.t(`data.marketing.concept.${id}`));
    return answer(`손님 리뷰의 글이나 사진은 영상에 쓸 수 없어요. 직접 올린 매장 사진으로 만들 수 있어요. 영상 주제는 ${themes.join(' · ')} 중에서 골라 주세요.`);
  }

  // menu and photos
  const options = m?.menus ?? [];
  const named = options.filter(menu => mentionsPromoMenu(fieldsText, menu, w)).sort((a, b) => w.dt(b.name).length - w.dt(a.name).length);
  const picked = named.length && !forced?.menuIds ? [named[0]] : [];
  const menusInPlay = forced?.menuIds ? forced.menuIds.map(id => options.find(menu => menu.menuId === id)).filter((menu): menu is PromoMenuModel => !!menu)
    : picked.length ? picked : current.menuIds.map(id => options.find(menu => menu.menuId === id)).filter((menu): menu is PromoMenuModel => !!menu);
  const everyPhoto = photoAllWords.test(fieldsText);
  const rangeEnd = photoRange.exec(fieldsText)?.[1];
  const wanted = rangeEnd ? parseNavisNumber(rangeEnd) : /사진|\d+\s*장|장(?:만|을)?\s*(?:골라|선택|써|넣)/u.test(fieldsText)
    ? numberBefore(fieldsText, /장(?!님)|개/u) : undefined;
  if (wanted !== undefined && wanted < MIN_PROMO_PHOTOS) return clarify('photoCount', w.t('data.marketing.error.fewPhotos'));
  const chooseMenu = (message: string) => {
    const choices = options.filter(row => row.hasPhotos).slice(0, 6).map(row => ({ id: row.menuId, label: w.dt(row.name) }));
    return clarify('menuId', message, choices, value => choices.some(choice => choice.id === value)
      ? draftRoute(text, snapshot, locale, { ...forced, menuIds: [value] }) : undefined);
  };
  if (picked.length || forced?.menuIds || wanted !== undefined || everyPhoto && /사진|장/u.test(fieldsText)) {
    const menu = menusInPlay[0];
    if (!menu) return chooseMenu(w.t(options.some(row => row.hasPhotos) ? 'promo.photo.pickMenu' : 'promo.photo.noneAny'));
    if (!menu.hasPhotos) return chooseMenu(`${w.dt(menu.name)} · ${w.t('promo.photo.none')}`);
    const available = menu.photos.map(photo => photo.photoId);
    const take = wanted ?? available.length;
    if (take < MIN_PROMO_PHOTOS) return clarify('photoCount', w.t('data.marketing.error.fewPhotos'));
    if (take > available.length) return clarify('photoCount', `${w.dt(menu.name)} · ${w.t('promo.menu.photos', { n: available.length })}`);
    patch.menuIds = [menu.menuId];
    patch.photoIds = available.slice(0, take);
  }

  // moods and concepts
  const moodCue = /분위기|느낌|무드|mood/iu.test(fieldsText);
  if (moodCue && !forced?.moods) {
    const moods = moodWords.filter(([, pattern]) => pattern.test(fieldsText)).map(([id]) => id);
    if (!moods.length) {
      const choices = MOODS.map(id => ({ id, label: w.t(`data.marketing.mood.${id}`) }));
      return clarify('mood', w.t('promo.mood.title'), choices, value => MOODS.some(id => id === value) ? draftRoute(text, snapshot, locale, { ...forced, moods: [value as VideoMood] }) : undefined);
    }
    patch.moods = moods;
  }
  const conceptCue = /주제|컨셉|콘셉트|concept|영상\s*(?:은|을)?\s*리뷰|후기\s*모아|[가-힣]+\s*영상(?:으로|로)\s*(?:해|골)/iu.test(fieldsText);
  if (conceptCue && !forced?.concepts) {
    const concepts = conceptWords.filter(([, pattern]) => pattern.test(fieldsText)).map(([id]) => id);
    if (!concepts.length) {
      const choices = CONCEPTS.map(id => ({ id, label: w.t(`data.marketing.concept.${id}`) }));
      return clarify('concept', w.t('promo.concept.title'), choices, value => CONCEPTS.some(id => id === value) ? draftRoute(text, snapshot, locale, { ...forced, concepts: [value as VideoConcept] }) : undefined);
    }
    patch.concepts = concepts;
  }
  if (!forced?.moods && !patch.moods && /(?:따뜻|깔끔|활기|고급)/u.test(fieldsText) && !moodCue) {
    patch.moods = moodWords.filter(([, pattern]) => pattern.test(fieldsText)).map(([id]) => id);
  }

  // memo
  const memoMatch = /(?:메모|원하는\s*느낌)(?:에|는|:|：)?\s*[“「『"'‘]?([^”」』"'’]+?)[”」』"'’]?(?:\s*(?:라고|이라고|를|을)?\s*(?:적어|넣어|써|입력|쓰고)\s*(?:줘|줄래|주세요)?)?\s*$/u.exec(text)
    ?? /[“「『"'‘]([^”」』"'’]+)[”」』"'’]\s*(?:라고|이라고)\s*(?:적어|써|넣어)/u.exec(text)
    ?? /(?:메모|원하는\s*느낌)[^:：]*[:：]\s*(.+)$/u.exec(text);
  if (memoMatch && /메모|원하는\s*느낌/u.test(text) && !forced) {
    const memo = (memoMatch[1] ?? '').replace(/^(?:에|에는|는)\s*/u, '').trim();
    if (!memo || memoLength(memo) > MEMO_LIMIT || /긴\s*설명|길게|백\s*자\s*넘/u.test(text)) {
      return clarify('memo', w.t('data.marketing.error.memoTooLong'));
    }
    patch.memo = memo;
  }

  // design reference
  const explicitId = /\bref-[1-9][0-9]*\b/iu.exec(fieldsText)?.[0]?.toLowerCase();
  const refNumber = /(?:ref[-\s]?|레퍼런스\s*|디자인\s*)([0-9]+|[일이삼사오육칠팔구십]+)\s*번?|([0-9]+|[일이삼사오육칠팔구십]+)\s*번\s*(?:레퍼런스|디자인)|(일곱|여덟|아홉|열|[한두세네]|다섯|여섯|[0-9]+|[일이삼사오육칠팔구십]+)\s*번째/iu.exec(fieldsText);
  const nameHit = REFERENCE_IDS.filter(id => {
    if (normalized.includes(normalizeNavisName(referenceName(id, w)))) return true;
    const tokens = referenceName(id, w).split(/[\s+·]+/u).filter(token => token.length >= 3);
    return tokens.some(token => normalized.includes(normalizeNavisName(token)))
      && !REFERENCE_IDS.some(other => other !== id && referenceName(other, w).includes(referenceName(id, w).split(/[\s+·]+/u).find(token => token.length >= 3 && normalized.includes(normalizeNavisName(token))) ?? '\u0000'));
  });
  if (!forced?.referenceId && (retiredDesign || refNumber || nameHit.length === 1 && /디자인|레퍼런스|스타일|말풍선|로\s*(?:해|골)/u.test(fieldsText))) {
    const number = refNumber ? parseNavisNumber(refNumber[1] ?? refNumber[2] ?? refNumber[3]) : undefined;
    const id = retiredDesign ? undefined : explicitId ? REFERENCE_IDS.find(value => value === explicitId)
      : refNumber ? REFERENCE_IDS[(number ?? 0) - 1] : nameHit[0];
    if (!id) {
      const choices = REFERENCE_IDS.map((value, index) => ({ id: value, label: `${index + 1}. ${referenceName(value, w)}` }));
      const prompt = retiredDesign
        ? `매장 사진으로 만들 디자인을 골라 주세요. ${choices.map(choice => choice.label).join(' · ')}`
        : w.t('data.marketing.error.referenceInvalid');
      return clarify('referenceId', prompt, choices,
        value => REFERENCE_IDS.some(candidate => candidate === value) ? draftRoute(text, snapshot, locale, { ...forced, referenceId: value as PromoReferenceId }) : undefined);
    }
    patch.referenceId = id;
  }

  // length
  const length = duration.exec(fieldsText);
  if (!forced?.lengthSec && length) {
    const value = (parseNavisNumber(length[1]) ?? 0) * (length[2] === '분' ? 60 : 1);
    if (!LENGTHS.some(length => length === value)) {
      const choices = LENGTHS.map(length => ({ id: String(length), label: w.t('promo.len.sec', { n: length }) }));
      return clarify('lengthSec', w.t('promo.len.title'), choices,
        value2 => LENGTHS.some(length => String(length) === value2) ? draftRoute(text, snapshot, locale, { ...forced, lengthSec: Number(value2) as 10 | 15 | 30 }) : undefined);
    }
    patch.lengthSec = value as 10 | 15 | 30;
  }

  if (!Object.keys(patch).length) return undefined;
  const wire: Record<string, unknown> = {};
  const slots: Record<string, unknown> = { navisLocale: locale };
  if (patch.menuIds) { wire.menuIds = ref('menuIds'); slots.menuIds = patch.menuIds; }
  if (patch.photoIds) { wire.photoIds = ref('photoIds'); slots.photoIds = patch.photoIds; }
  if (patch.moods) { wire.moods = ref('moods'); slots.moods = patch.moods; }
  if (patch.concepts) { wire.concepts = ref('concepts'); slots.concepts = patch.concepts; }
  if (patch.memo !== undefined) { wire.memo = ref('memo'); slots.memo = patch.memo; }
  if (patch.referenceId) wire.referenceId = patch.referenceId;
  if (patch.lengthSec) wire.lengthSec = patch.lengthSec;
  return { intent: { kind: 'command', command: 'promo.draft.set', args: wire as AgentWireArgs }, slots: slots as LocalSlots };
}

function makeRoute(snapshot: DataSnapshot, locale: Locale): DomainRoute {
  const w = words(locale), current = draftOf(snapshot);
  const choices = (ids: readonly string[], label: (id: string) => string, field: string, prompt: string, patch: (id: string) => Patch) =>
    clarify(field, prompt, ids.map(id => ({ id, label: label(id) })), value =>
      ids.includes(value) ? draftRoute('', snapshot, locale, patch(value)) : undefined);
  if (!current.menuIds.length) {
    const menus = promoModel(snapshot)?.menus.filter(menu => menu.photos.length >= MIN_PROMO_PHOTOS).slice(0, 6) ?? [];
    return choices(menus.map(menu => menu.menuId), value => w.dt(menus.find(menu => menu.menuId === value)!.name),
      'menuId', menus.length ? w.l('어떤 메뉴로 만들까요?', 'Which menu item should the video feature?', '要用哪道菜制作视频？', '要用哪道菜製作影片？')
        : w.t('data.marketing.error.fewPhotos'), value => ({ menuIds: [value] }));
  }
  if (current.photoIds.length < MIN_PROMO_PHOTOS) return clarify('photoCount', w.t('data.marketing.error.fewPhotos'));
  if (!current.moods.length) return choices(MOODS, id => w.t(`data.marketing.mood.${id}`),
    'mood', w.t('promo.mood.title'), id => ({ moods: [id as VideoMood] }));
  if (!current.concepts.length) return choices(CONCEPTS, id => w.t(`data.marketing.concept.${id}`),
    'concept', w.t('promo.concept.title'), id => ({ concepts: [id as VideoConcept] }));
  if (!current.referenceId) return choices(REFERENCE_IDS, id => referenceName(id, w),
    'referenceId', w.t('promo.sum.ref'), id => ({ referenceId: id as PromoReferenceId }));
  if (!current.lengthSec) return choices(LENGTHS.map(String), id => w.t('promo.len.sec', { n: Number(id) }),
    'lengthSec', w.t('promo.len.title'), id => ({ lengthSec: LENGTHS.find(length => String(length) === id) }));
  const selection = makeSelection(snapshot, locale);
  if (!selection) {
    const note = unpostedNote(snapshot, w);
    const instruction = w.l('AI 홍보 영상에서 만들 수 있어요', 'Start your video in AI Promo Video.',
      '请在 AI 宣传视频中开始制作。', '請在 AI 宣傳影片中開始製作。');
    return refuse(note ? `${note}\n${instruction}` : instruction, { featureId: promoFeature, command: 'video.make' });
  }
  const { menuIds, photoIds, moods, concepts, memo, referenceId, lengthSec } = selection.input;
  return { intent: { kind: 'command', command: 'video.make', args: {
    menuIds: ref('menuIds'), photoIds: ref('photoIds'), moods: ref('moods'), concepts: ref('concepts'), memo: ref('memo'),
    referenceId, lengthSec, locale,
  } }, slots: { menuIds, photoIds, moods, concepts, memo },
  reading: { tool: 'get_promotion_preflight', args: { action: 'make' } } };
}

function estimateRoute(text: string, snapshot: DataSnapshot, locale: Locale): DomainRoute {
  const w = words(locale);
  const choices = LENGTHS.map(value => ({ id: String(value), label: w.t('promo.len.sec', { n: value }) }));
  // The estimate table is the window's cache (a local read it makes when it opens); chat never fetches it.
  const readLength = (length: number): DomainRoute => {
    const state = sessionOf(snapshot)?.getState();
    if (state?.estimate.status !== 'ready') return refuse(w.t('promo.est.error'), { featureId: promoFeature });
    if (state.draft.photoIds.length < MIN_PROMO_PHOTOS) return clarify('photoCount', w.t('data.marketing.error.fewPhotos'));
    if (!lookupEstimate(state.estimate.value, length, state.draft.photoIds.length)) {
      return refuse(w.t('promo.est.error'), { featureId: promoFeature });
    }
    return read(promoFeature, [`video.estimate.${length}`], w.t('promo.est.error'));
  };
  const stated = duration.exec(text);
  const length = stated ? (parseNavisNumber(stated[1]) ?? 0) * (stated[2] === '분' ? 60 : 1) : draftOf(snapshot).lengthSec;
  if (length !== null && LENGTHS.some(value => value === length)) return readLength(length);
  return clarify('lengthSec', length === null ? w.t('promo.est.pick') : w.t('promo.len.title'), choices,
    value => LENGTHS.some(candidate => String(candidate) === value) ? readLength(Number(value)) : undefined);
}

function videoRoute(raw: string, snapshot: DataSnapshot, locale: Locale, inWindow = false): DomainRoute | undefined {
  const text = normalizeNavisInput(raw), w = words(locale);
  const postText = text.replace(quotedSpans, ' ').trim();
  const m = promoModel(snapshot), rows = m?.videos ?? [];
  const finished = rows.some(row => row.status === 'done' || row.status === 'posted');
  const couponPost = (selectWidget(snapshot, 'expiry-coupon', defaultCondition, 'normal') as { status: string; model?: { pendingPosts: readonly unknown[] } })
    .model?.pendingPosts.length;
  const posting = /올렸|올림|업로드/u.test(postText) && postRouteOf(postText) !== undefined && finished
    || !couponPost && /올렸다고\s*(?:표시|한)|올림\s*표시/u.test(postText);
  const deviceFile = /내\s*폰(?:에)?\s*저장|직접\s*올릴|내\s*폰\s*사진/u.test(text);
  const video = inWindow || posting || deviceFile || videoWords.test(text) || namedPhotoChoice(text, m, w)
    || /레퍼런스|원하는\s*느낌|ref-\d|^길이\s*\d/u.test(text);
  if (!video) return undefined;

  // fixed boundaries first
  if (/영어|중국어|일본어|외국어|자막.*(?:로|으로)|외국인/u.test(text) && videoWords.test(text)) {
    return refuse(w.l('영상 언어는 앱 언어를 따라가요. 앱 언어를 바꾼 뒤 영상을 만들어 주세요', 'The video language follows the app language.',
      '视频语言跟随应用语言。', '影片語言會跟隨應用程式語言。'), { featureId: promoFeature }, 'unsupported');
  }
  if (unpostWords.test(postText) && !/쿠폰|플레이스/u.test(postText)) {
    return refuse(w.l('올렸다고 표시한 것은 되돌릴 수 없어요', 'A posted mark cannot be undone.', '已标记为已发布的内容无法撤销。', '已標記為已發布的內容無法復原。'),
      { featureId: promoFeature }, 'unsupported');
  }
  if (/(?:저장|다운|내려\s*받|내\s*폰)/u.test(text) && (videoWords.test(text) || /내\s*폰/u.test(text)) && !/사진.*(?:올려|추가)/u.test(text)) {
    return refuse(w.t('promo.btn.save'), { featureId: promoFeature });
  }
  if (/(?:삭제|지워|없애)/u.test(text) && /영상|기록|사진/u.test(text)) {
    return refuse(w.l('영상과 사진은 여기서 지울 수 없어요', 'Videos and photos cannot be deleted here.', '无法在这里删除视频和照片。', '無法在這裡刪除影片和照片。'), { featureId: promoFeature }, 'unsupported');
  }
  if (/(?:사진|리뷰\s*사진).*(?:추가해|올려|더\s*넣)|(?:내\s*폰|직접\s*올릴)/u.test(text) && !/골라|선택|전부|전체/u.test(text)) {
    const have = m ? w.t('widget.promo-video.materials.sr', { n: m.photoCount }) : '';
    return refuse(`${w.t('promo.photo.pickMenu')} · ${have}`.trim(), { featureId: promoFeature }, 'unsupported');
  }

  if (wantsRetry(text) && !makeEstimateWords.test(text)) {
    if (isMaking(snapshot)) return answer(w.t('data.marketing.error.busy'));
    const target = rows.at(-1);
    if (target?.status !== 'failed') {
      const status = target?.status === 'done' ? w.l('영상이 완성됐어요.', 'The video is ready.', '视频已制作完成。', '影片已製作完成。')
        : target?.status === 'posted' ? w.l('이미 올렸다고 표시한 영상이에요.', 'This video is marked as posted.',
          '此视频已标记为已发布。', '這部影片已標記為已發布。')
          : w.l('다시 만들 영상이 없어요.', 'There is no video to retry.', '没有可以重新制作的视频。', '沒有可以重新製作的影片。');
      const next = w.l('AI 홍보 영상에서 확인해 주세요.', 'Open AI Promo Video to review.', '请在 AI 宣传视频中查看。', '請在 AI 宣傳影片中查看。');
      return refuse(`${status} ${next}`, { featureId: promoFeature, command: 'video.retry' });
    }
    return { intent: { kind: 'command', command: 'video.retry', args: { videoId: { handle: 'pending' } } },
      slots: { videoQuery: target.videoId, navisLocale: locale },
      lookups: [{ kind: 'promoVideo', querySlot: 'videoQuery', bind: ['videoId'] }],
      reading: { tool: 'get_promotion_preflight', args: { action: 'make' } } };
  }

  // posted mark
  const head = postText.split(/(?<=표시|처리)하고|그리고/u)[0];
  const denied = /(?:안|못)\s*올렸|올리지\s*않|업로드\s*(?:실패|전)|표시\s*(?:하지\s*마|하지\s*않|안\s*해|해\s*달라는\s*(?:건|게)\s*아니)/u;
  const attested = postedAttestation.test(head) && !denied.test(postText);
  if (attested && !/쿠폰\s*코드|플레이스\s*소식/u.test(head) && !questionWords.test(head.replace(/요\s*$/u, ''))) {
    if (!postRouteOf(head) && !videoWords.test(head) && !posting) return undefined;
    if (/다시|또|도\s*올렸|도\s*표시/u.test(head) && rows.some(row => row.status === 'posted')) {
      const posted = latest(rows, 'posted')!;
      return answer(`${w.t('widget.promo-video.postedTo', { place: w.t(`promo.place.${posted.postedRoute ?? 'clip'}`) })} · ${w.l('이미 올렸다고 표시했어요', 'Already marked as posted.', '已标记为已发布。', '已標記為已發布。')}`);
    }
    return markPostedRoute(head, snapshot, locale);
  }
  if (/올려\s*(?:줘|주세요)|업로드\s*(?:해|시켜)/u.test(text) && !/쿠폰|사진/u.test(text)) {
    return refuse(w.t('promo.place.note'), { featureId: promoFeature }, 'unsupported');
  }

  // estimate reads
  if (makeEstimateWords.test(text) && !memoWords.test(text) && (videoWords.test(text) || inWindow) && !/쿠폰|올린|썼|사용률|효과/u.test(text)
    && (questionWords.test(text) || /비용|시간/u.test(text))) {
    return estimateRoute(text, snapshot, locale);
  }

  // draft choices: only declarative requests that name a field
  const declarative = !questionWords.test(text) || /골라|해줘|해\s*줘|넣어|써줘|적어|으로|로$|걸로/u.test(text);
  const draftCue = promoStepWords.test(text) || duration.test(text) || /말풍선|ref-\d|메뉴|전부|전체|싹|\d+\s*장|다\s*넣|[가-힣]+\s*영상(?:으로|로)\s*(?:해|골)/u.test(text);
  const wantsMake = makeVerbs.test(text) && !/골라|넣어|적어/u.test(text);
  const navigational = openWords.test(text) && !/메모|원하는\s*느낌|골라|넣어|해줘|해\s*줘/u.test(text);
  if (declarative && !navigational && (draftCue || wantsMake && m?.menus.some(menu => mentionsPromoMenu(text, menu, w)))) {
    const routed = draftRoute(text, snapshot, locale);
    if (routed) return routed;
  }

  // make
  if (wantsMake && !questionWords.test(text.replace(/(?:줘요|주세요|줘)[.!]*$/u, '')) || /AI\s*영상\s*돌려/u.test(text)) {
    if (isMaking(snapshot)) return answer(w.t('data.marketing.error.busy'));
    return makeRoute(snapshot, locale);
  }
  return undefined;
}

const videoReadKeys: readonly [RegExp, readonly string[]][] = [
  [/만들\s*수\s*있|가능|충분/u, ['video.materials', 'video.canMake']],
  [/올린\s*곳|어디에\s*올|올렸다고\s*했|마지막으로\s*올린/u, ['video.posted.last', 'video.posted.count']],
  [/쿠폰|효과|사용률/u, ['video.posted.count']],
  [/올린|올렸|몇\s*(?:편|개)|개수/u, ['video.posted.count']],
  [/왜|실패|에러|오류|이유/u, ['video.state', 'video.current.fail']],
  [/어디까지|진행|만드는\s*중|언제\s*끝|아직/u, ['video.state', 'video.current.stage', 'video.current.meta']],
  [/메뉴/u, ['video.menu.withPhotos', 'video.menu.row']],
  [/스타일|종류|레퍼런스|디자인/u, ['video.reference.row']],
  [/사진|재료|몇\s*장|몇장|모였/u, ['video.materials']],
];

function videoReadRoute(raw: string): DomainRoute | undefined {
  const text = normalizeNavisInput(raw);
  // 재료 alone is an ingredient (stock) word unless a video is named: "재고 제일 적게 남은 재료" is the stock widget's.
  if (!videoWords.test(text) && !/레퍼런스|영상용\s*사진|(?<!원)재료(?!비|값)/u.test(text)) return undefined;
  if (!videoWords.test(text) && /재고|유통기한|소비기한|폐기|남은\s*재료|떨어/u.test(text)) return undefined;
  const hit = videoReadKeys.find(([pattern]) => pattern.test(text));
  return hit ? read(promoFeature, hit[1]) : undefined;
}

/* — customer groups — */
const churnWords = /떠날|이탈|오랜만|안\s*오(?:는|시)|뜸한|발길|안\s*온/u;
const groupWords = /손님\s*그룹|그룹|단골\s*(?:목록|기준)|첫\s*방문|이탈/u;
/** A coupon write verb: such a request belongs to the coupon domain, never to a performance read. */
const couponWrite = /만들|생성|발행해|고쳐|바꿔|올려|종료\s*(?:시켜|해)|게시\s*(?:취소|해제|내려|중단)|내려\s*줘|내려줘|내리|지워|삭제|연장|중지|멈춰/u;
const reachSend = /(?:쿠폰|문자|챙겨|카톡|메시지).*(?:보내|쏴|날려|뿌려|돌려|챙겨|발송)|(?:보내|쏴|날려|챙겨).*(?:줘|줄래|주세요)|챙겨\s*줘|(?:가능한|보낼\s*수\s*있는)\s*사람(?:한테|에게)\s*쿠폰/u;

function reachOutRoute(text: string, snapshot: DataSnapshot, locale: Locale): DomainRoute {
  const w = words(locale), m = groupsModel(snapshot);
  const open = { featureId: groupsFeature, command: 'ui.openDetail', draft: { featureId: groupsFeature, view: 'reach-out' } } as const;
  if (/첫\s*방문|단골/u.test(text) && !churnWords.test(text)) {
    return refuse(w.l('쿠폰 챙기기는 떠날 수 있는 손님에게만 할 수 있어요', 'Coupons from this screen go to customers who may leave only.',
      '此功能只能向可能流失的顾客发送优惠券。', '此功能只能向可能流失的顧客傳送優惠券。'), { featureId: groupsFeature }, 'unsupported');
  }
  const quotedBody = /[“「『"']([^”」』"']+)[”」』"']/u;
  const scope = text.replace(quotedBody, ' ');
  if (/(?:보내|발송하)지\s*(?:마|말|않)|(?:보내기|발송)(?:은|는|을)?\s*(?:말고|하지\s*마)/u.test(scope)) {
    return answer(w.l('쿠폰을 보내지 않았어요', 'No coupon was sent.', '未发送优惠券。', '未傳送優惠券。'));
  }
  if (/동의\s*(?:안|않|없|(?:여부(?:와|에)?\s*)?상관없이)|거부한|without consent/u.test(scope)) {
    return refuse(w.t('widget.customer-groups.consentNo'), { featureId: groupsFeature }, 'unsupported');
  }
  const recipients = [...scope.matchAll(/([^\s]+?)(?:한테|에게|께)(?=\s|도|만|[.!?]|$)/gu)];
  const specific = recipients.some(([, noun]) => !/^(?:손님|그룹|사람)(?:들)?$/u.test(noun));
  const subset = /(?:중|가운데)\s+([^\s]+)만(?=\s|[.!?]|$)/u.exec(scope)?.[1];
  if (specific || subset || /빼고|제외|(?:[가-힣]씨|[○＊*]{2})|(?:(?:한|두|세|네|몇|\d+)\s*(?:명|분))만|exclude/iu.test(scope)) {
    return refuse(w.t('marketing.recipients'), { featureId: groupsFeature, command: 'ui.openDetail', draft: open.draft });
  }
  if (!m || !m.canReachOut || m.reachOut.count === 0) return refuse(w.t('data.marketing.error.noRecipients'), { featureId: groupsFeature }, 'invalid_target');
  const body = quotedBody.exec(text)?.[1]?.trim();
  return { intent: { kind: 'command', command: 'coupon.sendReachOut', args: { groupId: 'churn-risk', ...(body ? { body: ref('body') } : {}) } },
    slots: { ...(body ? { body } : {}), navisLocale: locale },
    reading: { tool: 'get_promotion_preflight', args: { action: 'reach-out' } } };
}

function groupsRoute(raw: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const text = normalizeNavisInput(raw), w = words(locale);
  if (/^단골(?:\s*손님)?(?:에게|한테)\s*쿠폰\s*(?:보내|발송해)\s*(?:줘|주세요)[.?!。？！]*$/u.test(text)) return reachOutRoute(text, snapshot, locale);
  const named = /(?:회원\s+|^)([김이박최정강조윤장임한오서신권황안송류전홍고문양손배백허유남심노하곽성차주우구민나진지엄원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉경][가-힣]{2})(?:\s*(?:씨|님|손님)|\s+(?:이탈|떠날))/u.exec(text);
  if (named && (churnWords.test(text) || /오시나|요즘/u.test(text)) && !/근\s*(?:에|\s)|탈\s*위험/u.test(named[1])) {
    return clarify('customerName', w.l('손님 그룹에는 이름 일부만 가려서 보여요. 목록에 보이는 이름으로 알려 주세요', 'Names are masked here. Tell me the name as it appears in the list.',
      '这里的姓名已部分隐藏，请按列表中显示的名字告诉我。', '這裡的姓名已部分遮蔽，請依列表中顯示的名字告訴我。'));
  }
  if (!groupWords.test(text) && !churnWords.test(text) && !/동의/u.test(text)) return undefined;
  if (/회원/u.test(text) || !/손님|그룹|단골|사람|첫\s*방문\s*기준/u.test(text)) return undefined;
  if (/동의/u.test(text) && /안|않|못/u.test(text) && !/보내줘|쏴/u.test(text)) return read(groupsFeature, ['groups.consent.blocked']);
  if (churnWords.test(text) && reachSend.test(text) && !/누구|명단|목록/u.test(text)) return reachOutRoute(text, snapshot, locale);
  if (/보낸\s*(?:적|기록)|간\s*적|보냈|이력/u.test(text) && (churnWords.test(text) || /챙기기/u.test(text))) return read(groupsFeature, ['groups.reachOut.history']);
  if (/동의/u.test(text) && !/보내|발송|쏴|포함|그냥/u.test(text)) return read(groupsFeature, ['groups.consent.blocked']);
  if (/제일\s*오래|가장\s*오(?:래|랫)|젤\s*오랜/u.test(text)) return read(groupsFeature, ['groups.churn.oldest']);
  if (/단골\s*기준|단골.*(?:몇\s*번|기준이)/u.test(text) && !/그룹|이탈|떠날|첫\s*방문/u.test(text)) return undefined;
  if (/기준|며칠|규칙|어떻게\s*나눠|나눠|언제\s*부터/u.test(text)) {
    const keys = /첫\s*방문/u.test(text) ? ['groups.rule.first-visit', 'groups.basis'] : /이탈|며칠\s*안\s*오/u.test(text) ? ['groups.rule.churn-risk', 'groups.basis']
      : /단골/u.test(text) ? ['groups.rule.regular', 'groups.basis'] : ['groups.rule.regular', 'groups.rule.first-visit', 'groups.rule.churn-risk', 'groups.basis'];
    return read(groupsFeature, keys);
  }
  if (/누구|명단|목록|몇\s*명|몇명|수\s*알려|알려/u.test(text) && churnWords.test(text) && !screenWords.test(text)) return read(groupsFeature, ['groups.churn.count', 'groups.churn.row']);
  if (/몇\s*명|몇명|수/u.test(text) && /단골|첫\s*방문|그룹/u.test(text) && !openWords.test(text)) return read(groupsFeature, ['groups.count.regular', 'groups.count.first-visit', 'groups.count.churn-risk']);
  return undefined;
}

/* — performance and today — */
const marketingRoutes: readonly [CouponRoute, RegExp][] = [
  ['blog', /블로그/u], ['place_news', /플레이스\s*소식/u], ['clip', /클립/u], ['sms', /문자|\bsms\b/iu],
];
const couponRanking = /쿠폰.*(?:제일|가장).*(?:사용률|잘\s*먹|높|성과)|쿠폰.*사용률.*(?:제일|가장|순위)/u;

/**
 * D-365: the 마케팅 성과 widget is gone, and no other widget shows its route, cost, discount, return or channel numbers. A question
 * that used to read them says so plainly and points at what remains (coupon use in 진행 중인 쿠폰); it never opens the removed
 * window and never cites it. The per-coupon ranking stays with the coupon domain (진행 중인 쿠폰 answers `coupons.rank`).
 * The gates below are the ones the old performance reads used, so the same phrases stay with this domain instead of drifting
 * into the neighbours.
 */
function perfRoute(raw: string, snapshot: DataSnapshot): DomainRoute | undefined {
  const text = normalizeNavisInput(raw);
  if (/쿠폰/u.test(text) && couponWrite.test(text)) return undefined;
  const named = /마케팅\s*성과|성과\s*(?:화면|위젯|창|탭)|영상별|쿠폰별\s*(?:화면|탭)|경로별\s*(?:화면|탭)/u.test(text);
  const gone = answer(named ? couponChatCopy.performanceGone : couponChatCopy.performanceStopped);
  if (snapshot.tables.realGroups && !openWords.test(text) &&
      /채널별\s*지표|플레이스\s*리포트|검색\s*광고|(?:클립|블로그|플레이스).*조회/u.test(text)) return gone;
  const marketingCost = /원가|할인액|깎/u.test(text) && /성과|쿠폰|홍보|마케팅|이번\s*달/u.test(text);
  // The per-coupon ranking is what 진행 중인 쿠폰 still shows (its `coupons.rank`), so it is read there.
  if (couponRanking.test(text)) return read('coupon-status', ['coupons.rank']);
  if (!marketingCost && !/성과|발행|쿠폰\s*(?:할인|때문|마다|별|은|이)|경로|블로그|플레이스\s*소식|사용률|재방문|다시\s*온\s*손님|홍보\s*매출|숫자\s*기준|마케팅/u.test(text)) return undefined;
  if (/지난\s*달|저번\s*달/u.test(text) && !openWords.test(text)) return gone;
  if (openWords.test(text) && /성과|화면|탭/u.test(text)) return /(?:마케팅\s*)?성과|영상별|쿠폰별|경로별/u.test(text) ? gone : undefined;
  if (marketingCost) return gone;
  if ((/방금|아까/u.test(text) || /반영|잡혀|들어갔/u.test(text)) && /쿠폰/u.test(text)) return gone;
  if (/다시\s*온\s*손님|재방문|홍보\s*매출에|14일/u.test(text)) return gone;
  if (/계산|기준|방법|어떻게|뭐가\s*들어/u.test(text) && /성과|매출|사용률|숫자|홍보/u.test(text)) return gone;
  const routeNamed = marketingRoutes.some(([, pattern]) => pattern.test(text));
  if ((routeNamed || /경로/u.test(text)) && /쿠폰/u.test(text) && /어떤|뭐|뭐뭐/u.test(text) && !/몇\s*장/u.test(text)) return gone;
  if ((routeNamed || /경로/u.test(text)) && /발행|사용|몇\s*장|나가/u.test(text)) return gone;
  if (/쿠폰.*(?:성과|사용률|순위|발행)|(?:성과|사용률|순위).*쿠폰|쿠폰마다|쿠폰별/u.test(text)) return read('coupon-status', ['coupons.rank']);
  return undefined;
}

function todayRoute(raw: string): DomainRoute | undefined {
  const text = normalizeNavisInput(raw);
  if ((/오늘\s*할\s*홍보|홍보\s*칸|할\s*홍보|급한\s*홍보|홍보\s*다\s*끝|홍보\s*(?:남|없)/u.test(text)
    || matchWidget(raw) === todayFeature) && !openWords.test(text)) {
    if (/답변|답장|응대|건수/u.test(text)) return read(todayFeature, ['today.replies.compare', 'today.cell.replies', 'today.missing.replies']);
    return { ...read(todayFeature, ['today.cell.quiet-hours', 'today.cell.expiry', 'today.cell.replies', 'today.cell.video', 'today.none']),
      narrow: facts => facts.slice(0, 1) };
  }
  if (/(?:답변|답장)\s*(?:다\s*)?(?:대기|보냈)|대기\s*몇\s*개|응대\s*대기/u.test(text) && /홍보|칸/u.test(text)) return read(todayFeature, ['today.replies.compare', 'today.cell.replies']);
  return undefined;
}

/* ───────────── detail entries ───────────── */
function widgetRef(featureId: PromotionFeature, view?: string, options: { focus?: boolean; condition?: QueryCondition; prefill?: AgentWireArgs } = {}): DetailRef {
  const prefill = options.prefill && validateAgentPrefill(featureId, options.prefill)
    ? { prefill: { kind: 'widget-draft' as const, command: 'ui.openDetail', fields: options.prefill } } : {};
  return { featureId, ...(view && { view }), ...(options.focus && { focus: 'action' }), ...(options.condition && { condition: options.condition }), ...prefill };
}

function navigation(raw: string, snapshot: DataSnapshot): DomainDetail | null | undefined {
  const text = normalizeNavisInput(raw);
  // Promo-video talk without an open request is never navigation (other widgets share "메뉴" and "크로아상").
  const promoTalk = /홍보\s*영상|AI\s*영상|영상.*(?:만들|재료|사진|스타일|디자인|올렸|메뉴)|(?:만들|재료|사진|스타일|디자인|메뉴).*영상|영상용\s*사진|메뉴.*사진.*영상/u.test(text);
  if (!openWords.test(text)) return promoTalk && !/성과|CCTV|카메라/iu.test(text) ? null : undefined;
  // A question or a compound request that also asks to open is left to the read and compound routes.
  if (/몇|얼마|누구|\?/u.test(text) || /알려|말해|읽어|같이|둘\s*다|한\s*번에/u.test(text)) return undefined;
  // Preview-state and empty-state requests belong to the display settings.
  if (/비어\s*있|없을\s*때|상태\s*(?:로|보여)|예시\s*상태|불러오기\s*실패|사용\s*기록\s*없음/u.test(text)) return undefined;
  // A compound request that also marks a post is an action turn, not navigation.
  if (/올렸|올림|업로드/u.test(text)) return null;

  // today's promotion has no detail of its own: open the source of its first visible cell, like a press on the panel
  if (/오늘\s*할\s*홍보|홍보\s*패널|홍보\s*칸/u.test(text) && !/영상/u.test(text)) {
    const view = selectWidget(snapshot, todayFeature, defaultCondition, 'normal');
    const target = view.status === 'ready' ? view.model.cells[0]?.ref ?? view.model.tapTarget : { featureId: 'slot-coupon', view: 'send' };
    return { args: Object.fromEntries(Object.entries(target).filter(([key]) => key !== 'focus')) as AgentWireArgs };
  }
  // D-365: the 마케팅 성과 window is gone; asking to open it opens nothing (perfRoute answers that it is gone).
  if (/(?:마케팅\s*)?성과|영상별|쿠폰별|경로별/u.test(text)) return null;
  // promo video
  if ((videoWords.test(text) || /(?:레퍼런스|디자인)\s*(?:고르는|선택)/u.test(text)) && /레퍼런스|디자인|스타일/u.test(text) && /열어|화면|단계|가줘|보여|골라/u.test(text)) {
    return { args: { featureId: promoFeature, view: 'create', focus: 'action', prefill: { tab: 2 } } };
  }
  if ((videoWords.test(text) || isMaking(snapshot) && /만드는\s*중|진행\s*화면/u.test(text)) && !/CCTV|카메라/iu.test(text)) {
    const rows = promoModel(snapshot)?.videos ?? [];
    const finished = /만든\s*영상|완성|틀어|확인|진행|어디까지|만드는\s*중|됐는지/u.test(text);
    if (finished && rows.length) return { args: { featureId: promoFeature, view: 'create' } };
    return { args: { featureId: promoFeature, view: 'create', focus: 'action' } };
  }
  // customer groups; a member question stays with the members domain
  if (/손님\s*그룹|단골\s*목록|첫\s*방문\s*손님|처음\s*온\s*손님|손님\s*챙기|(?:이탈|떠날)\s*(?:위험\s*)?손님/u.test(text) && !/회원/u.test(text)) {
    const view = /챙기|쿠폰|보내진|챙겨/u.test(text) ? 'reach-out'
      : /첫\s*방문|처음\s*온/u.test(text) ? 'first-visit' : /단골/u.test(text) ? 'regular' : 'churn-risk';
    // "명단 보여줘" asks for the names; only an explicit open request goes to the screen.
    if (view === 'churn-risk' && /명단|누구/u.test(text) && !screenWords.test(text)) return null;
    return { args: view === 'reach-out' ? { featureId: groupsFeature, view, focus: 'action' } : { featureId: groupsFeature, view } };
  }
  return undefined;
}

function handoff(command: string): DetailRef | undefined {
  if (command === 'video.make') return widgetRef(promoFeature, 'create', { focus: true, prefill: { tab: 0, composing: true } });
  if (command === 'video.retry' || command === 'video.markPosted' || command === 'promo.draft.set') {
    return widgetRef(promoFeature, 'create', { focus: true });
  }
  if (command === 'coupon.sendReachOut') return widgetRef(groupsFeature, 'reach-out', { focus: true });
  return undefined;
}

function route(text: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  return videoRoute(text, snapshot, locale) ?? videoReadRoute(text) ?? groupsRoute(text, snapshot, locale) ?? perfRoute(text, snapshot) ?? todayRoute(text);
}

export const promotionDomain: DomainAdapter = {
  featureIds: [promoFeature, groupsFeature, todayFeature],
  commands: [],
  runCommands: [draftSetter as RunCommandAdapter, videoMake as RunCommandAdapter, videoRetry as RunCommandAdapter, markPosted as RunCommandAdapter, reachOut as RunCommandAdapter],
  reads: [videoReader],
  tools: [preflightTool],
  projectWidget, route, navigation, handoff,
  routePresentation(text, snapshot, locale, run) {
    const normalized = normalizeNavisInput(text);
    const overlay = run?.overlay;
    const inPromoWindow = overlay?.type === 'detail' && (overlay.stack?.at(-1)?.featureId ?? overlay.featureId) === promoFeature;
    // The outbound phrases share words with the coupon domain, which would refuse them.
    if (churnWords.test(normalized) && reachSend.test(normalized) && !/누구|명단|목록/u.test(normalized)) {
      return reachOutRoute(normalized, snapshot, locale);
    }
    if (/CCTV|시시티비|감시|카메라/iu.test(normalized)) return undefined;
    // With the promo window open, its own step words (mood, topic, memo, design, length) belong to the draft.
    if (inPromoWindow && (promoStepWords.test(normalized) || makeEstimateWords.test(normalized) || duration.test(normalized))) {
      const routed = videoRoute(normalized, snapshot, locale, true);
      if (routed) return routed;
    }
    if (run?.layer === 'marketing' && overlay?.type !== 'detail') {
      const count = /^사진\s+.+(?:개|장)만\s*(?:골라|선택|써|넣)/u.test(normalized) ? numberBefore(normalized, /개|장/u) : undefined;
      if (count !== undefined && count < MIN_PROMO_PHOTOS) return draftRoute(normalized, snapshot, locale);
      if (/^주제(?:는|를)\s+[^.!?]+으?로[.!]?$/u.test(normalized)) {
        const routed = draftRoute(normalized, snapshot, locale);
        if (routed && 'kind' in routed && routed.kind === 'clarification') return routed;
      }
    }
    // Words that belong to the promo window (and to no other widget) are read before the widget-neutral domains.
    if (videoWords.test(normalized) || /레퍼런스|ref-\d|원하는\s*느낌|말풍선|^길이\s*\d/iu.test(normalized)
      || /^메모(?:에|는)/u.test(normalized) && memoLength(normalized) > MEMO_LIMIT
      || namedPhotoChoice(normalized, promoModel(snapshot), words(locale))) {
      const routed = videoRoute(normalized, snapshot, locale);
      if (routed) return routed;
    }
    if (/메뉴.*사진|사진.*메뉴|영상용\s*사진/u.test(normalized) && !/(?:올려|등록|추가|바꿔)/u.test(normalized)) return videoReadRoute(`영상 ${normalized}`);
    if (churnWords.test(normalized) && /보낸\s*(?:적|기록|거)|간\s*적|이력/u.test(normalized) && /쿠폰|챙기/u.test(normalized)) return groupsRoute(normalized, snapshot, locale);
    if (/올렸다고\s*표시|올림\s*표시/u.test(normalized) && !/쿠폰|플레이스/u.test(normalized)) return videoRoute(normalized, snapshot, locale);
    if (/직접\s*올릴|내\s*폰\s*(?:사진|에\s*저장)/u.test(normalized)) return videoRoute(normalized, snapshot, locale);
    if (/동의\s*(?:안|않)\s*한\s*(?:손님|사람)|문자\s*못\s*보내는\s*(?:이탈\s*)?손님/u.test(normalized) && !/회원|보내\s*줘|보내줘|발송|쏴|포함|그냥/u.test(normalized)) return groupsRoute(normalized, snapshot, locale);
    if (/쿠폰.*(?:발행\s*수|성과).*(?:반영|들어갔|잡혀)|(?:반영|잡혀).*성과/u.test(normalized)) return perfRoute(normalized, snapshot);
    if (couponRanking.test(normalized) || /첫\s*방문\s*기준/u.test(normalized) && !/회원/u.test(normalized)) {
      return couponRanking.test(normalized) ? perfRoute(normalized, snapshot) : groupsRoute(normalized, snapshot, locale);
    }
    // Marketing-performance numbers share words with coupon status and members; its own phrases are read here first.
    if (/(?:쿠폰|홍보|이번\s*달).*(?:원가|할인액)|(?:원가|할인액).*(?:쿠폰|홍보)|쿠폰.*깎아|쿠폰.*몇\s*장.*(?:나가|썼)|몇\s*장\s*나가.*쿠폰|경로별.*(?:발행|사용|성과)|(?:블로그|플레이스\s*소식|클립\s*경로).*쿠폰.*(?:어떤|뭐|나갔|있어)(?!.*만들)|쿠폰마다\s*(?:발행|사용|성과)|(?:사용률|매출).*(?:어떻게|계산)|홍보\s*매출|다시\s*온\s*손님|재방문율|어떤\s*쿠폰이\s*제일\s*성과/u.test(normalized)
      && !/메뉴|재고|상품|회원|CCTV/iu.test(normalized) && !(/쿠폰/u.test(normalized) && couponWrite.test(normalized))) return perfRoute(normalized, snapshot);
    if (/오늘\s*할\s*홍보|홍보\s*칸/u.test(normalized) && !openWords.test(normalized)) return todayRoute(normalized);
    if (/올렸|올림|업로드/u.test(normalized) && postRouteOf(normalized) !== undefined) return videoRoute(normalized, snapshot, locale);
    return undefined;
  },
};
