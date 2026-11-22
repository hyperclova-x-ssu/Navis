import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  talkTalkConsultationTabs, talkTalkReplyPath, talkTalkWebhookPath, type Consultation, type TalkTalkResult,
} from '../../../packages/naver/contracts/pn06/index.ts';
import type { Provider } from './binding.ts';
import { NaverAdapterError } from './errors.ts';
import { arr, bool, check, obj, oneOf, opaqueRef, opt, project, str } from './schema.ts';
import { attemptKeyPattern, call, ownerText, parseJson, partner, segment } from './transport.ts';

/**
 * PN06 TalkTalk for marketing B15: retained owner-visible consultations (O, persona) and the published
 * Chat Bot API V1 (W) for new inbound events and owner-approved replies.
 * Contract: packages/naver/contracts/pn06 · persona capability pn06.
 *
 * Sources: https://github.com/navertalk/chatbot-api/blob/master/README.md (webhook events, 보내기 API,
 * error table) · TalkTalk partner service https://help.naver.com/service/11830/contents/3614?lang=ko · period
 * https://help.naver.com/service/11830/contents/23823 · tabs 대기·진행중·보류·완료·차단·스팸함
 * https://help.naver.com/service/11830/contents/24283.
 * Excluded: export, deleted/invisible history, profile/contact fields, member merge, push guarantees.
 */
export const CONSULTATION_TABS = talkTalkConsultationTabs;
export type ConsultationTab = typeof talkTalkConsultationTabs[number];

export const consultationShape = obj({ ref: opaqueRef, status: oneOf(talkTalkConsultationTabs), messages: arr(obj({ text: str() }), { max: 1_000 }) });
const consultationList = obj({ items: arr(consultationShape, { max: 100 }) });
export const chatbotResultShape = obj({ success: bool(), resultCode: oneOf(['00', '01', '02', '99']), resultMessage: opt(str()) });

/** Inbound events emitted by the provider (contract `TalkTalkEvent`, README 이벤트 구조). */
export const TALKTALK_EVENTS = ['open', 'leave', 'friend', 'send', 'echo', 'action', 'persistentMenu'] as const;
export const inboundEventShape = obj({
  event: oneOf(TALKTALK_EVENTS), user: str({ min: 1, max: 200 }), options: opt(obj({})),
  textContent: opt(obj({ text: str({ max: 10_000 }), code: opt(str({ max: 1_000 })), inputType: opt(str({ max: 20 })) })),
  imageContent: opt(obj({})), compositeContent: opt(obj({})), echoedEvent: opt(str({ max: 40 })), partner: opt(str({ max: 100 })),
});

const USER = /^[A-Za-z0-9_-]{1,200}$/;
export type InboundEvent =
  | { kind: 'inquiry'; user: string; text: string; inputType: string | null; correlation: string }
  | { kind: 'echo'; user: string; text: string | null; echoedEvent: string | null; correlation: string }
  | { kind: 'other'; event: string; user: string };

const OPAQUE_PARTS = ['options', 'imageContent', 'compositeContent'] as const;

/**
 * Normalize one inbound event. The published wire has no event ID, so `correlation` is a content
 * fingerprint; the receiving ledger combines it with its receive window to persist once.
 */
export function parseTalkTalkEvent(body: unknown, strict: boolean): InboundEvent {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NaverAdapterError('INVALID_INPUT', { detail: '$' });
  // `options` and non-text contents carry documented nested keys that Navis neither stores nor forwards.
  const envelope: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const part of OPAQUE_PARTS) {
    const value = envelope[part];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new NaverAdapterError('INVALID_INPUT', { detail: `$.${part}` });
    if (value !== undefined) envelope[part] = {};
  }
  check(inboundEventShape, envelope, { strict, code: 'INVALID_INPUT' });
  const event = body as { event: string; user: string; textContent?: { text: string; code?: string; inputType?: string }; echoedEvent?: string };
  if (!USER.test(event.user)) throw new NaverAdapterError('INVALID_INPUT', { detail: '$.user' });
  const text = event.textContent?.text ?? null;
  const correlation = createHash('sha256').update(JSON.stringify([
    event.event, event.user, text, event.textContent?.inputType ?? null, event.textContent?.code ?? null, event.echoedEvent ?? null,
  ])).digest('hex');
  if (event.event === 'send' && text !== null && text.trim()) return { kind: 'inquiry', user: event.user, text, inputType: event.textContent?.inputType ?? null, correlation };
  if (event.event === 'echo') return { kind: 'echo', user: event.user, text, echoedEvent: event.echoedEvent ?? null, correlation };
  return { kind: 'other', event: event.event, user: event.user };
}

export function createTalkTalkPort(provider: Provider) {
  return {
    /** Retained owner-visible consultations; `status` omitted is the 전체 tab. Period is KST dates. */
    async listConsultations(input: { status?: ConsultationTab; from?: string; to?: string; limit?: number; offset?: number; signal?: AbortSignal } = {}) {
      if (input.status !== undefined && !talkTalkConsultationTabs.includes(input.status)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'status' });
      for (const day of [input.from, input.to]) if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'period' });
      const { json } = await partner(provider, 'pn06.consultations.list', {
        path: '/talktalk/consultations', signal: input.signal,
        query: { status: input.status, from: input.from, to: input.to, limit: input.limit, offset: input.offset },
      });
      return project<{ items: Consultation[] }>(consultationList, json, { strict: provider.strict });
    },

    async getConsultation(ref: string, signal?: AbortSignal) {
      const { json } = await partner(provider, 'pn06.consultations.get', { path: `/talktalk/consultations/${segment(ref)}`, signal });
      return project<Consultation>(consultationShape, json, { strict: provider.strict });
    },

    /**
     * Owner-approved reply through the published 보내기 API (text only, no push option). Acceptance is
     * separate from delivery and from consultation state. The official wire has no lookup; with an
     * attempt key persona binds the Navis attempt, and an unknown outcome stays pending for reconciliation.
     */
    async sendReply(input: { user: string; text: string; attemptKey?: string; signal?: AbortSignal }) {
      if (typeof input.user !== 'string' || !USER.test(input.user)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'user' });
      if (input.attemptKey !== undefined && !attemptKeyPattern.test(input.attemptKey)) throw new NaverAdapterError('INVALID_INPUT', { detail: 'attemptKey' });
      const body = { event: 'send', user: input.user, textContent: { text: ownerText(input.text, 10_000, 'text') } };
      const headers: Record<string, string> = { 'content-type': 'application/json;charset=UTF-8' };
      if (input.attemptKey) headers['idempotency-key'] = input.attemptKey;
      const result = await call(provider, 'pn06.chatbot.send', talkTalkReplyPath, { headers, body: JSON.stringify(body), signal: input.signal });
      if (result.status >= 500) throw new NaverAdapterError('UNKNOWN_OUTCOME', { providerStatus: result.status });
      if (result.status !== 200) throw new NaverAdapterError(result.status === 401 || result.status === 403 ? 'FORBIDDEN' : 'REJECTED', { providerStatus: result.status });
      const outcome = project<TalkTalkResult>(chatbotResultShape, parseJson(result), { strict: provider.strict });
      if (outcome.success && outcome.resultCode === '00') return { state: 'accepted' as const };
      if (outcome.success) throw new NaverAdapterError('CONTRACT_VIOLATION', { detail: '$.resultCode' });
      throw new NaverAdapterError(outcome.resultCode === '01' ? 'FORBIDDEN' : 'REJECTED', { providerCode: outcome.resultCode });
    },
  };
}

export const talkTalkInboundPath = talkTalkWebhookPath;

/**
 * Receive settings-enabled TalkTalk events from persona on the private network at the PN-P0 callback
 * path. Persona and fake callbacks must authenticate with their separate workload credential.
 * `verify` can add another check. `onEvent` persists the event to the B15 inbox ledger.
 */
export function registerTalkTalkInbound(app: FastifyInstance, options: {
  mode: 'fake' | 'virtual' | 'live'; callbackToken?: string;
  onEvent(event: InboundEvent): Promise<void>; verify?: (request: FastifyRequest) => boolean;
}) {
  if (options.mode === 'live') throw new Error('Live TalkTalk inbound needs a verified ingress contract');
  if (!options.callbackToken?.trim()) throw new Error('TalkTalk inbound needs a callback workload credential');
  const expected = createHash('sha256').update(`Bearer ${options.callbackToken}`).digest();
  app.post(talkTalkInboundPath, { bodyLimit: 128 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const authorization = request.headers.authorization;
    if (!authorization || !timingSafeEqual(expected, createHash('sha256').update(authorization).digest())
      || (options.verify && !options.verify(request))) return reply.code(401).send({ code: 'UNAUTHENTICATED' });
    let event: InboundEvent;
    try { event = parseTalkTalkEvent(request.body, true); }
    catch { return reply.code(400).send({ code: 'INVALID_REQUEST' }); }
    try { await options.onEvent(event); }
    catch { return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE' }); }
    // A 200 without a body acknowledges the event without an automatic reply (README 이벤트 기본 구조).
    return reply.code(200).send();
  });
}
