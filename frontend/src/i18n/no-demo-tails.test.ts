import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commonBundle } from './messages';

/**
 * D-323 ⑦ and LOCALES §20 (last line): screens, toasts, receipts and sms previews carry no “(예시)” / “(sample)” tail.
 * The CCTV example mode stays (D-354), so only its own strings may still say “예시”.
 * Widget message files are checked by their own widget tests; this guards the shared sources.
 */
const TAIL = /\(예시\)|\(sample\)|（示例）|\(示例\)|（範例）|\(範例\)|（示範）|\(示範\)/;
const SHARED_SOURCES = [
  'src/i18n/messages/common.ts',
  'src/data/messages/written.ts',
  'src/data/messages/sourced.ts',
  'src/data/messages/pos.ts',
  'src/data/messages/management.ts',
  'src/data/iteration7/notices/messages.ts',
  'src/data/commands/notice-guard.ts',
  'src/ui/messages.ts',
  'src/screens/order/messages.ts',
];

describe('공통 문구에는 시연용 꼬리표가 없다', () => {
  for (const file of SHARED_SOURCES) {
    it(`${file}의 값에 (예시)·(sample) 꼬리표가 없다`, () => {
      const offenders = readFileSync(file, 'utf8').split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        // Comments that only describe what was replaced are history, not screen text.
        .filter(({ line }) => !/^\s*(?:\/\/|\/\*|\*)/.test(line) && TAIL.test(line))
        .map(({ line, number }) => `${number}: ${line.trim().slice(0, 100)}`);
      expect(offenders).toEqual([]);
    });
  }

  it('저장·내보내기·보내기·연결 완료 문구는 네 언어 모두 꼬리표 없이 읽힌다', () => {
    for (const locale of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const bundle = commonBundle[locale] as Record<string, string>;
      for (const key of ['common.exportedSample', 'common.sentSample', 'common.connectedSample', 'common.connectSample', 'common.sample', 'marketing.savedSample']) {
        expect(bundle[key], `${locale} ${key}`).toBeTruthy();
        expect(bundle[key], `${locale} ${key}`).not.toMatch(TAIL);
      }
      expect(bundle['common.sample']).toBe('{text}');
    }
    expect(commonBundle.ko['common.sentSample']).toBe('보냈어요');
  });
});
