import { isUuid } from '../../promo/contracts.ts';

export const channels = ['manual', 'sms', 'talktalk', 'place-news', 'place-hours'] as const;
export const audiences = ['benefit-subscribers', 'recent-visitor-reviewers'] as const;
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const authorNotification = '답글을 올리면 리뷰 작성자에게 알림이 가요.';
export type Channel = typeof channels[number];
export type Audience = typeof audiences[number];
export type InquirySource = 'manual' | 'review' | 'talktalk';
export type Operation = 'inquiry.create' | 'inquiry.saveDraft' | 'inquiry.attest' | 'inquiry.post' |
  'inquiry.editReply' | 'inquiry.deleteReply' | 'notice.create' | 'notice.saveDraft' | 'notice.attest' |
  'notice.deleteDraft' | 'notice.send' | 'notice.cancelSms' | 'notice.deleteNews';

export class NoticeError extends Error {
  constructor(readonly status: number, readonly code: string, readonly receiptId?: string) { super(code); }
}

export function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !fields.includes(key))) throw new NoticeError(400, 'INVALID_REQUEST');
  return value as Record<string, unknown>;
}

export function choice<T extends string>(value: unknown, values: readonly T[], code = 'INVALID_REQUEST'): T {
  const result = values.find(item => item === value);
  if (!result) throw new NoticeError(400, code);
  return result;
}

export function text(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value.trim() || [...value].length > limit || value.includes('\0')) {
    throw new NoticeError(400, 'INVALID_TEXT');
  }
  return value.trim();
}

export function uuid(value: unknown) {
  if (!isUuid(value)) throw new NoticeError(400, 'INVALID_ID');
  return value.toLowerCase();
}

function positiveInteger(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw new NoticeError(400, 'INVALID_REVISION');
  }
  return value;
}

export function date(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || value.startsWith('0000')) {
    throw new NoticeError(400, 'INVALID_DATE');
  }
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) throw new NoticeError(400, 'INVALID_DATE');
  return value;
}

export function nightNoticeHint(now: Date, timezone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(entry => entry.type === type)!.value;
  const hour = Number(part('hour'));
  if (hour >= 8 && hour < 21) return null;
  const today = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')));
  const tomorrow = new Date(today + 86400000).toISOString().slice(0, 10);
  return { localTime: tomorrow + 'T08:00', label: '내일 8시' };
}

function smsLocalTime(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new NoticeError(400, 'INVALID_SMS_SCHEDULE');
  }
  date(value.slice(0, 10));
  return value;
}

/**
 * Scheduled notice SMS limits. Basis: RV-GAP-B-3 requires a bounded horizon so a stored owner approval cannot wait
 * indefinitely (proposal for R3: 30 days). The 10-minute lead keeps the SENS reservation minimum the card already
 * shows and leaves the owner a cancel window. SENS accepts at most 100 numbers per request ([send](https://api.ncloud-docs.com/docs/sens-sms-send)),
 * so the worker splits batches; the 500-recipient cap reuses the B14 coupon send cap.
 */
export const smsScheduleHorizonMs = 30 * 86_400_000;
export const smsMaxRecipients = 500;
export const sensBatchSize = 100;

export function isAdvertisingHour(localTime: string) {
  return localTime >= '08:00' && localTime < '21:00';
}

/** Seoul local `HH:mm` for an instant (Korea has no DST). */
export function seoulMinute(now: Date) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(11, 16);
}

export function smsReservationTime(value: unknown, now: Date, advertising: boolean) {
  const local = smsLocalTime(value);
  const night = nightNoticeHint(now);
  const time = local.slice(11);
  if ((night && local !== night.localTime) || (advertising && !isAdvertisingHour(time))) {
    throw new NoticeError(409, 'NOTICE_OUTSIDE_SEND_WINDOW');
  }
  const at = new Date(local + ':00+09:00');
  if (+at - +now <= 600_000) throw new NoticeError(409, 'SMS_SCHEDULE_TOO_SOON');
  if (+at - +now > smsScheduleHorizonMs) throw new NoticeError(409, 'SMS_SCHEDULE_TOO_FAR');
  return { local, at };
}

const replyContact = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?82[\s.-]?)?0?1[016789][\s().-]*\d{3,4}[\s().-]*\d{4}|\d{6}\s*-\s*[1-8]\d{6}/iug;
export function redactReviewContact(value: string) {
  return value.normalize('NFKC').replace(replyContact, '[연락처 삭제]');
}

export function publicReply(value: unknown) {
  const reply = text(value, 1000);
  if (reply.normalize('NFKC').search(replyContact) !== -1) {
    throw new NoticeError(400, 'REPLY_CONTAINS_CONTACT');
  }
  return reply;
}

export type ClosureLink = { eventId: string; revision: number };
export type BusinessHours = { day: typeof weekdays[number]; open: string; close: string };
export type NewsPin = { from: string; to: string; order: number };
export type NoticeDraft = {
  title: string; text: string; channel: Channel; closure: ClosureLink | null;
  audience: Audience | null; recipientGroupId: string | null; couponRef: string | null;
  startDate: string | null; endDate: string | null;
  businessHours: BusinessHours[] | null; pin: NewsPin | null;
};

export type CommandInput = {
  expectedRevision?: number; approvalId?: string; notice?: NoticeDraft;
  text?: string; title?: string; source?: InquirySource; type?: 'review' | 'message'; providerRef?: string | null;
  scheduledFor?: string;
  draftSource?: 'owner' | 'naver-ai' | 'navis'; sourceUrl?: string | null;
};

export const cardOperations = new Set<Operation>([
  'inquiry.attest', 'inquiry.post', 'inquiry.editReply', 'inquiry.deleteReply',
  'notice.attest', 'notice.deleteDraft', 'notice.send', 'notice.cancelSms', 'notice.deleteNews',
]);
export const destructiveOperations = new Set<Operation>(['inquiry.deleteReply', 'notice.deleteDraft', 'notice.cancelSms', 'notice.deleteNews']);
const sources = ['manual', 'review', 'talktalk'] as const;

function hours(value: unknown): BusinessHours[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) throw new NoticeError(400, 'INVALID_HOURS');
  const clock = (value: unknown) => choice(value, typeof value === 'string' &&
    /^(?:[01][0-9]|2[0-3]):[0-5][05]$/.test(value) ? [value] : [], 'INVALID_HOURS');
  const result = value.map(entry => {
    const { day, open, close } = object(entry, ['day', 'open', 'close']);
    if (open === close) throw new NoticeError(400, 'INVALID_HOURS');
    return { day: choice(day, weekdays, 'INVALID_HOURS'), open: clock(open), close: clock(close) };
  });
  if (new Set(result.map(row => row.day)).size !== result.length) throw new NoticeError(400, 'INVALID_HOURS');
  return result;
}

function newsPin(value: unknown): NewsPin {
  const { from, to, order } = object(value, ['from', 'to', 'order']);
  const start = date(from);
  const end = date(to);
  const slot = positiveInteger(order);
  if (start > end || +new Date(end) - +new Date(start) >= 45 * 86400000 || slot > 5) {
    throw new NoticeError(400, 'INVALID_NEWS_PIN');
  }
  return { from: start, to: end, order: slot };
}

export function noticeCommand(operation: Operation, value: unknown, source?: InquirySource): CommandInput {
  const create = operation.endsWith('.create');
  const shared = [...(create ? [] : ['expectedRevision']), ...(cardOperations.has(operation) ? ['approvalId'] : [])];
  const draftFields = ['title', 'text', 'channel', 'closure', 'audience', 'recipientGroupId', 'couponRef',
    'startDate', 'endDate', 'businessHours', 'pin'];
  const fields = {
    'inquiry.create': ['title', 'text', 'source', 'type', 'providerRef', 'sourceUrl'],
    'inquiry.saveDraft': ['text', 'draftSource'],
    'inquiry.attest': [],
    'inquiry.post': [],
    'inquiry.editReply': ['text'],
    'inquiry.deleteReply': [],
    'notice.create': draftFields,
    'notice.saveDraft': draftFields,
    'notice.attest': [],
    'notice.deleteDraft': [],
    'notice.send': ['scheduledFor'],
    'notice.cancelSms': [],
    'notice.deleteNews': [],
  }[operation];
  const body = object(value, [...shared, ...fields]);
  const result: CommandInput = {};
  if (!create) result.expectedRevision = positiveInteger(body.expectedRevision);
  if (cardOperations.has(operation)) result.approvalId = uuid(body.approvalId);
  if (operation === 'notice.send' && body.scheduledFor !== undefined) result.scheduledFor = smsLocalTime(body.scheduledFor);
  switch (operation) {
    case 'notice.create':
    case 'notice.saveDraft': {
      const channel = choice(body.channel, channels, 'INVALID_CHANNEL');
      const closure = body.closure == null ? null : object(body.closure, ['eventId', 'revision']);
      if (channel === 'place-hours' && (closure == null) === (body.businessHours == null) ||
        channel !== 'place-hours' && body.businessHours != null) throw new NoticeError(400, 'INVALID_HOURS_SOURCE');
      if (channel !== 'place-news' && body.pin != null) throw new NoticeError(400, 'INVALID_NEWS_PIN');
      if (channel !== 'talktalk' && (body.audience != null || body.couponRef != null) ||
        channel !== 'sms' && body.recipientGroupId != null) throw new NoticeError(400, 'INVALID_AUDIENCE');
      const startDate = body.startDate == null ? null : date(body.startDate);
      const endDate = body.endDate == null ? startDate : date(body.endDate);
      if (endDate && (!startDate || endDate < startDate)) throw new NoticeError(400, 'INVALID_DATE_RANGE');
      result.notice = {
        title: text(body.title, 100), text: text(body.text, 2000), channel,
        closure: closure && { eventId: uuid(closure.eventId), revision: positiveInteger(closure.revision) },
        audience: channel === 'talktalk' ? choice(body.audience, audiences, 'INVALID_AUDIENCE') : null,
        recipientGroupId: channel === 'sms' ? uuid(body.recipientGroupId) : null,
        couponRef: body.couponRef == null ? null : reference(body.couponRef),
        startDate, endDate,
        businessHours: body.businessHours == null ? null : hours(body.businessHours),
        pin: body.pin == null ? null : newsPin(body.pin),
      };
      break;
    }
    case 'inquiry.create': {
      result.source = choice(body.source ?? 'manual', sources);
      result.type = result.source === 'manual' ? choice(body.type ?? 'message', ['review', 'message'] as const)
        : result.source === 'review' ? 'review' : 'message';
      result.providerRef = result.source === 'manual' ? null : reference(body.providerRef);
      if (result.source === 'manual' && body.providerRef != null) throw new NoticeError(400, 'INVALID_REFERENCE');
      if (result.source === 'manual') {
        result.title = text(body.title, 100);
        result.text = text(body.text, 4000);
        result.sourceUrl = body.sourceUrl == null ? null : sourceUrl(body.sourceUrl);
      } else if (body.title != null || body.text != null || body.sourceUrl != null) {
        throw new NoticeError(400, 'INVALID_REQUEST');
      }
      break;
    }
    case 'inquiry.saveDraft':
      result.text = source === 'review' ? publicReply(body.text) : text(body.text, 2000);
      result.draftSource = choice(body.draftSource ?? 'owner', ['owner', 'naver-ai', 'navis'] as const);
      break;
    case 'inquiry.editReply':
      result.text = publicReply(body.text);
      break;
  }
  return result;
}

export function reference(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.~-]{1,128}$/.test(value) || value === '.' || value === '..') {
    throw new NoticeError(400, 'INVALID_REFERENCE');
  }
  return value;
}

function sourceUrl(value: unknown) {
  try {
    const url = new URL(text(value, 2000));
    if (url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'naver.com' || url.hostname.endsWith('.naver.com'))) return url.href;
  } catch { /* Invalid or unsupported link. */ }
  throw new NoticeError(400, 'INVALID_SOURCE_URL');
}
