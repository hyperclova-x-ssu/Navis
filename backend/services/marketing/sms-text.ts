import { eucKrBytes } from '../../../frontend/server/sens-sms.mjs';

/**
 * Shared SENS text limits and the advertising frame for owner-authored customer SMS (coupons and notices).
 * Sources: [SENS send](https://api.ncloud-docs.com/docs/sens-sms-send) documents SMS 0–90 bytes, LMS 0–2,000
 * bytes and subject 0–40 bytes (EUC-KR). 정보통신망법 §50④ requires an advertising message to carry `(광고)`,
 * the sender's name and contact, and a free opt-out ([law](https://www.law.go.kr/lsLinkProc.do?chrClsCd=010202&joNo=005000000&lsId=000030),
 * [KISA guidance](https://spam.kisa.or.kr/spam/na/ntt/selectNttInfo.do?bbsId=1002&mi=1020&nttSn=3001)).
 * Services and workers import these from here so that no service depends on a worker module (RV-GAP-B-1).
 */
export const SENS_SMS_MAX_BYTES = 90;
export const SENS_LMS_MAX_BYTES = 2_000;
export const SENS_SUBJECT_MAX_BYTES = 40;

/**
 * R1 FAKE sender and opt-out lines, identical for coupons (B14) and notices (B15). A6 must replace both with the
 * verified sender name/contact and a working free opt-out number before any live advertising send.
 */
export const advertisingLines = {
  sender: '스토어사스 테스트 매장 (연락처: 테스트 전용)',
  optOut: '무료수신거부 테스트 전용',
} as const;

/** The exact final advertising text: `(광고)` + sender line, the owner's body, then the free opt-out line. */
export function advertisingSmsText(body: string) {
  return '(광고) ' + advertisingLines.sender + '\n' + body.trim().replace(/^\(광고\)\s*/, '') + '\n' + advertisingLines.optOut;
}

/** SMS when the whole final text fits 90 bytes, LMS up to 2,000 bytes, otherwise unsupported. */
export function smsMessageType(content: string): { type: 'SMS' | 'LMS'; bytes: number } | null {
  const bytes = eucKrBytes(content);
  if (bytes <= SENS_SMS_MAX_BYTES) return { type: 'SMS', bytes };
  if (bytes <= SENS_LMS_MAX_BYTES) return { type: 'LMS', bytes };
  return null;
}
