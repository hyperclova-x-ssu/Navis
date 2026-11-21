import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../i18n';
import { findDuplicateKeys, findKoGaps } from '../../i18n/bundles';
import { baseBundles } from '../../i18n/messages';
import { mockTableKey } from '../../data/cctv/view';
import { cctvBundle } from './messages';

const LANGS = ['en', 'zh-Hans', 'zh-Hant'] as const;
const hangul = /[가-힣]/u;

describe('cctv message bundle (T-070)', () => {
  it('has Korean for every key and no other-language key that Korean lacks', () => {
    expect(findKoGaps(cctvBundle)).toEqual([]);
  });
  it('translates every key into en, zh-Hans and zh-Hant with no blanks', () => {
    for (const l of LANGS) {
      const blanks = Object.keys(cctvBundle.ko).filter((k) => !(cctvBundle[l] as Record<string, string>)[k]?.trim());
      expect(blanks, l).toEqual([]);
    }
  });
  it('mixes no Hangul into en / zh values', () => {
    for (const l of LANGS) {
      const hits = Object.entries(cctvBundle[l] as Record<string, string>).filter(([, v]) => hangul.test(v));
      expect(hits, l).toEqual([]);
    }
  });
  it('keeps placeholders the same in every language', () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort().join(',');
    for (const [k, ko] of Object.entries(cctvBundle.ko)) for (const l of LANGS) expect(ph((cctvBundle[l] as Record<string, string>)[k]), `${l} ${k}`).toBe(ph(ko));
  });
  it('does not collide with another bundle and keeps the DS 13.3 wording', () => {
    expect(findDuplicateKeys(...baseBundles, cctvBundle)).toEqual([]);
    expect(cctvBundle.ko['cctv.table.state.occupied']).toBe('사용 중');
    expect(cctvBundle.ko['cctv.table.state.empty']).toBe('빈 자리');
    expect(cctvBundle.ko['cctv.mode.live']).toBe('실시간');
    expect(cctvBundle.en['cctv.mode.mock']).toBe('Demo');
  });
  it('has a name for every mock table, and ICU strings render in all languages', () => {
    for (const id of ['t1', 't2', 't3', 't4']) expect(cctvBundle.ko[mockTableKey(id) as keyof typeof cctvBundle.ko]).toBeTruthy();
    for (const l of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const t = createTranslator(l, cctvBundle);
      expect(t.t('cctv.change.down', { n: 2 })).toContain('2');
      expect(t.t('cctv.tables.inUse', { a: 3, b: 4 })).toContain('3');
      expect(t.t('cctv.guests', { n: 1 })).toContain('1');
    }
    expect(createTranslator('ko', cctvBundle).t('cctv.change.down', { n: 2 })).toBe('5분 전보다 ▼ 2명');
  });
});
