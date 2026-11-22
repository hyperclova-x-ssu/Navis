import { createHmac } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSensWire } from '../../../../workers/marketing-worker/naver/pn13-sens.ts';
import { createMarketingProvider } from '../../../marketing/naver/binding.ts';
import { createPersonaApp } from '../../app.ts';
import { migratePersona } from '../../migrate.ts';
import { createPersonaSeedContext, seedPersona } from '../../seed.ts';
import { personaCapability as pn13 } from './index.ts';
import { personaCapability as pn14 } from '../pn14/index.ts';
import { personaCapability as pn15 } from '../pn15/index.ts';

const now = new Date('2026-11-17T06:45:00.000Z');
const databaseUrl = process.env.PN_P4_TEST_DATABASE_URL;
const pool = new pg.Pool({ connectionString: databaseUrl, options: '-c role=nvirtual_run' });
const account = 'pn-p4-test';
const token = 'fixture-transport-token-pn-p4';
const otherToken = 'fixture-transport-token-pn-p4-other';
const studio = { authorization: 'Bearer fixture-studio' };
const speech = { 'x-clovaspeech-api-key': 'fixture-speech', 'content-type': 'application/octet-stream' };
const receipt = { 'x-ocr-secret': 'fixture-receipt' };
const ocrPath = '/custom/v1/fixture-domain/fixture-invoke/document/receipt';
const serviceIds = { sms: 'ncp:sms:kr:0:fixture', alimtalk: 'ncp:kkobizmsg:kr:0:fixture',
  brandmessage: 'ncp:kkobizmsg:kr:0:fixture', mail: 'ncp:mail:kr:0:fixture' };
const capabilities = [pn13, pn14, pn15];
const providerCredentials = {
  ...Object.fromEntries(Object.entries(serviceIds).flatMap(([product, serviceId]) =>
    (product === 'mail' ? ['send', 'list', 'get', 'mails', 'request'] : product === 'sms' ? ['send', 'list', 'get', 'reservation-delete', 'reservation-status'] : ['send', 'list', 'get']).map(action =>
      [`pn13.${product}.${action}`, { accessKey: 'fixture-access', secretKey: 'fixture-signing', serviceId,
        sender: product === 'mail' ? 'owner@example.test' : '01000000000', plusFriendId: '@fixture-cafe',
        templateCode: 'cafe-order', consentedRecipients: '01000000001,01000000002', channelFriends: '01000000001',
        ...(product === 'brandmessage' && { templateText: '이번 주 #{menu} 소식' }),
      }]))),
  'pn14.chat': { apiKey: 'fixture-studio' },
  'pn14.tokenize': { apiKey: 'fixture-studio' },
  'pn15.speech': { secret: 'fixture-speech' },
  'pn15.receipt': { secret: 'fixture-receipt', domainId: 'fixture-domain', invokeKey: 'fixture-invoke' },
};
const app = createPersonaApp({
  pool, capabilities, now: () => now, logging: false,
  grants: [
    { workload: 'pn-p4-proof', accountId: account, token, operations: Object.keys(providerCredentials), providerCredentials },
    { workload: 'pn-p4-other', accountId: 'other-cafe', token: otherToken, operations: ['pn13.sms.get'], providerCredentials },
  ],
});
let base: string | undefined;

beforeAll(async () => {
  if (databaseUrl) {
    const admin = new pg.Pool({ connectionString: databaseUrl });
    try {
      await admin.query('CREATE ROLE nvirtual_run; CREATE SCHEMA naver_virtual; GRANT USAGE ON SCHEMA naver_virtual TO nvirtual_run');
      await migratePersona(admin, capabilities);
      await seedPersona(admin, capabilities, { ...createPersonaSeedContext(now), accountId: account });
    } finally {
      await admin.end();
    }
    base = await app.listen({ host: '127.0.0.1', port: 0 });
  } else await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function call(method: 'POST' | 'GET' | 'DELETE', url: string, headers: Record<string, string> = {},
  payload?: object | Buffer) {
  headers = { 'x-navis-naver-virtual-account': account, 'x-navis-naver-virtual-token': token, ...headers };
  if (!base) return app.inject({ method, url, headers, payload });
  const response = await fetch(base + url, {
    method, headers: !payload || Buffer.isBuffer(payload)
      ? headers : { 'content-type': 'application/json', ...headers },
    body: Buffer.isBuffer(payload) ? new Uint8Array(payload) : payload && JSON.stringify(payload),
  });
  const body = await response.text();
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body,
    json: () => JSON.parse(body) } as Pick<LightMyRequestResponse, 'statusCode' | 'headers' | 'body' | 'json'>;
}

function sens(method: 'POST' | 'GET' | 'DELETE', url: string, payload?: object, headers?: Record<string, string>) {
  const timestamp = String(now.getTime());
  const signature = createHmac('sha256', 'fixture-signing')
    .update(`${method} ${url}\n${timestamp}\nfixture-access`).digest('base64');
  return call(method, url, {
    'x-ncp-iam-access-key': 'fixture-access', 'x-ncp-apigw-timestamp': timestamp,
    'x-ncp-apigw-signature-v2': signature, ...(payload && { 'content-type': 'application/json' }), ...headers,
  }, payload);
}

function keys(value: object, names: string) {
  expect(Object.keys(value).sort()).toEqual(names.split(' ').sort());
}

describe('SENS official product envelopes', () => {
  const smsPath = '/sms/v2/services/ncp:sms:kr:0:fixture/messages';
  const sms = { type: 'SMS', from: '01000000000', content: '주문 안내', messages: [{ to: '01000000001' }] };

  it('rejects an unregistered sender and a broken SENS signature', async () => {
    const invalid = await sens('POST', smsPath, { ...sms, from: '01000000099' });
    expect(invalid.statusCode).toBe(400);
    keys(invalid.json(), 'status error message');
    const unsigned = await call('POST', smsPath, {}, sms);
    expect(unsigned.statusCode).toBe(401);
  });

  it('rejects unapproved Brand recipients and mismatched AlimTalk content', async () => {
    const messages = [{ to: '01000000002', content: '할인 소식' }];
    const brand = await sens('POST', '/brandmessage/v2/services/ncp:kkobizmsg:kr:0:fixture/messages', {
      plusFriendId: '@fixture-cafe', messageType: 'TEXT', targeting: 'I', messages,
    });
    expect(brand.statusCode).toBe(400);
    const alimtalk = await sens('POST', '/alimtalk/v2/services/ncp:kkobizmsg:kr:0:fixture/messages', {
      plusFriendId: '@fixture-cafe', templateCode: 'cafe-order', messages,
    });
    expect(alimtalk.statusCode).toBe(400);
  });

  it.skipIf(!databaseUrl)('persists SMS acceptance then exposes per-message state and metering', async () => {
    const send = await sens('POST', smsPath, { ...sms, content: '가'.repeat(47) });
    expect(send.statusCode).toBe(202);
    const accepted = send.json();
    keys(accepted, 'requestId requestTime statusCode statusName');
    expect(accepted).toMatchObject({ statusCode: '202', requestTime: '2026-11-17T15:45:00.000' });

    const list = (await sens('GET', `${smsPath}?requestId=${accepted.requestId}`)).json();
    keys(list, 'statusCode statusName messages pageSize pageIndex itemCount hasMore');
    const [message] = list.messages;
    expect(message).toMatchObject({ requestId: accepted.requestId, status: 'COMPLETED', statusCode: '0' });
    const detail = (await sens('GET', `${smsPath}/${message.messageId}`)).json();
    keys(detail, 'statusCode statusName messages');
    keys(detail.messages[0], 'requestId messageId requestTime contentType type subject content countryCode from to completeTime telcoCode status statusCode statusName statusMessage');
    expect(detail.messages[0].content).toBe('가'.repeat(45));
    const inaccessible = await sens('GET', `${smsPath}/${message.messageId}`, undefined,
      { 'x-navis-naver-virtual-account': 'other-cafe', 'x-navis-naver-virtual-token': otherToken });
    expect(inaccessible.statusCode).toBe(404);
  });

  it.skipIf(!databaseUrl)('replays an immediate SMS with the same private attempt key and refuses a changed body', async () => {
    const headers = { 'idempotency-key': 'notice-sms:fix-gap-b:0' };
    const body = { ...sms, contentType: 'AD', content: '(광고) 가게\n소식\n무료수신거부', messages: [{ to: '01000000003' }] };
    const first = await sens('POST', smsPath, body, headers);
    expect(first.statusCode).toBe(202);
    expect(first.json().requestId).toMatch(/^RSLA-/);
    expect((await sens('POST', smsPath, body, headers)).json()).toEqual(first.json());
    expect((await sens('POST', smsPath, { ...body, content: '(광고) 다른 소식' }, headers)).statusCode).toBe(400);
    expect((await sens('GET', `${smsPath}?requestId=${first.json().requestId}`)).json().messages).toHaveLength(1);
  });

  it.skipIf(!databaseUrl)('reads and cancels a pending SMS reservation with the official envelope', async () => {
    const schedule = { ...sms, reserveTime: '2026-11-18 08:00', reserveTimeZone: 'Asia/Seoul' };
    const headers = { 'idempotency-key': 'pn13-sms-reservation-1' };
    const start = await sens('POST', smsPath, schedule, headers);
    expect(start.statusCode).toBe(202);
    expect((await sens('POST', smsPath, schedule, headers)).json()).toEqual(start.json());
    const reserveId = start.json().requestId;
    const path = smsPath.replace('/messages', '/reservations/') + reserveId;
    const status = () => sens('GET', path + '/reserve-status');
    expect((await status()).json()).toEqual({ reserveId, reserveTimeZone: 'Asia/Seoul',
      reserveTime: '2026-11-18T08:00:00+09:00', reserveStatus: 'READY' });
    expect((await sens('DELETE', path)).statusCode).toBe(204);
    expect((await status()).json().reserveStatus).toBe('CANCELED');
    expect((await sens('GET', smsPath + '?requestId=' + reserveId)).json().messages).toEqual([]);
  });

  it.skipIf(!databaseUrl)('uses PN-A2 signed virtual wire for a scheduled advertising SMS at 08:00', async () => {
    const provider = createMarketingProvider({
      storeId: 'test-store', providerAccount: account, mode: 'virtual', virtualOrigin: 'http://naver-virtual:3000',
      privateTokenFile: 'virtual-token', credentialFiles: { sens: 'synthetic-sens' },
      operations: ['pn13.sms.send', 'pn13.sms.reservation-status', 'pn13.sms.reservation-delete'],
      now: () => now,
      readCredential: path => path === 'virtual-token' ? token : JSON.stringify({
        accessKey: 'fixture-access', secretKey: 'fixture-signing',
      }),
      fetcher: (url, init) => {
        const target = new URL(String(url));
        return fetch(base! + target.pathname + target.search, init);
      },
    });
    const wire = createSensWire(provider, { serviceIds, clock: { now: () => now } });
    const input = { type: 'SMS', contentType: 'AD', from: sms.from, to: [sms.messages[0].to],
      content: '(광고) 새 소식', reserveTimeZone: 'Asia/Seoul', attemptKey: 'pn13-signed-reservation' } as const;
    await expect(wire.sendSms({ ...input, to: [...input.to], reserveTime: '2026-11-17 21:00' })).rejects
      .toMatchObject({ code: 'INVALID_INPUT' });
    const accepted = await wire.sendSms({ ...input, to: [...input.to], reserveTime: '2026-11-18 08:00' });
    expect((await wire.reservationStatus(accepted.requestId)).reserveStatus).toBe('READY');
    await wire.cancelReservation(accepted.requestId);
    expect((await wire.reservationStatus(accepted.requestId)).reserveStatus).toBe('CANCELED');
  });

  it.skipIf(!databaseUrl)('uses distinct AlimTalk and Brand acceptance plus result fields', async () => {
    const to = '01000000001';
    const common = { plusFriendId: '@fixture-cafe', messages: [{ to, content: '주문 안내' }] };
    for (const [product, fields] of [
      ['alimtalk', { templateCode: 'cafe-order' }],
      ['brandmessage', { messageType: 'TEXT', targeting: 'I' }],
    ] as const) {
      const url = `/${product}/v2/services/ncp:kkobizmsg:kr:0:fixture/messages`;
      const send = await sens('POST', url, { ...common, ...fields });
      expect(send.statusCode).toBe(202);
      const accepted = send.json();
      keys(accepted, 'requestId requestTime statusCode statusName messages');
      const [message] = accepted.messages;
      keys(message, 'messageId countryCode to requestStatusCode requestStatusName requestStatusDesc useSmsFailover'
        + (product === 'alimtalk' ? ' content' : ''));
      const detail = (await sens('GET', `${url}/${message.messageId}`)).json();
      const deliveryFields = 'messageId countryCode to requestStatusCode requestStatusName requestStatusDesc useSmsFailover'
        + ' content requestId plusFriendId requestTime completeTime messageStatusCode messageStatusName messageStatusDesc';
      keys(detail, deliveryFields + (product === 'alimtalk' ? ' templateCode' : ' messageType isAdult targeting'));
      expect(detail).toMatchObject({ ...fields, requestId: accepted.requestId, messageStatusCode: '0000' });
      const list = (await sens('GET', `${url}?requestId=${accepted.requestId}`)).json();
      keys(list, 'statusCode statusName messages pageSize pageIndex itemCount hasMore'
        + (product === 'alimtalk' ? ' requestId' : ''));
      expect(list.messages[0].messageId).toBe(message.messageId);
    }
  });

  it.skipIf(!databaseUrl)('returns Brand template parameters only on the documented detailed result', async () => {
    const url = '/brandmessage/v2/services/ncp:kkobizmsg:kr:0:fixture/messages';
    const sent = await sens('POST', url, { plusFriendId: '@fixture-cafe', messageType: 'TEXT',
      targeting: 'N', templateCode: 'cafe-order', messages: [
        { to: '01000000002', templateParameters: { menu: '휘낭시에' } },
      ] });
    expect(sent.statusCode).toBe(202);
    const accepted = sent.json();
    const detail = (await sens('GET', `${url}/${accepted.messages[0].messageId}`)).json();
    expect(detail).toMatchObject({ targeting: 'N', templateCode: 'cafe-order',
      content: '이번 주 휘낭시에 소식', templateParameters: { menu: '휘낭시에' } });
    const list = (await sens('GET', `${url}?requestId=${accepted.requestId}`)).json();
    expect(list.messages[0].templateParameters).toBeUndefined();
  });

  it.skipIf(!databaseUrl)('keeps scheduled LMS separate from a failed carrier result', async () => {
    const reservation = (await sens('POST', smsPath, { ...sms, type: 'LMS', subject: '발주',
      reserveTime: '2026-11-17 16:00' })).json();
    const scheduled = (await sens('GET', `${smsPath}?requestId=${reservation.requestId}`)).json();
    const pending = (await sens('GET', `${smsPath}/${scheduled.messages[0].messageId}`)).json();
    expect(pending.statusName).toBe('reserved');
    expect(pending.messages[0]).toMatchObject({ subject: '발주', type: 'LMS', status: 'READY' });
    expect(pending.messages[0].completeTime).toBeUndefined();
    const rejected = (await sens('POST', smsPath, { ...sms, content: '☕' })).json();
    const list = (await sens('GET', `${smsPath}?requestId=${rejected.requestId}`)).json();
    expect(list.messages[0]).toMatchObject({ status: 'COMPLETED', statusCode: '3022', statusName: 'fail' });
  });

  it.skipIf(!databaseUrl)('exposes Mail request counts, mail IDs and per-recipient results', async () => {
    const url = '/mail/v2/services/ncp:mail:kr:0:fixture/requests';
    const send = await sens('POST', url, { senderAddress: 'owner@example.test', title: '발주',
      body: '원두 발주', recipients: [{ address: 'supply@example.test' }] });
    expect(send.statusCode).toBe(202);
    const accepted = send.json();
    keys(accepted, 'requestId requestCount createDateTime');
    expect(accepted.requestCount).toBe(1);
    const requestUrl = `${url}/${accepted.requestId}`;
    const detail = (await sens('GET', requestUrl)).json();
    keys(detail, 'requestId status createDateTime requestCount readyCount sentCount finishCount reservationDateTime countsByStatus');
    expect(detail.countsByStatus).toEqual([{ status: 'COMPLETED', count: 1 }]);
    const list = (await sens('GET', `${requestUrl}/mails`)).json();
    keys(list, 'mails totalElements totalPages pageNo pageSize');
    const mail = (await sens('GET', `${requestUrl}/mails/${list.mails[0].mailId}`)).json();
    keys(mail, 'requestId mailId requesterIp createDateTime title templateNo templateName status senderAddress'
      + ' senderName sendDateTime reservationDateTime body advertising attachFiles recipients');
    keys(mail.recipients[0], 'address name type received receivedDateTime status retryCount sendResultCode sendResultMessage');
    expect(mail.recipients[0]).toMatchObject({ status: 'COMPLETED', sendResultCode: 'MAIL_SENT' });
    const period = new URLSearchParams({ fromDateTime: '2026-11-17T15:00:00+09:00',
      toDateTime: '2026-11-17T16:00:00+09:00', requestId: accepted.requestId, status: 'COMPLETED' });
    const requests = (await sens('GET', `${url}?${period}`)).json();
    keys(requests, 'requests totalElements totalPages pageNo pageSize');
    expect(requests.requests).toMatchObject([{ requestId: accepted.requestId, requestCount: 1, recipientCount: 1 }]);
    const missing = await sens('GET', `${url}/unknown`);
    expect(missing.statusCode).toBe(404);
    keys(missing.json(), 'error');
    expect(missing.json().error.errorCode).toBe('NotFound');
  });
});

describe('Studio official v3 modes', () => {
  const url = '/v3/chat-completions/HCX-005';
  const messages = [{ role: 'user', content: '서울 날씨를 알려줘' }];
  const tools = [{ type: 'function', function: { name: 'get_weather', description: '날씨',
    parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } } }];

  it('streams typed tool fragments and a result with arguments and usage', async () => {
    const input = { messages, tools, toolChoice: { type: 'function', function: { name: 'get_weather' } }, maxTokens: 1024 };
    const raw = await call('POST', url, { ...studio, accept: 'text/event-stream' }, input);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toContain('text/event-stream');
    const frames = raw.body.trim().split('\n\n').map(frame => {
      const lines = frame.split('\n');
      expect(lines[0]).toMatch(/^id:\s*\S+/);
      return { event: lines[1].slice(6).trim(), data: JSON.parse(lines[2].slice(5)) };
    });
    expect(frames.map(frame => frame.event)).toEqual(['token', 'token', 'result']);
    expect(frames[0].data.message.toolCalls[0].function).toEqual({ name: 'get_weather' });
    const result = frames[2].data;
    keys(result, 'message finishReason created seed usage');
    expect(result.finishReason).toBe('tool_calls');
    const arguments_ = result.message.toolCalls[0].function.arguments;
    expect(arguments_).toEqual({ location: '서울' });
    expect(JSON.parse(frames[1].data.message.toolCalls[0].function.partialJson)).toEqual(arguments_);
    expect(result.usage.totalTokens).toBe(result.usage.promptTokens + result.usage.completionTokens);
    expect((await call('POST', url, { ...studio, accept: 'text/event-stream' }, input)).body).toBe(raw.body);
  });

  it('keeps image analysis and schema-constrained content in their documented JSON envelope', async () => {
    const image = await call('POST', url, studio, { includeAiFilters: true, messages: [{ role: 'user', content: [
      { type: 'text', text: '매장 사진을 설명해줘' },
      { type: 'image_url', imageUrl: { url: 'https://assets.example.test/cafe.png' } },
    ] }] });
    expect(image.statusCode).toBe(200);
    keys(image.json(), 'status result');
    keys(image.json().result, 'message finishReason created seed usage aiFilter');
    expect(image.json().result.created).toBe(now.getTime());
    expect(image.json().result.aiFilter).toEqual([
      { groupName: 'curse', name: 'discrimination', score: '2', result: 'OK' },
      { groupName: 'curse', name: 'insult', score: '2', result: 'OK' },
      { groupName: 'unsafeContents', name: 'sexualHarassment', score: '2', result: 'OK' },
    ]);
    const output = await call('POST', '/v3/chat-completions/HCX-007', studio, {
      messages, thinking: { effort: 'none' }, maxCompletionTokens: 1024,
      responseFormat: { type: 'json', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
    });
    expect(output.statusCode).toBe(200);
    expect(JSON.parse(output.json().result.message.content)).toEqual({ title: expect.any(String) });
  });

  it('rejects cross-mode payloads with the Studio status envelope', async () => {
    const response = await call('POST', url, studio, { messages, tools, thinking: { effort: 'none' } });
    expect(response.statusCode).toBe(400);
    keys(response.json(), 'status');
    keys(response.json().status, 'code message');
  });

  it('reports tokenizer counts using the v3 message, tool and schema shapes', async () => {
    const response = await call('POST', '/v3/api-tools/chat-tokenize/HCX-005', studio, { messages, tools });
    expect(response.statusCode).toBe(200);
    const result = response.json().result;
    keys(result, 'messages tools');
    expect(result.messages).toEqual([{ role: 'user',
      content: { type: 'text', text: '서울 날씨를 알려줘', count: expect.any(Number) } }]);
    keys(result.tools, 'count');
  });
});

function wav(seconds: number) {
  const bytes = Buffer.alloc(44 + 32_000 * seconds);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  bytes.writeInt16LE(1000, 44);
  return bytes;
}

describe('Speech and Receipt OCR', () => {
  it('returns Speech quota separately from raw recognition text', async () => {
    const response = await call('POST', '/recog/v1/stt?lang=Kor', speech, wav(16));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ quota: 30, text: expect.any(String) });
    const long = await call('POST', '/recog/v1/stt?lang=Kor', speech, wav(61));
    expect(long.statusCode).toBe(413);
    expect(long.json().code).toBe('STT001');
  });

  it('reads V2 JSON and multipart without leaking bytes or adding fields', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGP4DwEMMHYDAFPDB/nfZ/GzAAAAAElFTkSuQmCC', 'base64');
    const meta = { version: 'V2', requestId: 'receipt-fixture', timestamp: now.getTime() };
    const spec = { format: 'png', name: 'receipt.png' };
    const response = await call('POST', ocrPath, receipt, { ...meta, images: [{ ...spec, data: png.toString('base64') }] });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    keys(body, 'version requestId timestamp images');
    keys(body.images[0], 'uid name inferResult message validationResult receipt');
    const result = body.images[0].receipt.result;
    keys(result, 'storeInfo paymentInfo totalPrice subResults');
    expect(result.paymentInfo.date.formatted).toEqual({ year: '2026', month: '11', day: '17' });
    expect(result.totalPrice.price).toMatchObject({ text: '12,000원', confidenceScore: expect.any(Number) });

    const boundary = 'pn-media-fixture';
    const multipart = Buffer.concat([Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${JSON.stringify({ ...meta, images: [spec] })}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\n`),
    png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    expect((await call('POST', ocrPath, { ...receipt, 'content-type': `multipart/form-data; boundary=${boundary}` },
      multipart)).json()).toEqual(body);
  });

  it('returns documented OCR protocol and unreadable-image errors', async () => {
    const invalid = await call('POST', ocrPath, receipt, { version: 'V1' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('0021');
    const unreadable = await call('POST', ocrPath, receipt, {
      version: 'V2', requestId: 'fixture-error', timestamp: now.getTime(), images: [{ name: 'bad', format: 'png', data: 'YWJj' }],
    });
    expect(unreadable.statusCode).toBe(200);
    expect(unreadable.json().images[0]).toMatchObject({ inferResult: 'ERROR', validationResult: { result: 'NO_REQUESTED' } });
    expect(unreadable.json().images[0].receipt).toBeUndefined();
  });
});
