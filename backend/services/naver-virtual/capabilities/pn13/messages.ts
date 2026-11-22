import { randomUUID } from 'node:crypto';
import type { BizAcceptance, MessageAcceptance } from '../../../../packages/naver/contracts/pn13/index.ts';
import type { Data, MessageRow, RequestRow } from './database.ts';

export const phoneProducts = ['sms', 'alimtalk', 'brandmessage'] as const;
export type PhoneProduct = typeof phoneProducts[number];
type Credential = (field: string) => string | undefined;
type Draft = { payload: Data; messages: { id: string; data: Data }[]; scheduledAt: Date | null };

export function object(value: unknown): value is Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function onlyKeys(data: Data, names: string[]) {
  return Object.keys(data).every(key => names.includes(key));
}

export function strings(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every(entry => typeof entry === 'string');
}

export function kst(time: Date) {
  return new Date(time.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, -1);
}

export function localDate(value: unknown, minutePrecision = false) {
  if (typeof value !== 'string') return undefined;
  const shape = minutePrecision ? /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/ : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (!shape.test(value)) return undefined;
  const parsed = new Date(`${value.replace(' ', 'T')}${minutePrecision ? ':00' : ''}+09:00`);
  if (!Number.isFinite(parsed.getTime()) || kst(parsed).replace('T', ' ').slice(0, value.length) !== value) return undefined;
  return parsed;
}

// A strict EUC-KR round trip uses ASCII and the 94×94 KS X 1001 code space.
function koreanCharacters() {
  const decoder = new TextDecoder('euc-kr', { fatal: true });
  const supported = new Set<string>();
  for (let first = 0xa1; first <= 0xfe; first++) {
    for (let last = 0xa1; last <= 0xfe; last++) {
      try { supported.add(decoder.decode(Uint8Array.of(first, last))); } catch { /* Unassigned code. */ }
    }
  }
  return supported;
}

let korean: Set<string> | undefined;
function boundedSms(value: string, limit: number) {
  korean ??= koreanCharacters();
  let bytes = 0;
  let content = '';
  let encodable = true;
  for (const char of value) {
    const ascii = char.charCodeAt(0) < 128;
    if (!ascii && !korean.has(char)) encodable = false;
    bytes += ascii ? 1 : 2;
    if (bytes <= limit) content += char;
  }
  return { content, encodable };
}

function acceptedSms(body: Data, to: string, message: Data) {
  if (!onlyKeys(message, ['to', 'subject', 'content']) || typeof body.content !== 'string'
    || (message.content !== undefined && typeof message.content !== 'string')
    || (message.subject !== undefined && typeof message.subject !== 'string')
    || (body.subject !== undefined && typeof body.subject !== 'string')
    || (body.type === 'SMS' && (body.subject !== undefined || message.subject !== undefined))) return undefined;
  const content = boundedSms((message.content ?? body.content) as string, body.type === 'SMS' ? 90 : 2000);
  const subject = boundedSms((message.subject ?? body.subject ?? '') as string, 40);
  const failed = !content.encodable || !subject.encodable ? '3022' : to === '01000009999' ? '3001' : undefined;
  return {
    to, content: content.content, subject: subject.content, countryCode: body.countryCode ?? '82',
    ...(failed && { failure: failed }),
  };
}

function acceptedBiz(product: PhoneProduct, body: Data, to: string, message: Data, credential: Credential) {
  if (!onlyKeys(message, ['to', 'content', 'countryCode', 'useSmsFailover', 'templateParameters'])
    || (message.countryCode !== undefined && message.countryCode !== '82')
    || (message.useSmsFailover !== undefined && message.useSmsFailover !== false)) return undefined;
  const brand = product === 'brandmessage';
  let content = message.content;
  if (brand && typeof body.templateCode === 'string') {
    if (message.content !== undefined || !strings(message.templateParameters)) return undefined;
    const template = credential('templateText');
    if (!template || /#\{[^}]+\}/.test(template.replace(/#\{([^}]+)\}/g, (whole, key: string) =>
      Object.hasOwn(message.templateParameters as object, key) ? '' : whole))) return undefined;
    const parameters = message.templateParameters;
    content = template.replace(/#\{([^}]+)\}/g, (_, key: string) => parameters[key] ?? '');
  } else if (message.templateParameters !== undefined) {
    return undefined;
  }
  if (typeof content !== 'string' || !content.trim() || Array.from(content).length > (brand ? 1300 : 1000)
    || brand && content.split('\n').length > 100) return undefined;
  // This tenant has one approved informational AlimTalk template.
  if (!brand) {
    const template = credential('templateText') ?? '주문 안내';
    if (content !== template) return undefined;
  }
  const failure = to === '01000009999' ? '3019' : undefined;
  return { to, countryCode: '82', content, useSmsFailover: false,
    ...(message.templateParameters !== undefined && { templateParameters: message.templateParameters }),
    ...(failure && { failure }),
  };
}

export function phoneDraft(product: PhoneProduct, body: unknown, credential: Credential, now: Date): Draft | undefined {
  if (!object(body) || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) return undefined;
  const scheduleFields = ['messages', 'reserveTime', 'reserveTimeZone'];
  const isSms = product === 'sms';
  const isBrand = product === 'brandmessage';
  if (isSms) {
    if (!onlyKeys(body, [...scheduleFields, 'type', 'contentType', 'countryCode', 'from', 'subject', 'content'])
      || !['SMS', 'LMS'].includes(String(body.type))
      || typeof body.from !== 'string' || !/^0100000\d{4}$/.test(body.from) || body.from !== credential('sender')
      || (body.contentType !== undefined && !['COMM', 'AD'].includes(String(body.contentType)))
      || (body.countryCode !== undefined && body.countryCode !== '82')) return undefined;
  } else {
    const fields = ['plusFriendId', 'templateCode', ...(isBrand ? ['messageType', 'targeting', 'isAdult'] : [])];
    if (!onlyKeys(body, [...scheduleFields, ...fields]) || typeof body.plusFriendId !== 'string'
      || body.plusFriendId !== credential('plusFriendId')) return undefined;
    if ((!isBrand || body.templateCode !== undefined)
      && (typeof body.templateCode !== 'string' || body.templateCode !== credential('templateCode'))) return undefined;
    if (isBrand && (body.messageType !== 'TEXT'
      || (body.targeting !== undefined && !['M', 'N', 'I'].includes(String(body.targeting)))
      || (body.isAdult !== undefined && typeof body.isAdult !== 'boolean'))) return undefined;
  }
  const scheduledAt = body.reserveTime === undefined ? null : localDate(body.reserveTime, true);
  if (body.reserveTimeZone !== undefined && body.reserveTimeZone !== 'Asia/Seoul'
    || scheduledAt === undefined || scheduledAt && scheduledAt.getTime() - now.getTime() <= 600_000) return undefined;
  // Local virtual-server rule (no SENS source): the send page documents no time-of-day rejection for AD. The
  // 08:00–21:00 window is the sender's legal duty, which Navis enforces before calling; see README "Local rules".
  if (isSms && body.contentType === 'AD') {
    const time = kst(scheduledAt ?? now).slice(11, 16);
    if (time < '08:00' || time >= '21:00') return undefined;
  }
  if (isBrand) {
    const local = kst(scheduledAt ?? now);
    const time = local.slice(11, 16);
    if (time < '08:00' || time >= '20:50') return undefined;
  }

  const consent = new Set(isBrand ? credential('consentedRecipients')?.split(',').map(phone => phone.trim()) : []);
  const friends = new Set(isBrand ? credential('channelFriends')?.split(',').map(phone => phone.trim()) : []);
  const targeting = body.targeting ?? 'I';
  const messages: Draft['messages'] = [];
  for (const message of body.messages) {
    if (!object(message) || typeof message.to !== 'string' || !/^0100000\d{4}$/.test(message.to)) return undefined;
    if (isBrand && (!consent.has(message.to) || targeting === 'I' && !friends.has(message.to)
      || targeting === 'N' && friends.has(message.to))) return undefined;
    const data = isSms ? acceptedSms(body, message.to, message) : acceptedBiz(product, body, message.to, message, credential);
    if (!data) return undefined;
    messages.push({ id: randomUUID(), data });
  }
  const payload = isSms ? { type: body.type, contentType: body.contentType ?? 'COMM', from: body.from }
    : { plusFriendId: body.plusFriendId, ...(body.templateCode !== undefined && { templateCode: body.templateCode }),
      ...(isBrand && { messageType: body.messageType, isAdult: body.isAdult ?? false, targeting: body.targeting ?? 'I' }),
    };
  return { payload, messages, scheduledAt };
}

function acceptedRecipient(product: PhoneProduct, messageId: string, message: Data) {
  return {
    messageId, countryCode: String(message.countryCode), to: String(message.to),
    ...(product === 'alimtalk' && { content: String(message.content) }),
    requestStatusCode: 'A000', requestStatusName: 'success' as const, requestStatusDesc: '성공',
    useSmsFailover: false,
  };
}

export function phoneAcceptance(product: PhoneProduct, row: RequestRow, draft: Draft): MessageAcceptance | BizAcceptance {
  const common = { requestId: row.request_id, requestTime: kst(row.accepted_at), statusCode: '202' as const };
  if (product === 'sms') return { ...common, statusName: 'success' };
  if (row.scheduled_at && product === 'alimtalk') return { ...common, statusName: 'reserved' };
  return { ...common, statusName: 'processing',
    messages: draft.messages.map(message => acceptedRecipient(product, message.id, message.data)),
  };
}

export function completionTime(row: RequestRow, now: Date) {
  const at = row.scheduled_at ?? row.accepted_at;
  return at <= now ? at : undefined;
}

export function phoneResult(product: PhoneProduct, row: MessageRow, now: Date, detailed = false): Data {
  const completed = completionTime(row, now);
  const { to, countryCode, content, subject, failure, templateParameters } = row.message;
  const timing = { requestId: row.request_id, messageId: row.message_id };
  if (product === 'sms') {
    const stamp = (time: Date) => kst(time).slice(0, 19).replace('T', ' ');
    return {
      ...timing, ...row.payload, requestTime: stamp(row.accepted_at), to, countryCode,
      ...(detailed && { content, subject }), status: completed ? 'COMPLETED' : 'READY',
      ...(completed && { completeTime: stamp(completed), telcoCode: 'ETC',
        statusCode: failure ?? '0', statusName: failure ? 'fail' : 'success',
        statusMessage: failure === '3022' ? 'Charset Conversion Error' : failure ? '가입자 없음' : '성공' }),
    };
  }
  return {
    ...acceptedRecipient(product, row.message_id, row.message), ...timing, ...row.payload,
    content, requestTime: kst(row.accepted_at),
    ...(detailed && templateParameters !== undefined && { templateParameters }),
    messageStatusName: completed ? failure ? 'fail' : 'success' : 'processing',
    ...(completed && { completeTime: kst(completed).slice(0, 19),
      messageStatusCode: failure ?? '0000', messageStatusDesc: failure ? '톡 사용자가 아님' : '정상 발송' }),
  };
}
