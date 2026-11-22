import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { createLiveTalkTalk, registerLiveTalkTalkWebhook } from './talktalk-live.ts';

const storeId = 'c05409a6-f082-5964-a787-c1ed3184988b';
const webhookToken = 'synthetic-local-webhook-token-0123456789';
const sendKey = 'synthetic-local-send-key';
const settings = { NAVIS_TALKTALK_STORE_ID: storeId, NAVIS_TALKTALK_WEBHOOK_TOKEN: webhookToken, NAVIS_TALKTALK_SEND_KEY: sendKey };
const send = { event: 'send', user: 'al-synthetic-customer', textContent: { text: '오늘 문 여나요?', inputType: 'typing' } };

it('authenticates before parsing, acknowledges inbound text, and ignores echo and lifecycle events', async () => {
  const app = Fastify();
  const receive = vi.fn(async () => {});
  registerLiveTalkTalkWebhook(app, webhookToken, receive);
  try {
    const post = (payload: object, token = webhookToken) => app.inject({ method: 'POST', url: '/hooks/talktalk/' + token, payload });
    expect((await post(send, 'wrong')).statusCode).toBe(404);
    expect((await app.inject({
      method: 'POST', url: '/hooks/talktalk/wrong', headers: { 'content-type': 'application/json' }, payload: 'invalid-json',
    })).statusCode).toBe(404);
    for (const event of ['echo', 'open', 'leave', 'friend']) {
      const response = await post({ ...send, event });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('');
    }
    expect(receive).toHaveBeenCalledTimes(0);
    const response = await post(send);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
    expect(receive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'inquiry', user: send.user, text: send.textContent.text }));
  } finally {
    await app.close();
  }
});

it('disables both real paths without complete settings and uses exactly the official send request', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, resultCode: '00' }));
  expect(createLiveTalkTalk({ ...settings, NAVIS_TALKTALK_SEND_KEY: '' }, transport)).toBeUndefined();
  expect(createLiveTalkTalk({ ...settings, NAVIS_TALKTALK_WEBHOOK_TOKEN: '' }, transport)).toBeUndefined();
  const configured = createLiveTalkTalk(settings, transport)!;
  await expect(configured.sendReply(send.user, '오늘 정상 영업합니다.')).resolves.toEqual({ state: 'accepted' });
  const posted = transport.mock.calls[0]!;
  expect(transport).toHaveBeenCalledTimes(1);
  expect(posted[0]).toBe('https://gw.talk.naver.com/chatbot/v1/event');
  expect(posted[1]).toMatchObject({ method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json;charset=UTF-8', authorization: sendKey } });
  expect(JSON.parse(String(posted[1]?.body))).toEqual({
    event: 'send', user: send.user, textContent: { text: '오늘 정상 영업합니다.' },
  });
});

it('uses the existing send-failure state for an explicit refusal and preserves uncertainty for network errors', async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ success: false, resultCode: '02', resultMessage: 'provider detail' }))
    .mockRejectedValueOnce(new Error('network failure'));
  const { sendReply } = createLiveTalkTalk(settings, transport)!;
  await expect(sendReply(send.user, '답변')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' });
  await expect(sendReply(send.user, '답변')).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
  expect(transport).toHaveBeenCalledTimes(2);
});
