import { createHmac } from 'node:crypto';

const SENS_ORIGIN = 'https://sens.apigw.ntruss.com';
export const SMS_MAX_BYTES = 80;
export const validSmsNumber = value => typeof value === 'string' && /^[0-9]{8,11}$/.test(value);
const failure = code => Object.assign(new Error(code), { code });

let doubleByteCharacters;
function eucKrRepertoire() {
  if (doubleByteCharacters) return doubleByteCharacters;
  const decoder = new TextDecoder('euc-kr', { fatal: true });
  const repertoire = new Set();
  // KS X 1001 uses the A1–FE grid. Skip undefined cells, Windows-949
  // extension bytes and the user-defined rows.
  for (let lead = 0xa1; lead <= 0xfe; lead++) {
    if (lead === 0xc9 || lead === 0xfe) continue;
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      try { repertoire.add(decoder.decode(Uint8Array.of(lead, trail))); }
      catch { /* Unassigned cell. */ }
    }
  }
  doubleByteCharacters = repertoire;
  return repertoire;
}

export function eucKrBytes(text) {
  let bytes = 0;
  for (const character of text) {
    if (character.codePointAt(0) <= 0x7f) bytes++;
    else if (eucKrRepertoire().has(character)) bytes += 2;
    else return Infinity;
  }
  return bytes;
}

export function createSensSms({ serviceId, accessKey, secretKey, senderNumber, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const available = typeof serviceId === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(serviceId)
    && typeof accessKey === 'string' && /^[\x21-\x7e]+$/.test(accessKey)
    && typeof secretKey === 'string' && secretKey.trim().length > 0
    && validSmsNumber(senderNumber);

  async function send({ number, body, signal }) {
    if (!available || !validSmsNumber(number)) throw failure('SEND_DISABLED');
    if (typeof body !== 'string' || !body.trim() || eucKrBytes(body) > SMS_MAX_BYTES) throw failure('INVALID_REPLY');

    const path = `/sms/v2/services/${serviceId}/messages`;
    const timestamp = String(now());
    const signature = createHmac('sha256', secretKey)
      .update(`POST ${path}\n${timestamp}\n${accessKey}`)
      .digest('base64');
    let response;
    try {
      response = await fetchImpl(SENS_ORIGIN + path, {
        method: 'POST', redirect: 'error', signal,
        headers: {
          'content-type': 'application/json',
          'x-ncp-apigw-timestamp': timestamp,
          'x-ncp-iam-access-key': accessKey,
          'x-ncp-apigw-signature-v2': signature,
        },
        body: JSON.stringify({
          type: 'SMS', contentType: 'COMM', countryCode: '82',
          from: senderNumber, content: body, messages: [{ to: number }],
        }),
      });
    } catch {
      throw failure('SEND_UNKNOWN');
    }
    // The provider response body is never forwarded or logged.
    void response.body?.cancel().catch(() => {});
    if (response.status === 202) return;
    if (response.status >= 400 && response.status < 500 && response.status !== 408) throw failure('SEND_FAILED');
    throw failure('SEND_UNKNOWN');
  }

  return { available, send };
}
