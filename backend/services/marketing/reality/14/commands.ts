import { randomBytes, randomUUID } from 'node:crypto';
import { advertisingSmsText, smsMessageType } from '../../sms-text.ts';
import { configuredSensSettings, liveAdvertisingText, type SensSettings } from '../15/sens-settings.ts';
import {
  benefitKinds, benefitOf, benefitProblem, benefitStored, couponCode, expiryEconomics, isNightHour, maxRatePercent,
  type Benefit, type BenefitType,
} from './benefit.ts';
import type { CouponSources, Recipient } from './clients.ts';
import {
  bumpRevision, codesOf, couponSources, effectiveStatus, endingSoonDays, lockCode, lockCoupon, slotCouponEnds,
  type CodeRow, type CouponRow, type IssuedTerms, type Scope,
} from './records.ts';
import {
  addDays, checkRevision, choice, confirmation, conflict, fingerprint, integer, invalid, isoDate, missing, object,
  revisionAggregate, text, unavailable, uuid,
} from './wire.ts';

export type Ctx = Scope & { sources: CouponSources; smsSettings?: (storeId: string) => Promise<SensSettings | null> };
export type Receipt = {
  resourceId: string; revision: number; receiptId: string; changed: boolean; affectedSources: readonly string[];
  undoUntil?: string; [extra: string]: unknown;
};
type InverseOp =
  | { op: 'coupon'; couponId: string; revision: number; restore: Pick<CouponRow, 'name' | 'benefitValue' | 'endsOn' | 'status' | 'futureIssueCount' | 'revision'> }
  | { op: 'code'; codeId: string; revision: number; restore: Pick<CodeRow, 'issueCount' | 'unpublishedAt' | 'issuedTerms' | 'revision'> }
  | { op: 'dropCode'; codeId: string; revision: number }
  | { op: 'dropCoupon'; couponId: string; revision: number };
type Outcome = { resourceId: string; revision: number; changed: boolean; inverse?: InverseOp[]; extra?: Record<string, unknown> };
type Event = { type: 'marketing.coupon_code_changed.v1' | 'marketing.message_queued.v1'; aggregateId: string; payload: Record<string, unknown> };

export const publicIssueLimit = 10;
const extendDays = 7;
const undoMs = 6000;
const maxRecipients = 500;
const slotBenefits = {
  'free-shot': { benefitType: 'free_item' as BenefitType, benefitValue: 0, targetRef: 'opt-extra-shot', name: '빈 시간 샷 추가 무료' },
  'percent-10': { benefitType: 'percent' as BenefitType, benefitValue: 10, targetRef: null, name: '빈 시간 10% 할인' },
  'amount-500': { benefitType: 'amount' as BenefitType, benefitValue: 500, targetRef: null, name: '빈 시간 500원 할인' },
};
const slotIds = Object.keys(slotBenefits) as (keyof typeof slotBenefits)[];

const won = (value: number) => value.toLocaleString('en-US');
function objectParticle(word: string) {
  const last = word.trim().at(-1) ?? '';
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return '를';
  return code % 28 === 0 ? '를' : '을';
}
const benefitText = (benefit: Benefit) => benefit.kind === 'percent' ? `${benefit.value}% 할인`
  : benefit.kind === 'amount' ? `${won(benefit.value)}원 할인` : `지정 가격 ${won(benefit.value)}원`;
const expiryName = (item: string, benefit: Benefit) => `${item} 오늘만 ${benefit.kind === 'percent' ? `${benefit.value}%` : benefitText(benefit)}`;
function expirySms(item: string, benefit: Benefit) {
  const tail = '오늘 마감 전까지 쓸 수 있어요.';
  const object = `${item}${objectParticle(item)}`;
  if (benefit.kind === 'percent') return `${object} 오늘만 ${benefit.value}% 할인해요. ${tail}`;
  if (benefit.kind === 'amount') return `${object} 오늘만 ${won(benefit.value)}원 할인해요. ${tail}`;
  return `${object} 오늘만 ${won(benefit.value)}원에 드려요. ${tail}`;
}
export function postText(item: string, benefit: Benefit, code: string) {
  const what = benefit.kind === 'percent' ? `${item} ${benefit.value}% 할인` : benefit.kind === 'amount'
    ? `${item} ${won(benefit.value)}원 할인` : `${item} ${won(benefit.value)}원`;
  return `오늘만! ${what}. 계산할 때 쿠폰 코드를 보여 주세요: ${code}`;
}
function slotSms(slotName: string, from: string, to: string, until: string) {
  const md = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
  const benefit = slotName.replace('빈 시간 ', '');
  return `${md(from)}~${md(to)} 한산한 시간에 오시면 ${benefit}${benefit.endsWith('무료') ? '예요' : '해 드려요'}. ${md(until)}까지 쓸 수 있어요.`;
}
const reminderSms = '받으신 쿠폰이 곧 끝나요. 끝나기 전에 들러 주세요.';

/** D-331: from 21:00 to 08:00 the default send moves to the next 08:00. */
function scheduleSend(ctx: Ctx, sendAt: unknown) {
  if (sendAt !== undefined) {
    if (typeof sendAt !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d$/.test(sendAt)) throw invalid('sendAt', 'INVALID_TIME');
    isoDate(sendAt.slice(0, 10), 'sendAt');
    if (sendAt < `${ctx.clock.date}T${ctx.clock.time}`) throw invalid('sendAt', 'SEND_AT_PAST');
    if (isNightHour(Number(sendAt.slice(11, 13)))) throw invalid('sendAt', 'NIGHT_SEND_NOT_ALLOWED');
    return { local: sendAt, night: false };
  }
  if (!isNightHour(ctx.clock.hour)) return { local: `${ctx.clock.date}T${ctx.clock.time}`, night: false };
  const day = ctx.clock.hour >= 21 ? addDays(ctx.clock.date, 1) : ctx.clock.date;
  return { local: `${day}T08:00`, night: true };
}
/** Store-local wall time to an instant using the store offset observed now (Korea has no DST). */
function instant(ctx: Ctx, local: string) {
  const offsetMs = Date.parse(`${ctx.clock.date}T${ctx.clock.time}:00Z`) - Math.floor(ctx.now.getTime() / 60_000) * 60_000;
  return new Date(Date.parse(`${local}:00Z`) - offsetMs);
}

async function newCode(ctx: Ctx, prefix: 'NV' | 'PN' | 'SM') {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = couponCode(prefix, randomBytes(8));
    const { rowCount } = await ctx.db.query('SELECT 1 FROM marketing.coupon_code WHERE store_id = $1 AND code = $2', [ctx.storeId, code]);
    if (!rowCount) return code;
  }
  throw new Error('Coupon code space exhausted');
}

async function insertCoupon(ctx: Ctx, row: Omit<CouponRow, 'couponId' | 'createdAt' | 'revision' | 'businessDate'>) {
  const couponId = randomUUID();
  try {
    await ctx.db.query(`INSERT INTO marketing.coupon (store_id, coupon_id, origin, name, benefit_type, benefit_value, target_ref,
        valid_hours, starts_on, ends_on, status, origin_ref, basis, future_issue_count, lot_key, business_date, created_at, revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1)`,
    [ctx.storeId, couponId, row.origin, row.name, row.benefitType, row.benefitValue, row.targetRef,
      row.validHours === null ? null : JSON.stringify(row.validHours), row.startsOn, row.endsOn, row.status,
      JSON.stringify(row.originRef), row.basis === null ? null : JSON.stringify(row.basis), row.futureIssueCount, row.lotKey,
      ctx.clock.businessDate, ctx.now]);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw conflict('EXPIRY_ALREADY_MADE', 'itemId');
    throw error;
  }
  return couponId;
}

async function insertCode(ctx: Ctx, couponId: string, route: CodeRow['route'], issueCount: number, activated: boolean) {
  const codeId = randomUUID();
  const code = await newCode(ctx, route === 'sms' ? 'SM' : 'NV');
  await ctx.db.query(`INSERT INTO marketing.coupon_code (store_id, code_id, coupon_id, code, route, issue_count, activated_at,
      created_at, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)`,
  [ctx.storeId, codeId, couponId, code, route, issueCount, activated ? ctx.now : null, ctx.now]);
  return { codeId, code };
}

/** Queue one message per consenting recipient for the approved SENS worker. Bodies and phones never enter events. */
async function queueMessages(ctx: Ctx, couponId: string, codeId: string | null, recipients: readonly string[],
  kind: 'coupon' | 'reminder', body: string, reason: 'slot-regular' | 'regular' | 'churn-risk' | null, sendAt: unknown, code?: string) {
  const schedule = scheduleSend(ctx, sendAt);
  const scheduledAt = instant(ctx, schedule.local);
  let message = advertisingSmsText(body);
  if (ctx.smsSettings) {
    const settings = await ctx.smsSettings(ctx.storeId);
    if (!configuredSensSettings(settings)) throw conflict('SMS_SETTINGS_REQUIRED', 'recipientIds');
    message = liveAdvertisingText(code ? body + '\n쿠폰 코드: ' + code : body, settings);
    if (message.length > 1000 || !smsMessageType(message)) throw invalid('body', 'SMS_CONTENT_UNSUPPORTED');
  }
  const ids: string[] = [];
  for (const customerId of recipients) {
    const messageId = randomUUID();
    ids.push(messageId);
    await ctx.db.query(`INSERT INTO marketing.coupon_message (store_id, message_id, coupon_id, customer_id, kind, body, scheduled_at,
        is_night, status, created_at, dispatch_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10)`,
    [ctx.storeId, messageId, couponId, customerId, kind, message, scheduledAt, schedule.night, ctx.now,
      ctx.smsSettings ? 'ready' : null]);
    if (codeId && reason) {
      await ctx.db.query(`INSERT INTO marketing.coupon_target (store_id, code_id, customer_id, coupon_id, reason, message_id)
        VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.storeId, codeId, customerId, couponId, reason, messageId]);
    }
  }
  return { messageIds: ids, scheduledAt: scheduledAt.toISOString(), scheduledLocal: schedule.local, night: schedule.night };
}

/** Live consent at commit (B05). A recipient without marketing consent refuses the whole send. */
async function consentedRecipients(ctx: Ctx, raw: unknown) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > maxRecipients) throw invalid('recipientIds', 'NO_RECIPIENTS');
  const ids = [...new Set(raw.map((value, index) => uuid(value, `recipientIds.${index}`)))];
  const found = await ctx.sources.recipients(ctx, ids);
  if (!found) throw unavailable('CUSTOMER_UNAVAILABLE', 'recipientIds');
  for (const id of ids) {
    const row = found.get(id);
    if (!row) throw missing('RECIPIENT_NOT_FOUND', 'recipientIds');
    if (!row.marketingAllowed) throw invalid('recipientIds', 'NO_CONSENT');
  }
  return ids;
}

function issuedTerms(coupon: CouponRow): IssuedTerms {
  return { benefitType: coupon.benefitType, benefitValue: coupon.benefitValue, targetRef: coupon.targetRef, endsOn: coupon.endsOn };
}

function codeEvent(code: Pick<CodeRow, 'codeId' | 'couponId' | 'code' | 'route' | 'issueCount'>, revision: number, operation: string,
  extra: Record<string, unknown> = {}): Event {
  return { type: 'marketing.coupon_code_changed.v1', aggregateId: revisionAggregate(code.codeId, revision),
    payload: { codeId: code.codeId, couponId: code.couponId, code: code.code, route: code.route, issueCount: code.issueCount,
      revision, operation, ...extra } };
}

async function slotIssue(ctx: Ctx, body: unknown, events: Event[]): Promise<Outcome> {
  const input = object(body, ['slots', 'benefitId', 'recipientIds', 'body', 'sendAt']);
  const benefitId = choice(input.benefitId, slotIds, 'benefitId', 'BENEFIT_INVALID');
  if (!Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > 21) throw invalid('slots', 'SLOT_REQUIRED');
  const slots = input.slots.map((raw, index) => {
    const slot = object(raw, ['slotId', 'date', 'startHour', 'endHour'], `slots.${index}`);
    const date = isoDate(slot.date, `slots.${index}.date`);
    const startHour = integer(slot.startHour, `slots.${index}.startHour`, 0, 23);
    const endHour = integer(slot.endHour, `slots.${index}.endHour`, startHour + 1, 24);
    if (slot.slotId !== `slot-${date}-${startHour}`) throw invalid(`slots.${index}.slotId`, 'SLOT_INVALID');
    if (date < ctx.clock.businessDate) throw invalid(`slots.${index}.date`, 'SLOT_PAST');
    const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    return { slotId: slot.slotId, date, startHour, endHour, weekday };
  });
  const ids = slots.map(slot => slot.slotId);
  if (new Set(ids).size !== ids.length) throw invalid('slots', 'SLOT_DUPLICATE');
  const { rows: handled } = await ctx.db.query<{ couponId: string }>(`SELECT coupon_id AS "couponId" FROM marketing.coupon
    WHERE store_id = $1 AND origin = 'slot' AND status <> 'ended' AND origin_ref->'slotIds' ?| $2::text[]`, [ctx.storeId, ids]);
  if (handled.length) throw conflict('SLOT_ALREADY_HANDLED', 'slots', { couponIds: handled.map(row => row.couponId) });
  const recipients = await consentedRecipients(ctx, input.recipientIds);
  const benefit = slotBenefits[benefitId];
  const dates = slots.map(slot => slot.date).sort();
  const endsOn = slotCouponEnds(ctx.clock.businessDate);
  const message = input.body === undefined ? slotSms(benefit.name, dates[0], dates.at(-1)!, endsOn) : text(input.body, 'body', 500);
  const couponId = await insertCoupon(ctx, {
    origin: 'slot', name: benefit.name, benefitType: benefit.benefitType, benefitValue: benefit.benefitValue, targetRef: benefit.targetRef,
    validHours: slots.map(({ weekday, startHour, endHour }) => ({ weekday, startHour, endHour })), startsOn: ctx.clock.businessDate,
    endsOn, status: 'active', originRef: { slotIds: ids, benefitId }, basis: null, futureIssueCount: null, lotKey: null,
  });
  const { codeId, code } = await insertCode(ctx, couponId, 'sms', recipients.length, true);
  const queued = await queueMessages(ctx, couponId, codeId, recipients, 'coupon', message, 'slot-regular', input.sendAt, code);
  events.push(codeEvent({ codeId, couponId, code, route: 'sms', issueCount: recipients.length }, 1, 'issued'),
    { type: 'marketing.message_queued.v1', aggregateId: couponId,
      payload: { couponId, codeId, kind: 'coupon', count: recipients.length, scheduledAt: queued.scheduledAt } });
  return { resourceId: couponId, revision: 1, changed: true,
    extra: { couponId, codeId, issued: recipients.length, queued: recipients.length, delivery: 'queued', ...queued, messageIds: undefined } };
}

async function expiryCreate(ctx: Ctx, body: unknown, events: Event[]): Promise<Outcome> {
  const input = object(body, ['itemId', 'batchId', 'menuId', 'route', 'benefit', 'discountRate']);
  const itemId = uuid(input.itemId, 'itemId');
  const batchId = input.batchId === undefined ? null : uuid(input.batchId, 'batchId');
  const menuId = input.menuId === undefined ? null : uuid(input.menuId, 'menuId');
  const route = choice(input.route, ['place_news', 'sms'] as const, 'route', 'ROUTE_INVALID');
  if ((input.benefit === undefined) === (input.discountRate === undefined)) throw invalid('benefit', 'BENEFIT_INVALID');
  const benefit: Benefit = input.discountRate !== undefined ? { kind: 'percent', value: integer(input.discountRate, 'discountRate', 1, 100) }
    : (() => {
      const value = object(input.benefit, ['kind', 'value'], 'benefit');
      return { kind: choice(value.kind, benefitKinds, 'benefit.kind', 'BENEFIT_INVALID'), value: integer(value.value, 'benefit.value', 1) };
    })();
  const lot = await ctx.sources.expiryLot(ctx, itemId, batchId);
  if (lot === null) throw unavailable('INVENTORY_UNAVAILABLE', 'itemId');
  if (lot === 'missing') throw invalid('itemId', 'NO_EXPIRY_STOCK');
  if (lot.expiresOn < ctx.clock.businessDate) throw conflict('LOT_EXPIRED', 'itemId', { expiresOn: lot.expiresOn });
  if (lot.expiresOn > ctx.clock.businessDate) throw conflict('NOT_EXPIRING_TODAY', 'itemId', { expiresOn: lot.expiresOn });
  const menu = await ctx.sources.menuForItem(ctx, itemId, menuId);
  if (menu === null) throw unavailable('INVENTORY_UNAVAILABLE', 'menuId');
  if (menu === 'missing') throw invalid('menuId', 'MENU_REQUIRED');
  const problem = benefitProblem(benefit, menu.price, menu.unitCost);
  if (problem) throw invalid('benefit', problem === 'OVER_LIMIT' && menu.unitCost === null ? 'COST_UNKNOWN' : problem);
  const lotKey = lot.batchId ?? itemId;
  const { rowCount } = await ctx.db.query(`SELECT 1 FROM marketing.coupon WHERE store_id = $1 AND origin = 'expiry'
    AND lot_key = $2 AND business_date = $3`, [ctx.storeId, lotKey, ctx.clock.businessDate]);
  if (rowCount) throw conflict('EXPIRY_ALREADY_MADE', 'itemId');
  const pieces = lot.unit === 'pcs' || lot.unit === 'ea' ? lot.remainingBase : null;
  const issueLimit = pieces === null ? publicIssueLimit : Math.max(1, Math.min(publicIssueLimit, pieces));
  const economics = menu.unitCost === null ? null : expiryEconomics(menu.price, menu.unitCost, benefit, pieces ?? issueLimit);
  const couponId = await insertCoupon(ctx, {
    origin: 'expiry', name: expiryName(menu.name, benefit), ...benefitStored(benefit), targetRef: menu.menuId, validHours: null,
    startsOn: ctx.clock.businessDate, endsOn: ctx.clock.businessDate, status: 'active',
    originRef: { itemId, batchId: lot.batchId, menuId: menu.menuId, menuName: menu.name },
    basis: { price: menu.price, unitCost: menu.unitCost, maxRatePercent: menu.unitCost === null ? null : maxRatePercent(menu.price, menu.unitCost),
      menuRevision: menu.revision, lotExpiresOn: lot.expiresOn, lotRemainingBase: lot.remainingBase, unit: lot.unit, economics },
    futureIssueCount: null, lotKey,
  });
  if (route === 'sms') {
    const regulars = await ctx.sources.regulars(ctx);
    if (!regulars) throw unavailable('CUSTOMER_UNAVAILABLE', 'route');
    const recipients = regulars.filter((row: Recipient) => row.marketingAllowed && row.recentVisitCount >= 2).map(row => row.customerId);
    if (!recipients.length) throw invalid('route', 'NO_RECIPIENTS');
    const { codeId, code } = await insertCode(ctx, couponId, 'sms', recipients.length, true);
    const queued = await queueMessages(ctx, couponId, codeId, recipients, 'coupon', expirySms(menu.name, benefit), 'regular', undefined, code);
    events.push(codeEvent({ codeId, couponId, code, route, issueCount: recipients.length }, 1, 'issued'),
      { type: 'marketing.message_queued.v1', aggregateId: couponId,
        payload: { couponId, codeId, kind: 'coupon', count: recipients.length, scheduledAt: queued.scheduledAt } });
    return { resourceId: couponId, revision: 1, changed: true,
      extra: { couponId, codeId, code, route, issued: recipients.length, queued: recipients.length, delivery: 'queued',
        scheduledAt: queued.scheduledAt, scheduledLocal: queued.scheduledLocal, night: queued.night } };
  }
  const { codeId, code } = await insertCode(ctx, couponId, 'place_news', issueLimit, false);
  // The unposted Place News draft is reversible; it issues nothing until the owner attests the post.
  return { resourceId: couponId, revision: 1, changed: true,
    inverse: [{ op: 'dropCode', codeId, revision: 1 }, { op: 'dropCoupon', couponId, revision: 1 }],
    extra: { couponId, codeId, code, route, issued: 0, issueLimit, post: postText(menu.name, benefit, code), sent: false } };
}

async function markPosted(ctx: Ctx, id: string, body: unknown, events: Event[]): Promise<Outcome> {
  object(body, []);
  const code = await lockCode(ctx, uuid(id, 'codeId'));
  if (code.route === 'sms') throw invalid('codeId', 'NOT_PUBLIC');
  if (code.activatedAt !== null) throw conflict('ALREADY_DONE', 'codeId');
  const coupon = await lockCoupon(ctx, code.couponId);
  if (effectiveStatus(coupon, ctx.clock.businessDate) !== 'active') throw conflict('COUPON_NOT_ACTIVE', 'codeId');
  const revision = code.revision + 1;
  await ctx.db.query('UPDATE marketing.coupon_code SET activated_at = $3, revision = $4 WHERE store_id = $1 AND code_id = $2',
    [ctx.storeId, code.codeId, ctx.now, revision]);
  events.push(codeEvent(code, revision, 'activated'));
  // The owner's attestation of a public post is irreversible (extra confirmation tier).
  return { resourceId: code.codeId, revision, changed: true, extra: { codeId: code.codeId, couponId: code.couponId, issued: code.issueCount } };
}

async function unpublish(ctx: Ctx, id: string, body: unknown, events: Event[]): Promise<Outcome> {
  const input = object(body, ['confirmed', 'expectedRevision']);
  confirmation(input.confirmed);
  const code = await lockCode(ctx, uuid(id, 'codeId'));
  if (input.expectedRevision !== undefined) checkRevision(input.expectedRevision, code.revision);
  if (code.route === 'sms' || code.activatedAt === null) throw conflict('NOT_PUBLISHED', 'codeId');
  if (code.unpublishedAt !== null) throw conflict('ALREADY_DONE', 'codeId');
  const coupon = await lockCoupon(ctx, code.couponId);
  const terms = code.issuedTerms ?? issuedTerms(coupon);
  const revision = code.revision + 1;
  await ctx.db.query(`UPDATE marketing.coupon_code SET unpublished_at = $3, issued_terms = $4, revision = $5
    WHERE store_id = $1 AND code_id = $2`, [ctx.storeId, code.codeId, ctx.now, JSON.stringify(terms), revision]);
  events.push(codeEvent(code, revision, 'unpublished', { issuedTerms: terms }));
  return { resourceId: code.codeId, revision, changed: true,
    inverse: [{ op: 'code', codeId: code.codeId, revision, restore: { issueCount: code.issueCount, unpublishedAt: null,
      issuedTerms: code.issuedTerms, revision: code.revision } }],
    extra: { codeId: code.codeId, couponId: code.couponId, issuedTerms: terms } };
}

/** D-326: snapshot activated codes' terms before a campaign edit so issued codes keep value and original expiry. */
async function protectIssued(ctx: Ctx, coupon: CouponRow, codes: readonly CodeRow[], inverse: InverseOp[], events: Event[]) {
  for (const code of codes) {
    if (!code.activatedAt || code.issuedTerms) continue;
    const revision = code.revision + 1;
    await ctx.db.query('UPDATE marketing.coupon_code SET issued_terms = $3, revision = $4 WHERE store_id = $1 AND code_id = $2',
      [ctx.storeId, code.codeId, JSON.stringify(issuedTerms(coupon)), revision]);
    inverse.push({ op: 'code', codeId: code.codeId, revision, restore: { issueCount: code.issueCount, unpublishedAt: code.unpublishedAt,
      issuedTerms: null, revision: code.revision } });
    events.push(codeEvent(code, revision, 'terms_preserved', { issuedTerms: issuedTerms(coupon) }));
  }
}

async function writeCoupon(ctx: Ctx, coupon: CouponRow, next: Partial<Pick<CouponRow, 'name' | 'benefitValue' | 'endsOn' | 'status' | 'futureIssueCount'>>) {
  const merged = { ...coupon, ...next, revision: coupon.revision + 1 };
  await ctx.db.query(`UPDATE marketing.coupon SET name = $3, benefit_value = $4, ends_on = $5, status = $6, future_issue_count = $7,
    revision = $8 WHERE store_id = $1 AND coupon_id = $2`,
  [ctx.storeId, coupon.couponId, merged.name, merged.benefitValue, merged.endsOn, merged.status, merged.futureIssueCount, merged.revision]);
  const { name, benefitValue, endsOn, status, futureIssueCount, revision } = coupon;
  const inverse: InverseOp = { op: 'coupon', couponId: coupon.couponId, revision: merged.revision,
    restore: { name, benefitValue, endsOn, status, futureIssueCount, revision } };
  return { merged, inverse };
}

async function lifecycle(ctx: Ctx, operation: 'pause' | 'resume' | 'extend' | 'end', id: string, body: unknown, events: Event[]): Promise<Outcome> {
  const input = object(body, operation === 'end' ? ['expectedRevision', 'confirmed'] : ['expectedRevision']);
  if (operation === 'end') confirmation(input.confirmed);
  const coupon = await lockCoupon(ctx, uuid(id, 'couponId'));
  checkRevision(input.expectedRevision, coupon.revision);
  const status = effectiveStatus(coupon, ctx.clock.businessDate);
  if (status === 'ended') throw conflict(operation === 'end' ? 'ALREADY_DONE' : 'COUPON_NOT_ACTIVE', 'couponId');
  if (operation === 'pause' && status !== 'active') throw conflict('ALREADY_DONE', 'couponId');
  if (operation === 'resume' && status !== 'paused') throw conflict('ALREADY_DONE', 'couponId');
  const inverse: InverseOp[] = [];
  if (operation === 'end') await protectIssued(ctx, coupon, await codesOf(ctx, coupon.couponId), inverse, events);
  const next = operation === 'pause' ? { status: 'paused' as const } : operation === 'resume' ? { status: 'active' as const }
    : operation === 'extend' ? { endsOn: addDays(coupon.endsOn, extendDays) }
      : { status: 'ended' as const, endsOn: coupon.endsOn > ctx.clock.businessDate ? ctx.clock.businessDate : coupon.endsOn };
  const written = await writeCoupon(ctx, coupon, next);
  return { resourceId: coupon.couponId, revision: written.merged.revision, changed: true, inverse: [written.inverse, ...inverse],
    extra: { couponId: coupon.couponId, status: effectiveStatus(written.merged, ctx.clock.businessDate), endsOn: written.merged.endsOn } };
}

async function update(ctx: Ctx, id: string, body: unknown, events: Event[]): Promise<Outcome> {
  const input = object(body, ['benefitValue', 'quantity', 'expectedRevision']);
  if (input.benefitValue === undefined && input.quantity === undefined) throw invalid('body', 'NO_CHANGE_FIELDS');
  const coupon = await lockCoupon(ctx, uuid(id, 'couponId'));
  checkRevision(input.expectedRevision, coupon.revision);
  if (effectiveStatus(coupon, ctx.clock.businessDate) === 'ended') throw conflict('COUPON_NOT_ACTIVE', 'couponId');
  const codes = await codesOf(ctx, coupon.couponId);
  const publicCodes = codes.filter(code => code.route !== 'sms');
  const draft = publicCodes.find(code => !code.activatedAt);
  const publication = publicCodes.find(code => code.activatedAt && !code.unpublishedAt);
  const benefitValue = input.benefitValue === undefined ? coupon.benefitValue : integer(input.benefitValue, 'benefitValue', 1, 100_000_000, 'BENEFIT_INVALID');
  const issueLimit = coupon.futureIssueCount ?? draft?.issueCount ?? publication?.issueCount ?? publicIssueLimit;
  const quantity = input.quantity === undefined ? issueLimit : integer(input.quantity, 'quantity', 1, 100_000, 'QUANTITY_INVALID');
  if (input.quantity !== undefined && !publicCodes.length) throw invalid('quantity', 'QUANTITY_NOT_PUBLIC');
  if (benefitValue === coupon.benefitValue && quantity === issueLimit) {
    return { resourceId: coupon.couponId, revision: coupon.revision, changed: false, extra: { couponId: coupon.couponId, benefitValue, quantity } };
  }
  let name = coupon.name;
  if (benefitValue !== coupon.benefitValue) {
    const benefit = benefitOf(coupon.benefitType, benefitValue);
    if (!benefit) throw invalid('benefitValue', 'BENEFIT_INVALID');
    if (coupon.origin === 'expiry') {
      const basis = coupon.basis as { price?: number; unitCost?: number | null } | null;
      const problem = benefitProblem(benefit, basis?.price ?? 0, basis?.unitCost ?? null);
      if (problem) throw invalid('benefitValue', problem);
      name = expiryName(String(coupon.originRef.menuName ?? ''), benefit);
    } else if (benefit.kind === 'percent' && benefitValue > 100) throw invalid('benefitValue', 'PERCENT_RANGE');
  }
  const inverse: InverseOp[] = [];
  await protectIssued(ctx, coupon, codes, inverse, events);
  if (draft && quantity !== draft.issueCount) {
    const revision = draft.revision + 1;
    await ctx.db.query('UPDATE marketing.coupon_code SET issue_count = $3, revision = $4 WHERE store_id = $1 AND code_id = $2',
      [ctx.storeId, draft.codeId, quantity, revision]);
    inverse.push({ op: 'code', codeId: draft.codeId, revision, restore: { issueCount: draft.issueCount, unpublishedAt: null,
      issuedTerms: draft.issuedTerms, revision: draft.revision } });
  } else if (!draft && publication && input.quantity !== undefined) {
    // Future issue goes to a new unposted code; the published code keeps its count and terms.
    const created = await insertCode(ctx, coupon.couponId, publication.route, quantity, false);
    inverse.push({ op: 'dropCode', codeId: created.codeId, revision: 1 });
  }
  const written = await writeCoupon(ctx, coupon, { name, benefitValue, ...(input.quantity === undefined ? {} : { futureIssueCount: quantity }) });
  return { resourceId: coupon.couponId, revision: written.merged.revision, changed: true, inverse: [written.inverse, ...inverse],
    extra: { couponId: coupon.couponId, benefitValue, quantity } };
}

async function notifyEnding(ctx: Ctx, id: string, body: unknown, events: Event[]): Promise<Outcome> {
  object(body, []);
  const coupon = await lockCoupon(ctx, uuid(id, 'couponId'));
  const status = effectiveStatus(coupon, ctx.clock.businessDate);
  if (status !== 'active') throw conflict('COUPON_NOT_ACTIVE', 'couponId');
  if (coupon.endsOn > addDays(ctx.clock.businessDate, endingSoonDays)) throw conflict('NOT_ENDING_SOON', 'couponId');
  const { rows: targets } = await ctx.db.query<{ customerId: string }>(`SELECT DISTINCT customer_id AS "customerId"
    FROM marketing.coupon_target WHERE store_id = $1 AND coupon_id = $2`, [ctx.storeId, coupon.couponId]);
  if (!targets.length) throw invalid('couponId', 'NO_REMINDER_RECIPIENTS');
  const live = await ctx.sources.recipients(ctx, targets.map(row => row.customerId));
  if (!live) throw unavailable('CUSTOMER_UNAVAILABLE', 'couponId');
  const audience = targets.map(row => row.customerId).filter(customerId => live.get(customerId)?.marketingAllowed);
  if (!audience.length) throw invalid('couponId', 'NO_REMINDER_RECIPIENTS');
  const queued = await queueMessages(ctx, coupon.couponId, null, audience, 'reminder', reminderSms, null, undefined);
  const reminderId = randomUUID();
  await ctx.db.query(`INSERT INTO marketing.coupon_reminder (store_id, reminder_id, coupon_id, recipients, queued_at)
    VALUES ($1,$2,$3,$4,$5)`, [ctx.storeId, reminderId, coupon.couponId, audience.length, ctx.now]);
  events.push({ type: 'marketing.message_queued.v1', aggregateId: reminderId,
    payload: { couponId: coupon.couponId, reminderId, kind: 'reminder', count: audience.length, scheduledAt: queued.scheduledAt } });
  return { resourceId: reminderId, revision: 1, changed: true,
    extra: { couponId: coupon.couponId, reminderId, recipients: audience.length, delivery: 'queued', scheduledAt: queued.scheduledAt,
      scheduledLocal: queued.scheduledLocal, night: queued.night } };
}

async function applyInverse(ctx: Ctx, ops: readonly InverseOp[]) {
  // Validate every target first so a partial undo never commits.
  for (const op of ops) {
    if (op.op === 'coupon') {
      const row = await lockCoupon(ctx, op.couponId);
      if (row.revision !== op.revision) throw conflict('UNDO_UNAVAILABLE', 'receiptId');
    } else if (op.op === 'dropCoupon') {
      const row = await lockCoupon(ctx, op.couponId);
      if (row.revision !== op.revision) throw conflict('UNDO_UNAVAILABLE', 'receiptId');
    } else {
      const row = await lockCode(ctx, op.codeId);
      if (row.revision !== op.revision) throw conflict('UNDO_UNAVAILABLE', 'receiptId');
      const { rowCount } = await ctx.db.query(`SELECT 1 FROM marketing.coupon_redemption WHERE store_id = $1 AND code_id = $2
        AND state IN ('held', 'committed')`, [ctx.storeId, op.codeId]);
      if (op.op === 'dropCode' && (row.activatedAt || rowCount)) throw conflict('UNDO_UNAVAILABLE', 'receiptId');
    }
  }
  for (const op of ops) {
    if (op.op === 'coupon') {
      const r = op.restore;
      await ctx.db.query(`UPDATE marketing.coupon SET name = $3, benefit_value = $4, ends_on = $5, status = $6, future_issue_count = $7,
        revision = $8 WHERE store_id = $1 AND coupon_id = $2`,
      [ctx.storeId, op.couponId, r.name, r.benefitValue, r.endsOn, r.status, r.futureIssueCount, op.revision + 1]);
    } else if (op.op === 'code') {
      const r = op.restore;
      await ctx.db.query(`UPDATE marketing.coupon_code SET issue_count = $3, unpublished_at = $4, issued_terms = $5, revision = $6
        WHERE store_id = $1 AND code_id = $2`,
      [ctx.storeId, op.codeId, r.issueCount, r.unpublishedAt, r.issuedTerms === null ? null : JSON.stringify(r.issuedTerms), op.revision + 1]);
    } else if (op.op === 'dropCode') {
      await ctx.db.query('DELETE FROM marketing.coupon_code WHERE store_id = $1 AND code_id = $2', [ctx.storeId, op.codeId]);
    } else {
      await ctx.db.query('DELETE FROM marketing.coupon WHERE store_id = $1 AND coupon_id = $2', [ctx.storeId, op.couponId]);
    }
  }
}

async function undo(ctx: Ctx, id: string, body: unknown): Promise<Outcome> {
  object(body, []);
  const receiptId = uuid(id, 'receiptId');
  const { rows: [command] } = await ctx.db.query<{ actorId: string; inverse: InverseOp[] | null; undoUntil: Date | null; undoneAt: Date | null;
    receipt: Receipt }>(`SELECT actor_id AS "actorId", inverse, undo_until AS "undoUntil", undone_at AS "undoneAt", receipt
    FROM marketing.coupon_command WHERE store_id = $1 AND receipt_id = $2 FOR UPDATE`, [ctx.storeId, receiptId]);
  if (!command) throw missing('RECEIPT_NOT_FOUND', 'receiptId');
  if (command.actorId !== ctx.actorId || !command.inverse || !command.undoUntil) throw conflict('UNDO_UNAVAILABLE', 'receiptId');
  if (command.undoneAt) throw conflict('ALREADY_DONE', 'receiptId');
  if (command.undoUntil.getTime() < ctx.now.getTime()) throw conflict('UNDO_EXPIRED', 'receiptId', { undoUntil: command.undoUntil.toISOString() });
  await applyInverse(ctx, command.inverse);
  await ctx.db.query('UPDATE marketing.coupon_command SET undone_at = $3 WHERE store_id = $1 AND receipt_id = $2', [ctx.storeId, receiptId, ctx.now]);
  return { resourceId: command.receipt.resourceId, revision: command.receipt.revision + 1, changed: true, extra: { undoneReceiptId: receiptId } };
}

export type CommandName = 'slot' | 'expiry' | 'markPosted' | 'unpublish' | 'update' | 'pause' | 'resume' | 'extend' | 'end' | 'notify' | 'undo';

async function dispatch(ctx: Ctx, name: CommandName, id: string | undefined, body: unknown, events: Event[]): Promise<Outcome> {
  switch (name) {
    case 'slot': return slotIssue(ctx, body, events);
    case 'expiry': return expiryCreate(ctx, body, events);
    case 'markPosted': return markPosted(ctx, id ?? '', body, events);
    case 'unpublish': return unpublish(ctx, id ?? '', body, events);
    case 'update': return update(ctx, id ?? '', body, events);
    case 'notify': return notifyEnding(ctx, id ?? '', body, events);
    case 'undo': return undo(ctx, id ?? '', body);
    default: return lifecycle(ctx, name, id ?? '', body, events);
  }
}

async function appendEvents(ctx: Scope, events: readonly Event[]) {
  for (const event of events) {
    await ctx.db.query(`
      WITH seq AS (
        INSERT INTO marketing.outbox_scope (scope_key, last_seq) VALUES ($2::text, 1)
        ON CONFLICT (scope_key) DO UPDATE SET last_seq = marketing.outbox_scope.last_seq + 1 RETURNING last_seq
      )
      INSERT INTO marketing.outbox (event_id, store_id, scope_key, store_seq, event_type, aggregate_id, occurred_at, payload)
      SELECT $1, $2::text::uuid, $2::text, last_seq, $3, $4, $5, $6::jsonb FROM seq`,
    [randomUUID(), ctx.storeId, event.type, event.aggregateId, ctx.now, JSON.stringify(event.payload)]);
  }
}
export { appendEvents as appendCouponEvents };

/** Run one owner command once per (actor, key): replays return the stored receipt; a changed body is 409. */
export async function execute(ctx: Ctx, key: string, name: CommandName, id: string | undefined, body: unknown): Promise<Receipt> {
  const hash = fingerprint({ name, id: id ?? null, body: body ?? null });
  const { rows: [stored] } = await ctx.db.query<{ commandHash: string; receipt: Receipt }>(`SELECT command_hash AS "commandHash", receipt
    FROM marketing.coupon_command WHERE store_id = $1 AND actor_id = $2 AND command_key = $3`, [ctx.storeId, ctx.actorId, key]);
  if (stored) {
    if (stored.commandHash !== hash) throw conflict('IDEMPOTENCY_MISMATCH');
    return stored.receipt;
  }
  const events: Event[] = [];
  const outcome = await dispatch(ctx, name, id, body, events);
  const receiptId = randomUUID();
  const undoUntil = outcome.inverse?.length ? new Date(ctx.now.getTime() + undoMs) : null;
  const receipt: Receipt = {
    resourceId: outcome.resourceId, revision: outcome.revision, receiptId, changed: outcome.changed,
    affectedSources: outcome.changed ? couponSources : [],
    ...(undoUntil && { undoUntil: undoUntil.toISOString() }),
    ...Object.fromEntries(Object.entries(outcome.extra ?? {}).filter(([, value]) => value !== undefined)),
  };
  await ctx.db.query(`INSERT INTO marketing.coupon_command (store_id, actor_id, command_key, command_hash, receipt_id, recorded_at,
      receipt, inverse, undo_until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [ctx.storeId, ctx.actorId, key, hash, receiptId, ctx.now, JSON.stringify(receipt),
    undoUntil ? JSON.stringify(outcome.inverse) : null, undoUntil]);
  if (outcome.changed) {
    await appendEvents(ctx, events);
    await bumpRevision(ctx, 'coupons');
  }
  return receipt;
}

