import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSensSms, eucKrBytes } from './sens-sms.mjs';

test('SENS signs the exact SMS v2 path and sends once to a single recipient', async () => {
  const calls = [];
  const sms = createSensSms({
    serviceId: 'ncp:sms:kr:demo:fixture',
    accessKey: 'example-id',
    secretKey: 'example-signing-material',
    senderNumber: '00000000001',
    now: () => 1700000000123,
    fetchImpl: async (...args) => { calls.push(args); return new Response(null, { status: 202 }); },
  });
  assert.equal(sms.available, true);
  await sms.send({ number: '00000000002', body: '안녕하세요.' });
  assert.equal(calls.length, 1);
  const [[url, init]] = calls;
  assert.equal(url, 'https://sens.apigw.ntruss.com/sms/v2/services/ncp:sms:kr:demo:fixture/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['x-ncp-apigw-timestamp'], '1700000000123');
  assert.equal(init.headers['x-ncp-iam-access-key'], 'example-id');
  assert.equal(init.headers['x-ncp-apigw-signature-v2'], 'G7AvgsgDss+qWj36UyQPosfqJU/IiJlp81zgIhRcX28=');
  assert.deepEqual(JSON.parse(init.body), {
    type: 'SMS', contentType: 'COMM', countryCode: '82', from: '00000000001',
    content: '안녕하세요.', messages: [{ to: '00000000002' }],
  });
});

test('SMS uses the 80-byte EUC-KR boundary and rejects unencodable characters', () => {
  assert.equal(eucKrBytes('가'.repeat(40)), 80);
  assert.equal(eucKrBytes('가'.repeat(40) + '.'), 81);
  assert.equal(eucKrBytes('안녕.\nHi'), 8);
  assert.equal(eucKrBytes('힣'), Infinity);
  assert.equal(eucKrBytes('🙂'), Infinity);
});
