import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { NaverAdapterError } from '../../naver/errors.ts';
import { parseTalkTalkEvent, type InboundEvent } from '../../naver/pn06-talktalk.ts';
import { isUuid } from '../../promo/contracts.ts';
import { NoticeError } from './wire.ts';

const sendUrl = 'https://gw.talk.naver.com/chatbot/v1/event';
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const hash = (value: string) => createHash('sha256').update(value).digest();
type InquiryEvent = Extract<InboundEvent, { kind: 'inquiry' }>;

export function createLiveTalkTalk(env: NodeJS.ProcessEnv, transport = fetch) {
  const storeId = env.NAVIS_TALKTALK_STORE_ID?.toLowerCase();
  const webhookToken = env.NAVIS_TALKTALK_WEBHOOK_TOKEN?.trim();
  const key = env.NAVIS_TALKTALK_SEND_KEY?.trim();
  if (!storeId || !isUuid(storeId) || !webhookToken || !tokenPattern.test(webhookToken) || !key) return;

  return {
    storeId, webhookToken,
    async sendReply(user: string, text: string) {
      let response: Response;
      try {
        response = await transport(sendUrl, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(5_000),
          headers: { 'content-type': 'application/json;charset=UTF-8', authorization: key },
          body: JSON.stringify({ event: 'send', user, textContent: { text } }),
        });
      } catch {
        throw new NaverAdapterError('UNKNOWN_OUTCOME');
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        if ([400, 401, 403, 429].includes(response.status)) throw new NoticeError(409, 'UNAVAILABLE');
        throw new NaverAdapterError('UNKNOWN_OUTCOME');
      }
      const result = await response.json().catch(() => null);
      if (result?.success === true && result.resultCode === '00') return { state: 'accepted' as const };
      if (result?.success === false && ['01', '02', '99'].includes(result.resultCode)) {
        throw new NoticeError(409, 'UNAVAILABLE');
      }
      throw new NaverAdapterError('UNKNOWN_OUTCOME');
    },
  };
}

export function registerLiveTalkTalkWebhook(app: FastifyInstance, token: string,
  receive: (event: InquiryEvent) => Promise<void>) {
  const expected = hash(token);
  app.post<{ Params: { token: string } }>('/hooks/talktalk/:token', {
    bodyLimit: 32 * 1024,
    async onRequest(request, reply) {
      reply.header('cache-control', 'no-store');
      if (!timingSafeEqual(expected, hash(request.params.token))) {
        return reply.code(404).send({ code: 'NOT_FOUND' });
      }
    },
  }, async (request, reply) => {
    let event: InboundEvent;
    try { event = parseTalkTalkEvent(request.body, false); }
    catch { return reply.code(400).send({ code: 'INVALID_REQUEST' }); }
    // Acknowledge once the local insert commits. No send API call or remote work is part of receiving.
    if (event.kind === 'inquiry') {
      if (event.text.includes('\0')) return reply.code(400).send({ code: 'INVALID_REQUEST' });
      try { await receive(event); }
      catch {
        request.log.error('TalkTalk inbox write failed');
        return reply.code(503).send({ code: 'UNAVAILABLE' });
      }
    }
    return reply.code(200).send();
  });
}
