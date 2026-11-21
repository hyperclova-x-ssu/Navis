/**
 * Marketing data commands (DATA_MODEL 10.15.4). Sends, posts and videos are mock only: nothing leaves
 * the browser and coupon use is never created (Q-35). Validation reads the normal models of the same
 * snapshot, so a command can only act on what the widgets show. Failures never change state.
 */
import { createTranslator } from '../../i18n/translator';
import { dataBundles } from '../messages';
import { resolveDataText } from '../text';
import type { HandlerContext, HandlerResult } from '../commands/handlers';
import type { DataErrorCode } from '../commands/types';
import { seedOperations } from '../db/generated/operations';
import { addDays, hourOf, isIsoDate, isTime, NOW, LEGACY_MARKETING_VALIDATION_NOW, TODAY } from '../db/time';
import type { DataSnapshot, DataTables, DataText } from '../db/types'; // N18 snapshot preflight
import { selectWidget } from '../models/select';
import { benefitProblem, benefitStored, couponBenefit, expiryCouponName, expirySmsBody } from './benefit';
import { EXTEND_DAYS, isNightHour, MIN_PROMO_PHOTOS, NIGHT_SEND_RESTRICTION, PUBLIC_ISSUE_LIMIT, SLOT_BENEFIT_IDS } from './calc';
import { CONCEPTS, consentingRegulars, DEFAULT_VIDEO_COUPON, GROUP_COUPON_DAYS, isEndedCoupon, LENGTHS, LOCALES, MOODS, newCode, REFERENCE_IDS, reminderAudience, SLOT_COUPON_ENDS } from './derive';
import { isCatalogInput, promoTablesFromCatalog } from './promo';
import type { MarketingWidgetId } from './ids';
import type { Coupon, CouponCode, CouponTarget, MarketingCommand, MarketingCommandType, MarketingModelMap, MarketingTables, MessageSend, PromoFailReason, PromoStage, PromoStageState, PromoVideo, PromoVideoInput, PromoVideoResult, SlotBenefitId, TargetReason, VideoPostRoute } from './types';

type MHandler<T extends MarketingCommandType> = (ctx: HandlerContext, command: Extract<MarketingCommand, { type: T }>) => HandlerResult;

type MarketingFailure = Extract<HandlerResult, { ok: false }>; // N18 preflight errors are widget errors.
const fail = (code: DataErrorCode, messageKey: string, field?: string, more?: { readonly reason: string; readonly details: Readonly<Record<string, unknown>> }): MarketingFailure =>
  ({ ok: false, code, messageKey, ...(field ? { field } : {}), ...(more ?? {}) });
const ok = (tables: DataTables, undoable: boolean, noticeKey?: string, params?: Readonly<Record<string, string | number>>, value?: unknown): HandlerResult =>
  ({ ok: true, tables, undoable, ...(noticeKey ? { noticeKey } : {}), ...(params ? { params } : {}), ...(value !== undefined ? { value } : {}) });
const withMarketing = (t: DataTables, change: Partial<MarketingTables>): DataTables => ({ ...t, marketing: { ...t.marketing, ...change } });
const done = () => fail('CONFLICT', 'data.error.alreadyDone');
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const ids = (value: unknown): string[] | null => (Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...new Set(value as string[])] : null);
function normal<F extends MarketingWidgetId>(ctx: HandlerContext, id: F): MarketingModelMap[F] | null {
  const view = selectWidget(ctx.snapshot, id, { kind: 'default' }, 'normal');
  return view.status === 'ready' ? (view.model as MarketingModelMap[F]) : null;
}
const isStamp = (v: unknown): v is string => typeof v === 'string' && v.length === 16 && v[10] === 'T' && isIsoDate(v.slice(0, 10)) && isTime(v.slice(11));
const activeCoupon = (m: MarketingTables, couponId: unknown): Coupon | undefined => m.coupon.find((c) => c.couponId === couponId && c.status === 'active' && !isEndedCoupon(c));
// D-326 keeps issued code terms separate from editable campaign settings.
const issuedCode = (code: CouponCode, coupon: Coupon): CouponCode => {
  if (!code.activatedAt || code.issuedTerms) return code;
  const { benefitType, benefitValue, targetMenuId, endsOn } = coupon;
  return { ...code, issuedTerms: { benefitType, benefitValue, targetMenuId, endsOn } };
};
// End D-326.
const ko = createTranslator('ko', ...dataBundles);
const CAFE_VIDEO_COUPON = seedOperations.coupons.find(row => row.status === 'active')?.couponId;

/** Shared text-coupon issue: one coupon, one `sms` code (issue = recipients), targets and mock sends. */
function textCoupon(ctx: HandlerContext, coupon: Omit<Coupon, 'couponId'>, recipients: readonly string[], reason: TargetReason, body: DataText, scheduledAt: string, idempotencyKey: string) {
  const m = ctx.tables.marketing;
  const couponId = ctx.nextId('c');
  const codeId = ctx.nextId('cc');
  const code: CouponCode = { codeId, couponId, code: newCode('sms', codeId), route: 'sms', issueCount: recipients.length, videoId: null, activatedAt: NOW };
  const sends: MessageSend[] = recipients.map((customerId) => ({ sendId: ctx.nextId('send'), customerId, couponId, kind: 'coupon', body, scheduledAt, isNight: isNightHour(hourOf(scheduledAt.slice(11))), status: 'mock', idempotencyKey }));
  const targets: CouponTarget[] = sends.map((s) => ({ couponId, codeId, customerId: s.customerId, reason, sendId: s.sendId }));
  return {
    couponId, codeId,
    tables: withMarketing(ctx.tables, { coupon: [...m.coupon, { ...coupon, couponId }], couponCode: [...m.couponCode, code], couponTarget: [...m.couponTarget, ...targets], messageSend: [...m.messageSend, ...sends] }),
  };
}
/** Recipients must be known customers with marketing consent (AC-289·290·303). */
function checkRecipients(m: MarketingTables, recipientIds: readonly string[] | null): MarketingFailure | null {
  if (!recipientIds || recipientIds.length === 0) return fail('VALIDATION', 'data.marketing.error.noRecipients', 'recipientIds');
  for (const id of recipientIds) {
    const customer = m.mktCustomer.find((c) => c.customerId === id);
    if (!customer) return fail('NOT_FOUND', 'data.error.notFound', 'recipientIds');
    if (!customer.consentSms) return fail('VALIDATION', 'data.marketing.error.noConsent', 'recipientIds');
  }
  return null;
}
const BENEFIT: Readonly<Record<SlotBenefitId, Pick<Coupon, 'benefitType' | 'benefitValue' | 'targetMenuId' | 'name'>>> = {
  'free-shot': { benefitType: 'free_item', benefitValue: 0, targetMenuId: 'opt-extra-shot', name: { key: 'data.marketing.coupon.slotFreeShot' } },
  'percent-10': { benefitType: 'percent', benefitValue: 10, targetMenuId: null, name: { key: 'data.marketing.coupon.slotPercent', params: { p: 10 } } },
  'amount-500': { benefitType: 'amount', benefitValue: 500, targetMenuId: null, name: { key: 'data.marketing.coupon.slotAmount', params: { amount: 500 } } },
};
const POST_ROUTES: readonly VideoPostRoute[] = ['clip', 'reels', 'shorts'];
const STAGES: readonly PromoStage[] = ['look', 'story', 'scenes', 'merge'];
const STAGE_STATES: readonly PromoStageState[] = ['active', 'done', 'failed'];
const FAIL_REASONS: readonly PromoFailReason[] = ['AI_UNAVAILABLE', 'AI_TIMEOUT', 'AI_BAD_OUTPUT', 'CAPTION_TOO_LONG', 'RENDER_FAILED', 'ENCODE_FAILED', 'CODE_CHECK_FAILED', 'TOOL_MISSING', 'BUSY', 'CANCELLED_BY_RESTART'];
const JOB_ID = /^pj-[0-9a-f]{12}$/;
const MEMO_LIMIT = 100;
/** A second video while one is being made (the data layer's BUSY; its fail reason is `BUSY`, LOCALES 9.4). */
const busy = () => fail('CONFLICT', 'data.marketing.error.busy', 'videoId');
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...new Set(v as string[])] : null);
const isResult = (r: PromoVideoResult | undefined): r is PromoVideoResult => !!r && typeof r === 'object' && typeof r.durationSec === 'number' && r.durationSec > 0 && !!r.music && typeof r.music.trackId === 'string'
  && typeof r.music.title === 'string' && typeof r.music.artist === 'string' && typeof r.music.licenseLabel === 'string' && typeof r.fileUrl === 'string' && r.fileUrl.length > 0 && Number.isInteger(r.sizeBytes) && r.sizeBytes >= 0 && typeof r.madeAt === 'string';
/** DATA_MODEL 10.16.9 `video.make` checks: photos ≥ 5 and all existing and in the chosen menus, moods/concepts ≥ 1 with known values, memo ≤ 100 code points, reference/length/locale values. */
function checkVideoInput(m: MarketingTables, raw: PromoVideoInput | undefined): { readonly value: PromoVideoInput } | { readonly fail: MarketingFailure } {
  const f = (code: DataErrorCode, key: string, field: string) => ({ fail: fail(code, key, field) });
  if (!raw || typeof raw !== 'object') return f('VALIDATION', 'data.marketing.error.inputInvalid', 'input');
  const menuIds = strings(raw.menuIds);
  if (!menuIds || menuIds.length === 0) return f('VALIDATION', 'data.marketing.error.menuRequired', 'menuIds');
  if (menuIds.some((id) => !m.promoMenu.some((x) => x.menuId === id))) return f('NOT_FOUND', 'data.error.notFound', 'menuIds');
  const photoIds = strings(raw.photoIds);
  if (!photoIds) return f('VALIDATION', 'data.marketing.error.photosInvalid', 'photoIds');
  for (const id of photoIds) {
    const photo = m.promoPhoto.find((p) => p.photoId === id);
    if (!photo) return f('NOT_FOUND', 'data.error.notFound', 'photoIds');
    if (!menuIds.includes(photo.menuId)) return f('VALIDATION', 'data.marketing.error.photosInvalid', 'photoIds');
  }
  if (photoIds.length < MIN_PROMO_PHOTOS) return f('VALIDATION', 'data.marketing.error.fewPhotos', 'photoIds');
  const moods = strings(raw.moods);
  if (!moods || moods.length === 0 || moods.some((x) => !MOODS.includes(x as never))) return f('VALIDATION', 'data.error.moodInvalid', 'moods');
  const concepts = strings(raw.concepts);
  if (!concepts || concepts.length === 0 || concepts.some((x) => !CONCEPTS.includes(x as never))) return f('VALIDATION', 'data.marketing.error.conceptInvalid', 'concepts');
  if (typeof raw.memo !== 'string' || Array.from(raw.memo).length > MEMO_LIMIT) return f('VALIDATION', 'data.marketing.error.memoTooLong', 'memo');
  if (!REFERENCE_IDS.includes(raw.referenceId)) return f('VALIDATION', 'data.marketing.error.referenceInvalid', 'referenceId');
  if (!LENGTHS.includes(raw.lengthSec)) return f('VALIDATION', 'data.marketing.error.lengthInvalid', 'lengthSec');
  if (!LOCALES.includes(raw.locale)) return f('VALIDATION', 'data.marketing.error.localeInvalid', 'locale');
  return { value: { menuIds, photoIds, moods: moods as PromoVideoInput['moods'], concepts: concepts as PromoVideoInput['concepts'], memo: raw.memo, referenceId: raw.referenceId, lengthSec: raw.lengthSec, locale: raw.locale } };
}

// N18 preflights run on the captured normal snapshot and share the commit checks.
export function previewVideoMake(snapshot: DataSnapshot, raw: PromoVideoInput | undefined) {
  const marketing = snapshot.tables.marketing;
  const checked = checkVideoInput(marketing, raw);
  if ('fail' in checked) return checked.fail;
  if (marketing.promoVideo.some(video => video.status === 'making')) return busy();
  return { ok: true as const, input: checked.value };
}

export function previewVideoMarkPosted(snapshot: DataSnapshot, videoId: unknown, route: unknown) {
  const marketing = snapshot.tables.marketing;
  const video = marketing.promoVideo.find(row => row.videoId === videoId);
  if (!video) return fail('NOT_FOUND', 'data.error.notFound', 'videoId');
  if (!POST_ROUTES.some(value => value === route)) return fail('VALIDATION', 'data.marketing.error.routeInvalid', 'route');
  if (video.status === 'posted') return done();
  if (video.status !== 'done') return fail('CONFLICT', 'data.marketing.error.notReady', 'videoId');
  const defaultCoupon = marketing.coupon.some(row => row.couponId === DEFAULT_VIDEO_COUPON)
    ? DEFAULT_VIDEO_COUPON
    : CAFE_VIDEO_COUPON;
  const coupon = route === 'clip' && defaultCoupon ? activeCoupon(marketing, defaultCoupon) : undefined;
  return { ok: true as const, video, couponId: coupon?.couponId, couponIssueCount: coupon ? PUBLIC_ISSUE_LIMIT : 0 };
}

export function previewReachOut(snapshot: DataSnapshot, rawRecipients: unknown) {
  const recipientIds = ids(rawRecipients);
  const problem = checkRecipients(snapshot.tables.marketing, recipientIds);
  if (problem || !recipientIds) return problem ?? done();
  const groups = selectWidget(snapshot, 'customer-groups', { kind: 'default' }, 'normal');
  const eligible = new Set(groups.status === 'ready' ? groups.model.reachOut.recipientIds : []);
  if (recipientIds.some(id => !eligible.has(id))) return fail('VALIDATION', 'data.marketing.error.notInGroup', 'recipientIds');
  return { ok: true as const, recipientIds };
}
// End N18 preflights.

export const marketingHandlers: { readonly [T in MarketingCommandType]: MHandler<T> } = {
  'coupon.sendSlot': (ctx, c) => {
    const m = ctx.tables.marketing;
    const slotIds = ids(c.slotIds);
    if (!slotIds || slotIds.length === 0) return fail('VALIDATION', 'data.marketing.error.slotRequired', 'slotIds');
    const model = normal(ctx, 'slot-coupon');
    const slots = slotIds.map((id) => model?.slots.find((s) => s.slotId === id));
    if (!model || slots.some((s) => !s)) return fail('NOT_FOUND', 'data.error.notFound', 'slotIds');
    if (slots.some((s) => s?.handled)) return done();
    if (!SLOT_BENEFIT_IDS.includes(c.benefit)) return fail('VALIDATION', 'data.marketing.error.benefitInvalid', 'benefit');
    const recipientIds = ids(c.recipientIds);
    const bad = checkRecipients(m, recipientIds);
    if (bad || !recipientIds) return bad ?? done();
    const sendAt = c.sendAt ?? NOW;
    if (!isStamp(sendAt)) return fail('VALIDATION', 'data.error.timeInvalid', 'send_at');
    if (sendAt < LEGACY_MARKETING_VALIDATION_NOW) return fail('VALIDATION', 'data.marketing.error.sendAtPast', 'send_at');
    if (NIGHT_SEND_RESTRICTION && isNightHour(hourOf(sendAt.slice(11))) && recipientIds.some((id) => !m.mktCustomer.find((x) => x.customerId === id)?.consentNight)) return fail('VALIDATION', 'data.marketing.error.nightConsent', 'send_at');
    const edits = text(c.messageEdits);
    const issued = textCoupon(ctx, {
      ...BENEFIT[c.benefit], validHours: slots.map((s) => ({ weekday: s!.weekday, startHour: s!.startHour, endHour: s!.endHour })), startsOn: TODAY, endsOn: SLOT_COUPON_ENDS,
      status: 'active', origin: 'slot', originRef: { slotIds }, maxDiscountRate: null, createdAt: NOW,
    }, recipientIds, 'slot-regular', edits ? { raw: edits } : model.message.bodies[c.benefit], sendAt, c.idempotencyKey);
    return ok(issued.tables, false, 'data.notice.sent', { count: recipientIds.length }, { couponId: issued.couponId, codeId: issued.codeId, issued: recipientIds.length });
  },
  'coupon.createExpiry': (ctx, c) => {
    const m = ctx.tables.marketing;
    const model = normal(ctx, 'expiry-coupon');
    const item = model?.items.find((i) => i.itemId === c.itemId);
    if (!model || !item) return fail('VALIDATION', 'data.marketing.error.noExpiryStock', 'itemId');
    // The same sell-today coupon cannot be made twice for one item on one day (a replay with the same key never gets here: it returns the first receipt).
    if (item.handled) return fail('CONFLICT', 'data.marketing.error.expiryAlreadyMade', 'itemId');
    const problem = benefitProblem(c.benefit, item.price, item.unitCost);
    if (problem) return fail('VALIDATION', problem === 'kind' ? 'data.marketing.error.benefitInvalid' : `data.marketing.error.${problem}`, 'benefit');
    if (c.route !== 'sms' && c.route !== 'place_news') return fail('VALIDATION', 'data.marketing.error.routeInvalid', 'route');
    const benefit = { kind: c.benefit.kind, value: c.benefit.value };
    const coupon: Omit<Coupon, 'couponId'> = {
      name: expiryCouponName(item.nameKey, benefit), ...benefitStored(benefit), targetMenuId: item.menuId,
      validHours: null, startsOn: TODAY, endsOn: TODAY, status: 'active', origin: 'expiry', originRef: { itemId: item.itemId }, maxDiscountRate: item.maxRatePercent, createdAt: NOW,
    };
    if (c.route === 'sms') {
      const recipients = consentingRegulars(m).map((s) => s.customer.customerId);
      if (recipients.length === 0) return fail('VALIDATION', 'data.marketing.error.noRecipients', 'route');
      const issued = textCoupon(ctx, coupon, recipients, 'regular', expirySmsBody(item.nameKey, benefit), NOW, c.idempotencyKey);
      return ok(issued.tables, false, 'data.marketing.notice.couponCreated', undefined, { couponId: issued.couponId, codeId: issued.codeId, route: 'sms', issued: recipients.length, sent: true });
    }
    const couponId = ctx.nextId('c'), codeId = ctx.nextId('cc');
    const code: CouponCode = { codeId, couponId, code: newCode('place_news', codeId), route: 'place_news', issueCount: PUBLIC_ISSUE_LIMIT, videoId: null, activatedAt: null };
    // D-326 the unsent Place News draft is reversible. The SMS branch remains a send.
    return ok(withMarketing(ctx.tables, { coupon: [...m.coupon, { ...coupon, couponId }], couponCode: [...m.couponCode, code] }), true, 'data.marketing.notice.couponCreated', undefined,
      { couponId, codeId, route: 'place_news', issued: 0, code: code.code, sent: false });
  },
  'coupon.markPosted': (ctx, c) => {
    const m = ctx.tables.marketing;
    const code = m.couponCode.find((x) => x.codeId === c.codeId);
    if (!code) return fail('NOT_FOUND', 'data.error.notFound', 'codeId');
    if (code.route === 'sms') return fail('VALIDATION', 'data.marketing.error.notPublic', 'codeId');
    if (code.activatedAt !== null) return done();
    // N16 checks the same running status as the posted attestation card.
    const coupon = activeCoupon(m, code.couponId);
    if (!coupon) return fail('CONFLICT', 'data.marketing.error.couponNotActive', 'codeId');
    return ok(withMarketing(ctx.tables, { couponCode: m.couponCode.map((x) => (x === code ? { ...x, activatedAt: NOW } : x)) }), false, 'data.marketing.notice.counting', undefined, { codeId: code.codeId, issued: code.issueCount });
  },
  'coupon.sendReachOut': (ctx, c) => {
    const preview = previewReachOut(ctx.snapshot, c.recipientIds); // N18
    if (!preview.ok) return preview;
    const { recipientIds } = preview;
    const edits = text(c.messageEdits);
    const issued = textCoupon(ctx, {
      name: { key: 'data.marketing.coupon.thanksBackGroup' }, benefitType: 'amount', benefitValue: 1_000, targetMenuId: null, validHours: null, startsOn: TODAY, endsOn: addDays(TODAY, GROUP_COUPON_DAYS),
      status: 'active', origin: 'group', originRef: null, maxDiscountRate: null, createdAt: NOW,
    }, recipientIds, 'churn-risk', edits ? { raw: edits } : { key: 'data.marketing.sms.reachOut' }, NOW, c.idempotencyKey);
    return ok(issued.tables, false, 'data.notice.sent', { count: recipientIds.length }, { couponId: issued.couponId, codeId: issued.codeId, issued: recipientIds.length });
  },
  'coupon.notifyEnding': (ctx, c) => {
    const m = ctx.tables.marketing;
    const coupon = activeCoupon(m, c.couponId);
    if (!coupon) return m.coupon.some((x) => x.couponId === c.couponId) ? fail('CONFLICT', 'data.marketing.error.couponNotActive', 'couponId') : fail('NOT_FOUND', 'data.error.notFound', 'couponId');
    // The audience is the coupon's text targets who still consent (the same list the reminder form counts). A public-only coupon has none: nobody can be reached, so nothing is recorded.
    const audience = reminderAudience(m, coupon.couponId);
    if (audience.length === 0) return fail('VALIDATION', 'data.marketing.error.noReminderRecipients', 'couponId', { reason: 'NO_REMINDER_RECIPIENTS', details: { couponId: coupon.couponId, targets: m.couponTarget.filter((x) => x.couponId === coupon.couponId).length, recipients: 0 } });
    const sends: MessageSend[] = audience.map((customerId) => ({ sendId: ctx.nextId('send'), customerId, couponId: coupon.couponId, kind: 'reminder', body: { key: 'data.marketing.sms.reminder' }, scheduledAt: NOW, isNight: false, status: 'mock', idempotencyKey: c.idempotencyKey }));
    const reminderId = ctx.nextId('rem');
    return ok(withMarketing(ctx.tables, { messageSend: [...m.messageSend, ...sends], couponReminder: [...m.couponReminder, { reminderId, couponId: coupon.couponId, sentAt: NOW, recipients: sends.length, idempotencyKey: c.idempotencyKey }] }),
      false, 'data.notice.sent', { count: sends.length }, { reminderId, recipients: sends.length });
  },
  'coupon.pause': (ctx, c) => {
    const m = ctx.tables.marketing;
    const coupon = m.coupon.find((x) => x.couponId === c.couponId);
    if (!coupon) return fail('NOT_FOUND', 'data.error.notFound', 'couponId');
    if (coupon.status !== 'active' || isEndedCoupon(coupon)) return done();
    return ok(withMarketing(ctx.tables, { coupon: m.coupon.map((x) => (x === coupon ? { ...x, status: 'paused' } : x)) }), true, 'data.marketing.notice.paused', { name: resolveDataText(ko.t, coupon.name) }, { couponId: coupon.couponId, name: coupon.name });
  },
  'coupon.resume': (ctx, c) => {
    const m = ctx.tables.marketing;
    const coupon = m.coupon.find((x) => x.couponId === c.couponId);
    if (!coupon) return fail('NOT_FOUND', 'data.error.notFound', 'couponId');
    if (coupon.status !== 'paused' || isEndedCoupon(coupon)) return done();
    return ok(withMarketing(ctx.tables, { coupon: m.coupon.map((x) => (x === coupon ? { ...x, status: 'active' } : x)) }), true, 'data.marketing.notice.resumed', undefined, { couponId: coupon.couponId, name: coupon.name });
  },
  'coupon.extend': (ctx, c) => {
    const m = ctx.tables.marketing;
    const coupon = m.coupon.find((x) => x.couponId === c.couponId);
    if (!coupon) return fail('NOT_FOUND', 'data.error.notFound', 'couponId');
    if (isEndedCoupon(coupon)) return done();
    const endsOn = addDays(coupon.endsOn, EXTEND_DAYS);
    return ok(withMarketing(ctx.tables, { coupon: m.coupon.map((x) => (x === coupon ? { ...x, endsOn } : x)) }), true, 'data.marketing.notice.extended', { days: EXTEND_DAYS }, { couponId: coupon.couponId, name: coupon.name, endsOn });
  },
  // D-326 coupon lifecycle.
  'coupon.update': (ctx, c) => {
    const m = ctx.tables.marketing;
    const coupon = m.coupon.find(row => row.couponId === c.couponId);
    if (!coupon) return fail('NOT_FOUND', 'data.error.notFound', 'couponId');
    if (isEndedCoupon(coupon)) return fail('CONFLICT', 'data.marketing.error.couponNotActive', 'couponId');
    const codes = m.couponCode.filter(row => row.couponId === coupon.couponId && row.route === 'place_news');
    const draft = codes.find(row => !row.activatedAt);
    const publication = codes.find(row => row.activatedAt && !row.unpublishedAt);
    const benefitValue = c.benefitValue === undefined ? coupon.benefitValue : c.benefitValue;
    const issueLimit = coupon.futureIssueCount ?? draft?.issueCount ?? publication?.issueCount ?? PUBLIC_ISSUE_LIMIT;
    const quantity = c.quantity === undefined ? issueLimit : c.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1) return fail('VALIDATION', 'data.marketing.error.quantityInvalid', 'quantity');
    const value = { couponId: coupon.couponId, benefitValue, quantity };
    if (benefitValue === coupon.benefitValue && quantity === issueLimit) return ok(ctx.tables, false, undefined, undefined, value);
    let name = coupon.name;
    if (benefitValue !== coupon.benefitValue) {
      const benefit = couponBenefit({ ...coupon, benefitValue });
      if (!benefit || !Number.isSafeInteger(benefitValue) || benefitValue < 1 || benefit.kind === 'percent' && benefitValue > 100) {
        return fail('VALIDATION', 'data.marketing.error.benefitInvalid', 'benefitValue');
      }
      if (coupon.origin === 'expiry') {
        const item = normal(ctx, 'expiry-coupon')?.items.find(row => row.itemId === coupon.originRef?.itemId);
        if (!item) return fail('VALIDATION', 'data.marketing.error.noExpiryStock', 'benefitValue');
        const problem = benefitProblem(benefit, item.price, item.unitCost);
        if (problem) return fail('VALIDATION', problem === 'kind' ? 'data.marketing.error.benefitInvalid' : `data.marketing.error.${problem}`, 'benefitValue');
        name = expiryCouponName(item.nameKey, benefit);
      }
    }
    const nextCodes = m.couponCode.map(row => {
      if (row === draft) return { ...row, issueCount: quantity };
      if (row.couponId !== coupon.couponId) return row;
      return issuedCode(row, coupon);
    });
    if (!draft && publication) {
      const codeId = ctx.nextId('cc');
      nextCodes.push({ codeId, couponId: coupon.couponId, code: newCode('place_news', codeId), route: 'place_news',
        issueCount: quantity, videoId: null, activatedAt: null });
    }
    const updated = { ...coupon, name, benefitValue, ...(c.quantity === undefined ? {} : { futureIssueCount: quantity }) };
    return ok(withMarketing(ctx.tables, { coupon: m.coupon.map(row => row === coupon ? updated : row),
      couponCode: nextCodes }), true, 'data.management.notice.saved', undefined, value);
  },
  'coupon.endEarly': (ctx, c) => {
    const m = ctx.tables.marketing;
    const coupon = m.coupon.find(row => row.couponId === c.couponId);
    if (!coupon) return fail('NOT_FOUND', 'data.error.notFound', 'couponId');
    if (isEndedCoupon(coupon)) return done();
    return ok(withMarketing(ctx.tables, {
      coupon: m.coupon.map(row => row === coupon ? { ...row, status: 'ended', endsOn: TODAY } : row),
      couponCode: m.couponCode.map(row => row.couponId === coupon.couponId ? issuedCode(row, coupon) : row),
    }), true, 'data.marketing.notice.couponEnded', undefined, { couponId: coupon.couponId });
  },
  'coupon.unpublish': (ctx, c) => {
    const m = ctx.tables.marketing;
    const code = m.couponCode.find(row => row.codeId === c.codeId);
    if (!code) return fail('NOT_FOUND', 'data.error.notFound', 'codeId');
    if (code.route !== 'place_news' || !code.activatedAt || code.unpublishedAt) return done();
    const coupon = m.coupon.find(row => row.couponId === code.couponId);
    if (!coupon) return fail('NOT_FOUND', 'data.error.notFound', 'couponId');
    return ok(withMarketing(ctx.tables, { couponCode: m.couponCode.map(row =>
      row === code ? { ...issuedCode(row, coupon), unpublishedAt: NOW } : row) }),
    true, 'data.marketing.notice.couponUnpublished', undefined, { couponId: coupon.couponId, codeId: code.codeId });
  },
  // End D-326 coupon lifecycle.
  'promo.syncCatalog': (ctx, c) => {
    if (!isCatalogInput(c.catalog)) return fail('VALIDATION', 'data.marketing.error.catalogInvalid', 'catalog');
    const m = ctx.tables.marketing;
    const next = promoTablesFromCatalog(c.catalog);
    if (m.promoStore[0]?.sourceId === 'cafe') {
      const menuIds = new Set(m.promoMenu.map(row => row.menuId));
      // Refresh the cafe storefront only with cafe assets.
      const promoStore = c.catalog.sourceId === 'cafe' ? next.promoStore : m.promoStore;
      const promoPhoto = next.promoPhoto.filter(photo => menuIds.has(photo.menuId));
      if (JSON.stringify(promoPhoto) === JSON.stringify(m.promoPhoto) &&
          JSON.stringify(promoStore) === JSON.stringify(m.promoStore)) return ok(ctx.tables, false);
      return ok(withMarketing(ctx.tables, { promoStore, promoPhoto }), false);
    }
    // Same content → the very same snapshot (no revision, the widget does not flicker; AC-324 sync on every first surface).
    if (JSON.stringify(next) === JSON.stringify({ promoStore: m.promoStore, promoMenu: m.promoMenu, promoPhoto: m.promoPhoto })) return ok(ctx.tables, false);
    return ok(withMarketing(ctx.tables, next), false);
  },
  'video.make': (ctx, c) => {
    const m = ctx.tables.marketing;
    const preview = previewVideoMake(ctx.snapshot, c.input); // N18
    if (!preview.ok) return preview;
    const { input } = preview;
    const videoId = ctx.nextId('pv');
    const row: PromoVideo = {
      videoId, jobId: null, input, status: 'making', stage: 'look', stageState: 'active', lookCount: input.photoIds.length, failReason: null, result: null,
      postedRoute: null, postedAt: null, createdAt: NOW, retryCount: 0,
    };
    return ok(withMarketing(ctx.tables, { promoVideo: [...m.promoVideo, row] }), false, 'data.marketing.notice.videoStarted', { videoId }, { videoId });
  },
  'video.attachJob': (ctx, c) => {
    const m = ctx.tables.marketing;
    const video = m.promoVideo.find((v) => v.videoId === c.videoId);
    if (!video) return fail('NOT_FOUND', 'data.error.notFound', 'videoId');
    if (typeof c.jobId !== 'string' || !JOB_ID.test(c.jobId)) return fail('VALIDATION', 'data.marketing.error.jobInvalid', 'jobId');
    if (video.status !== 'making') return done();
    if (video.jobId === c.jobId) return ok(ctx.tables, false);
    if (video.jobId !== null) return done();
    return ok(withMarketing(ctx.tables, { promoVideo: m.promoVideo.map((v) => (v === video ? { ...v, jobId: c.jobId } : v)) }), false);
  },
  'video.progress': (ctx, c) => {
    const m = ctx.tables.marketing;
    const video = m.promoVideo.find((v) => v.videoId === c.videoId);
    if (!video) return fail('NOT_FOUND', 'data.error.notFound', 'videoId');
    if (!STAGES.includes(c.stage)) return fail('VALIDATION', 'data.marketing.error.stageInvalid', 'stage');
    if (!STAGE_STATES.includes(c.stageState)) return fail('VALIDATION', 'data.marketing.error.stageInvalid', 'stageState');
    if (c.lookCount !== undefined && !(Number.isInteger(c.lookCount) && c.lookCount >= 0)) return fail('VALIDATION', 'data.marketing.error.stageInvalid', 'lookCount');
    if (video.status !== 'making') return done();
    // Steps only go forward: a later stage, or a later state of the same stage (active → done|failed).
    const was = video.stage === null ? -1 : STAGES.indexOf(video.stage), now = STAGES.indexOf(c.stage);
    if (now < was || (now === was && video.stageState !== 'active' && c.stageState === 'active')) return fail('CONFLICT', 'data.marketing.error.stageBackward', 'stage');
    const lookCount = c.lookCount ?? video.lookCount;
    if (video.stage === c.stage && video.stageState === c.stageState && video.lookCount === lookCount) return ok(ctx.tables, false);
    return ok(withMarketing(ctx.tables, { promoVideo: m.promoVideo.map((v) => (v === video ? { ...v, stage: c.stage, stageState: c.stageState, lookCount } : v)) }), false);
  },
  'video.settle': (ctx, c) => {
    const m = ctx.tables.marketing;
    const video = m.promoVideo.find((v) => v.videoId === c.videoId);
    if (!video) return fail('NOT_FOUND', 'data.error.notFound', 'videoId');
    const outcome = c.outcome;
    if (!outcome || (outcome.kind === 'done' ? !isResult(outcome.result) : outcome.kind !== 'failed' || !FAIL_REASONS.includes(outcome.reason))) return fail('VALIDATION', 'data.marketing.error.outcomeInvalid', 'outcome');
    if (video.status !== 'making') return done();
    // The number of posted videos never changes here (AC-336·342).
    const next: PromoVideo = outcome.kind === 'done'
      ? { ...video, status: 'done', stage: 'merge', stageState: 'done', failReason: null, result: outcome.result }
      : { ...video, status: 'failed', stageState: 'failed', failReason: outcome.reason, result: null };
    return ok(withMarketing(ctx.tables, { promoVideo: m.promoVideo.map((v) => (v === video ? next : v)) }), false);
  },
  'video.retry': (ctx, c) => {
    const m = ctx.tables.marketing;
    const video = m.promoVideo.find((v) => v.videoId === c.videoId);
    if (!video) return fail('NOT_FOUND', 'data.error.notFound', 'videoId');
    if (video.status !== 'failed') return done();
    if (m.promoVideo.some((v) => v.status === 'making')) return busy();
    // Same input, same row: choices, memo, reference and length stay; the job id arrives from API-24 (`video.attachJob`).
    const next: PromoVideo = { ...video, status: 'making', jobId: null, stage: 'look', stageState: 'active', lookCount: video.input.photoIds.length, failReason: null, result: null, retryCount: video.retryCount + 1 };
    return ok(withMarketing(ctx.tables, { promoVideo: m.promoVideo.map((v) => (v === video ? next : v)) }), false, undefined, undefined, { videoId: video.videoId });
  },
  'video.save': (ctx, c) => {
    const video = ctx.tables.marketing.promoVideo.find((v) => v.videoId === c.videoId);
    if (!video) return fail('NOT_FOUND', 'data.error.notFound', 'videoId');
    if (video.status !== 'done' && video.status !== 'posted') return fail('CONFLICT', 'data.marketing.error.notReady', 'videoId');
    // The browser download saves the real file; the data does not change (AC-337).
    return ok(ctx.tables, false, 'data.marketing.notice.saveStarted');
  },
  'video.markPosted': (ctx, c) => {
    const m = ctx.tables.marketing;
    const preview = previewVideoMarkPosted(ctx.snapshot, c.videoId, c.route); // N18
    if (!preview.ok) return preview;
    const { video, couponId, couponIssueCount } = preview;
    // Only a clip post adds the clip coupon code (Q-45, AC-346·347); reels and shorts count the video only.
    const codeId = couponId ? ctx.nextId('cc') : null;
    const code: CouponCode | null = couponId && codeId ? { codeId, couponId, code: newCode('clip', codeId), route: 'clip', issueCount: couponIssueCount, videoId: video.videoId, activatedAt: NOW } : null;
    return ok(withMarketing(ctx.tables, {
      promoVideo: m.promoVideo.map((v) => (v === video ? { ...v, status: 'posted', postedRoute: c.route, postedAt: NOW } : v)),
      couponCode: code ? [...m.couponCode, code] : m.couponCode,
    }), false, code ? 'data.marketing.notice.counting' : 'data.marketing.notice.videoMarkedPosted', undefined, { videoId: video.videoId, route: c.route });
  },
};

/** Marketing commands that must carry an idempotency key (DATA_MODEL 10.15.4 ‘한 번만 키: 예’). */
export const MARKETING_ONCE_COMMANDS: readonly MarketingCommandType[] = ['coupon.sendSlot', 'coupon.createExpiry', 'coupon.markPosted', 'coupon.sendReachOut', 'coupon.notifyEnding', 'video.make', 'video.retry', 'video.markPosted'];
