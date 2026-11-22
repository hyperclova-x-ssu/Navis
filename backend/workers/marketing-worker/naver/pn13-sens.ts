import { eucKrBytes, validSmsNumber } from '../../../../frontend/server/sens-sms.mjs';
import { SENS_LMS_MAX_BYTES, SENS_SMS_MAX_BYTES, SENS_SUBJECT_MAX_BYTES } from '../../../services/marketing/sms-text.ts';
import type {
  AlimTalkResult, BizAcceptance, BrandMessageResult, MailAcceptance, MailRequestResult, MessageAcceptance, SmsReservation, SmsResult,
} from '../../../packages/naver/contracts/pn13/index.ts';
import type { OperationId, Provider } from '../../../services/marketing/naver/binding.ts';
import { NaverAdapterError } from '../../../services/marketing/naver/errors.ts';
import { arr, bool, int, nul, obj, oneOf, opt, project, str, type Shape } from '../../../services/marketing/naver/schema.ts';
import { attemptKeyPattern, call, parseJson, type CallResult } from '../../../services/marketing/naver/transport.ts';
import type { FakeSensTransport, ProviderOutcome } from '../sens/transport.ts';

/**
 * PN13 SENS wires for marketing-worker (W). The worker keeps its SENS policy and attempt ledger; this
 * module only speaks the published wire. Signature v2 headers are added by the PN-P0 binding.
 * Contract: packages/naver/contracts/pn13 · persona capability pn13.
 *
 * Sources (read 2026-11-21 KST): signature and common errors https://api.ncloud-docs.com/docs/sens-overview ·
 * SMS send/list/result https://api.ncloud-docs.com/docs/sens-sms-{send,list,get} · AlimTalk send/result
 * https://api.ncloud-docs.com/docs/sens-alimtalk-{send,get} · Brand Message send/result (night lock
 * 20:50–08:00) https://api.ncloud-docs.com/docs/sens-brandmessage-{send,get} · Mail request create/get
 * https://api.ncloud-docs.com/docs/sens-mail-request-{create,get}.
 *
 * 202 means accepted; delivery is read separately. The Navis 80-byte QA reply limit stays in the SENS
 * policy; this wire enforces the documented SMS 90-byte and LMS 2,000-byte EUC-KR limits.
 */
export { SENS_LMS_MAX_BYTES, SENS_SMS_MAX_BYTES, SENS_SUBJECT_MAX_BYTES };

const acceptance = { requestId: str({ min: 1 }), requestTime: str(), statusCode: oneOf(['202']), statusName: oneOf(['success', 'processing', 'reserved']) };
export const smsAcceptanceShape = obj(acceptance);
const smsReservationShape = obj({ reserveId: str(), reserveTimeZone: str(), reserveTime: str(),
  reserveStatus: oneOf(['READY', 'PROCESSING', 'CANCELED', 'FAIL', 'DONE', 'STALE', 'SKIP']) });
const smsMessage = obj({
  requestId: str(), messageId: str({ min: 1 }), requestTime: str(), contentType: oneOf(['COMM', 'AD']), type: oneOf(['SMS', 'LMS']),
  subject: opt(str()), content: opt(str()), countryCode: str(), from: str(), to: str(), status: oneOf(['READY', 'PROCESSING', 'COMPLETED']),
  completeTime: opt(str()), telcoCode: opt(str()), statusCode: opt(str()), statusName: opt(oneOf(['success', 'fail'])), statusMessage: opt(str()),
  files: opt(arr(obj({ fileId: str(), name: str() }))),
});
export const smsListShape = obj({
  statusCode: str(), statusName: str(), requestId: opt(str()), messages: arr(smsMessage), pageSize: int(), pageIndex: int(),
  itemCount: int(), hasMore: bool(), nextToken: opt(str()),
});
export const smsResultShape = obj({ statusCode: str(), statusName: str(), messages: arr(smsMessage) });
const accepted = obj({
  messageId: str({ min: 1 }), countryCode: str(), to: str(), content: opt(str()), requestStatusCode: str(),
  requestStatusName: oneOf(['success', 'fail']), requestStatusDesc: str(), useSmsFailover: bool(),
});
export const bizAcceptanceShape = obj({ ...acceptance, messages: opt(arr(accepted)) });
const failover = obj({
  smsServiceId: opt(str()), requestId: opt(str()), messageId: opt(str()), requestStatusCode: opt(str()), requestStatusName: opt(str()),
  requestStatusDesc: opt(str()), messageStatus: opt(str()), messageStatusCode: opt(str()), messageStatusName: opt(str()), messageStatusDesc: opt(str()),
});
const delivery = {
  messageId: str(), countryCode: str(), to: str(), requestStatusCode: str(), requestStatusName: oneOf(['success', 'fail']), requestStatusDesc: str(),
  useSmsFailover: bool(), requestId: str(), requestTime: str(), plusFriendId: str(), content: str(), completeTime: opt(str()),
  messageStatusCode: opt(str()), messageStatusName: oneOf(['success', 'processing', 'fail']), messageStatusDesc: opt(str()), failover: opt(failover),
  buttons: opt(arr(obj({}))),
};
export const alimTalkResultShape = obj({ ...delivery, templateCode: str() });
export const brandResultShape = obj({
  ...delivery, messageType: oneOf(['TEXT']), targeting: oneOf(['M', 'N', 'I']), isAdult: bool(), templateCode: opt(str()),
  templateParameters: opt(obj({})), coupon: opt(obj({})),
});
export const mailAcceptanceShape = obj({ requestId: str({ min: 1 }), requestCount: int({ min: 0 }), createDateTime: str() });
export const mailRequestShape = obj({
  requestId: str(), requestCount: int(), createDateTime: str(),
  status: oneOf(['PREPARING', 'READY', 'RESERVED', 'SENDING', 'COMPLETED', 'FAILED', 'PARTIAL_FAILED', 'CANCELED']),
  readyCount: int(), sentCount: int(), finishCount: int(), reservationDateTime: nul(str()),
  countsByStatus: arr(obj({ status: str(), count: int() })),
});

const SERVICE_ID = /^[A-Za-z0-9:_-]{1,180}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const kstMinutes = (now: Date) => ((now.getUTCHours() + 9) % 24) * 60 + now.getUTCMinutes();
/** Advertising SMS at night needs separate consent (정보통신망법 제50조); Navis refuses it instead. */
export const advertisingNight = (now: Date) => { const minutes = kstMinutes(now); return minutes >= 21 * 60 || minutes < 8 * 60; };
/** Brand Message documents a 20:50–08:00 sending lock. */
export const brandNight = (now: Date) => { const minutes = kstMinutes(now); return minutes >= 20 * 60 + 50 || minutes < 8 * 60; };

function within(text: unknown, max: number, detail: string): asserts text is string {
  if (typeof text !== 'string' || !text.trim() || eucKrBytes(text) > max) throw new NaverAdapterError('INVALID_INPUT', { detail });
}

function failure(result: CallResult, write: boolean): never {
  let body: Record<string, unknown> = {};
  try { body = (parseJson(result) ?? {}) as Record<string, unknown>; } catch { /* non-JSON error */ }
  const nested = body.error as Record<string, unknown> | undefined;
  const code = [nested?.errorCode, body.error, body.errors].find(value => typeof value === 'string') as string | undefined;
  const info = { providerStatus: result.status, providerCode: code?.slice(0, 32) };
  if (result.status === 401 || result.status === 403) throw new NaverAdapterError('FORBIDDEN', info);
  if (result.status === 404) throw new NaverAdapterError('NOT_FOUND', info);
  if (result.status === 429) throw new NaverAdapterError('RATE_LIMITED', info);
  if (result.status >= 400 && result.status < 500 && result.status !== 408) throw new NaverAdapterError('REJECTED', info);
  throw new NaverAdapterError(write ? 'UNKNOWN_OUTCOME' : 'UNAVAILABLE', info);
}

export interface SensServiceIds { sms?: string; alimtalk?: string; brandmessage?: string; mail?: string }

export function createSensWire(provider: Provider, options: {
  serviceIds: SensServiceIds; clock?: { now(): Date }; liveApproval?: symbol;
}) {
  const now = () => (options.clock ?? { now: () => new Date() }).now();
  const service = (product: keyof SensServiceIds) => {
    const value = options.serviceIds[product];
    if (!value || !SERVICE_ID.test(value)) throw new NaverAdapterError('NOT_CONFIGURED', { detail: `${product}ServiceId` });
    // The official examples keep the NRN colons unescaped in the signed path.
    return value;
  };
  async function send<T>(operation: OperationId, path: string, expect: number, shape: Shape, body?: object, signal?: AbortSignal, attemptKey?: string): Promise<T> {
    const write = body !== undefined;
    const result = await call(provider, operation, path, {
      signal, approvalScope: options.liveApproval,
      headers: write ? { 'content-type': 'application/json', ...(attemptKey && { 'idempotency-key': attemptKey }) } : undefined, body: write ? JSON.stringify(body) : undefined,
    });
    if (result.status !== expect) failure(result, write);
    return project<T>(shape, parseJson(result), { strict: provider.strict });
  }
  const messageId = (value: string) => {
    if (!MESSAGE_ID.test(value)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'messageId' });
    return value;
  };

  return {
    async sendSms(input: { type: 'SMS' | 'LMS'; contentType: 'COMM' | 'AD'; from: string; to: string[]; content: string; subject?: string; reserveTime?: string; reserveTimeZone?: 'Asia/Seoul'; attemptKey?: string; signal?: AbortSignal }) {
      if (!validSmsNumber(input.from) || !input.to.length || input.to.length > 100 || !input.to.every(validSmsNumber)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'numbers' });
      within(input.content, input.type === 'SMS' ? SENS_SMS_MAX_BYTES : SENS_LMS_MAX_BYTES, 'content');
      if (input.subject !== undefined) {
        if (input.type !== 'LMS') throw new NaverAdapterError('INVALID_INPUT', { detail: 'subject' });
        within(input.subject, SENS_SUBJECT_MAX_BYTES, 'subject');
      }
      // The durable attempt key is the virtual server's private idempotent replay; live SENS has no such header.
      if (input.attemptKey !== undefined && (!provider.strict || !attemptKeyPattern.test(input.attemptKey))) {
        throw new NaverAdapterError('INVALID_INPUT', { detail: 'attemptKey' });
      }
      let sendAt = now();
      if (input.reserveTime !== undefined) {
        const local = input.reserveTime;
        const timestamp = new Date(local.replace(' ', 'T') + ':00+09:00');
        if (!/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(local) || !Number.isFinite(+timestamp)
          || new Date(+timestamp + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') !== local
          || +timestamp - +sendAt <= 600_000 || input.reserveTimeZone !== 'Asia/Seoul' || (!provider.strict && !options.liveApproval)) {
          throw new NaverAdapterError('INVALID_INPUT', { detail: 'reserveTime' });
        }
        sendAt = timestamp;
      } else if (input.reserveTimeZone !== undefined) {
        throw new NaverAdapterError('INVALID_INPUT', { detail: 'reserveTimeZone' });
      }
      if (input.contentType === 'AD' && (!input.content.startsWith('(광고)') || advertisingNight(sendAt))) {
        throw new NaverAdapterError('INVALID_INPUT', { detail: 'advertising' });
      }
      const body = {
        type: input.type, contentType: input.contentType, countryCode: '82', from: input.from,
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.reserveTime !== undefined && { reserveTime: input.reserveTime, reserveTimeZone: input.reserveTimeZone }),
        content: input.content, messages: input.to.map(to => ({ to })),
      };
      return send<MessageAcceptance>('pn13.sms.send', `/sms/v2/services/${service('sms')}/messages`, 202, smsAcceptanceShape, body, input.signal, input.attemptKey);
    },
    async reservationStatus(id: string, signal?: AbortSignal) {
      if (!provider.strict && !options.liveApproval) throw new NaverAdapterError('FORBIDDEN');
      return send<SmsReservation>('pn13.sms.reservation-status',
        `/sms/v2/services/${service('sms')}/reservations/${messageId(id)}/reserve-status`,
        200, smsReservationShape, undefined, signal);
    },
    async cancelReservation(id: string, signal?: AbortSignal) {
      if (!provider.strict && !options.liveApproval) throw new NaverAdapterError('FORBIDDEN');
      const result = await call(provider, 'pn13.sms.reservation-delete',
        `/sms/v2/services/${service('sms')}/reservations/${messageId(id)}`, { signal, approvalScope: options.liveApproval });
      if (result.status !== 204) failure(result, true);
    },
    listSms: (requestId: string, signal?: AbortSignal) =>
      send<{ messages: SmsResult['messages'] }>('pn13.sms.list', `/sms/v2/services/${service('sms')}/messages?requestId=${encodeURIComponent(requestId)}`, 200, smsListShape, undefined, signal),
    getSms: (id: string, signal?: AbortSignal) =>
      send<SmsResult>('pn13.sms.get', `/sms/v2/services/${service('sms')}/messages/${messageId(id)}`, 200, smsResultShape, undefined, signal),

    /** Information-only approved template; SMS failover stays off unless separately approved. */
    async sendAlimTalk(input: { plusFriendId: string; templateCode: string; messages: { to: string; content: string }[]; signal?: AbortSignal }) {
      if (!input.plusFriendId || !input.templateCode || !input.messages.length || input.messages.length > 100
        || !input.messages.every(message => validSmsNumber(message.to) && typeof message.content === 'string' && message.content.trim())) {
        throw new NaverAdapterError('INVALID_INPUT', { detail: 'alimtalk' });
      }
      const body = { plusFriendId: input.plusFriendId, templateCode: input.templateCode,
        messages: input.messages.map(message => ({ countryCode: '82', to: message.to, content: message.content, useSmsFailover: false })) };
      return send<BizAcceptance>('pn13.alimtalk.send', `/alimtalk/v2/services/${service('alimtalk')}/messages`, 202, bizAcceptanceShape, body, input.signal);
    },
    getAlimTalk: (id: string, signal?: AbortSignal) =>
      send<AlimTalkResult>('pn13.alimtalk.get', `/alimtalk/v2/services/${service('alimtalk')}/messages/${messageId(id)}`, 200, alimTalkResultShape, undefined, signal),

    /** Free-text Brand Message to the channel's consented targeting group, outside the night lock. */
    async sendBrandText(input: { plusFriendId: string; targeting: 'I' | 'M' | 'N'; messages: { to: string; content: string }[]; signal?: AbortSignal }) {
      if (brandNight(now())) throw new NaverAdapterError('REJECTED', { detail: 'night-lock' });
      if (!input.plusFriendId || !['I', 'M', 'N'].includes(input.targeting) || !input.messages.length || input.messages.length > 100
        || !input.messages.every(message => validSmsNumber(message.to) && typeof message.content === 'string' && message.content.trim()
          && Array.from(message.content).length <= 1_300)) {
        throw new NaverAdapterError('INVALID_INPUT', { detail: 'brand' });
      }
      const body = { plusFriendId: input.plusFriendId, messageType: 'TEXT', targeting: input.targeting,
        messages: input.messages.map(message => ({ countryCode: '82', to: message.to, content: message.content, useSmsFailover: false })) };
      return send<BizAcceptance>('pn13.brandmessage.send', `/brandmessage/v2/services/${service('brandmessage')}/messages`, 202, bizAcceptanceShape, body, input.signal);
    },
    getBrand: (id: string, signal?: AbortSignal) =>
      send<BrandMessageResult>('pn13.brandmessage.get', `/brandmessage/v2/services/${service('brandmessage')}/messages/${messageId(id)}`, 200, brandResultShape, undefined, signal),

    /** Supplier or notice mail: individual, non-advertising, explicit recipients. */
    async sendMail(input: { senderAddress: string; senderName?: string; title: string; body: string; to: { address: string; name?: string }[]; signal?: AbortSignal }) {
      const email = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,}$/;
      if (!email.test(input.senderAddress) || !input.to.length || input.to.length > 100 || !input.to.every(item => email.test(item.address))
        || typeof input.title !== 'string' || !input.title.trim() || Buffer.byteLength(input.title) > 500
        || typeof input.body !== 'string' || !input.body.trim() || Buffer.byteLength(input.body) > 500 * 1024) {
        throw new NaverAdapterError('INVALID_INPUT', { detail: 'mail' });
      }
      const body = {
        senderAddress: input.senderAddress, ...(input.senderName ? { senderName: input.senderName } : {}), title: input.title, body: input.body,
        individual: true, advertising: false,
        recipients: input.to.map(item => ({ address: item.address, ...(item.name ? { name: item.name } : {}), type: 'TO' })),
      };
      return send<MailAcceptance>('pn13.mail.send', `/mail/v2/services/${service('mail')}/requests`, 202, mailAcceptanceShape, body, input.signal);
    },
    getMailRequest: (requestId: string, signal?: AbortSignal) =>
      send<MailRequestResult>('pn13.mail.request', `/mail/v2/services/${service('mail')}/requests/${messageId(requestId)}`, 200, mailRequestShape, undefined, signal),
  };
}

export type SensWire = ReturnType<typeof createSensWire>;

/** SMS request status and reception result → existing ledger delivery state. */
export function smsDelivery(message: { status: string; statusName?: string }): 'delivered' | 'failed' | undefined {
  if (message.status !== 'COMPLETED') return undefined;
  return message.statusName === 'success' ? 'delivered' : 'failed';
}

/**
 * Provider transport for the existing test-SMS worker (`createSensWorker`). The worker only accepts
 * `kind: 'fake'`, which here means synthetic persona or fake transport with zero real SENS I/O; a live
 * binding is refused until the worker owner widens that gate under A6.
 */
export function createVirtualSensTransport(wire: SensWire, mode: 'fake' | 'virtual' | 'live'): FakeSensTransport {
  if (mode === 'live') throw new Error('The test SMS worker accepts only synthetic SENS transport');
  return {
    kind: 'fake',
    async send(input, signal): Promise<ProviderOutcome> {
      try {
        const result = await wire.sendSms({ type: 'SMS', contentType: 'COMM', from: input.senderNumber, to: [input.number], content: input.body, signal });
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(result.requestId)) return { state: 'unknown' };
        return { state: 'accepted', requestId: result.requestId };
      } catch (error) {
        // A documented 4xx refusal is a definitive no-send for this request; anything else stays unknown.
        if (error instanceof NaverAdapterError && ['REJECTED', 'FORBIDDEN', 'RATE_LIMITED', 'INVALID_INPUT', 'NOT_FOUND'].includes(error.code)) return { state: 'not_sent' };
        return { state: 'unknown' };
      }
    },
    async reconcile(input, signal): Promise<ProviderOutcome> {
      // SENS has no lookup by our dispatch identity; without a request ID the attempt stays pending.
      if (!input.requestId) return { state: 'unknown' };
      try {
        const { messages } = await wire.listSms(input.requestId, signal);
        if (!messages.length) return { state: 'unknown' };
        return { state: 'accepted', requestId: input.requestId, delivery: smsDelivery(messages[0]) };
      } catch {
        return { state: 'unknown' };
      }
    },
  };
}
