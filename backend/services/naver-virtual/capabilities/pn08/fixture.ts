import type { CustomConditionV2Request, CustomConditionV2Response } from '../../../../packages/naver/contracts/pn08/wire.ts';

type FixtureCallback = (target: 'aicall', init: RequestInit) => Promise<Response>;
const seoulDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });

// https://guide.ncloud-docs.com/docs/clovaaicall-aicall-1-9
// https://guide.ncloud-docs.com/docs/chatbot-chatbot-2-3
// The scenario sends a candidate to customer. It never writes provider bookings or sends audio.
export async function deliverAiCallFixture(callback: FixtureCallback, now: Date, callbackToken: string): Promise<CustomConditionV2Response> {
  const day = new Date(seoulDate.format(now) + 'T00:00:00+09:00');
  day.setTime(day.getTime() + 86_400_000);
  const date = seoulDate.format(day);
  const [year, month, dateOfMonth] = date.split('-').map(Number);
  const payload: CustomConditionV2Request = {
    userId: 'persona-aicall-' + date,
    userKey: 'persona-aicall-cafe',
    userVariables: {
      예약날짜_completed: { value: JSON.stringify({ year, month, day: dateOfMonth, name: '내일' }), typ: 'JSON' },
      예약시간_completed: { value: JSON.stringify({ hour: 13, minute: 30 }), typ: 'JSON' },
      예약인원_completed: { value: '2', typ: 'NUMBER' },
      전화번호_completed: { value: '01000004200', typ: 'TEXT' },
    },
  };
  const response = await callback('aicall', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + callbackToken },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error('AiCall callback failed');
  const body: unknown = await response.json();
  // The fixture uses the failure branch when customer has no authoritative booking completion.
  if (body === null || typeof body !== 'object' || !('valid' in body) || body.valid !== 'reservationFailed'
    || Object.keys(body).length !== 1) throw new Error('Unexpected AiCall fixture acknowledgement');
  return { valid: body.valid };
}
