import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageBundle } from './types';
import { createTranslator } from './translator';
import { defineBundle } from './bundles';
import { commonBundle } from './messages';

const own: MessageBundle<string> = defineBundle({
  id: 'own',
  ko: { 'x.only': '한국어만', 'x.both': '둘 다', 'x.empty': '빈 영어' },
  en: { 'x.both': 'Both', 'x.empty': '' },
  'zh-Hans': {},
  'zh-Hant': {},
});

describe('createTranslator', () => {
  afterEach(() => vi.restoreAllMocks());
  it('선택 언어 → ko로 대체하고 키 이름은 절대 돌려주지 않는다', () => {
    const en = createTranslator('en', own);
    expect(en.t('x.both')).toBe('Both');
    expect(en.t('x.only')).toBe('한국어만');
    expect(en.t('x.empty')).toBe('빈 영어');
    expect(en.has('x.only')).toBe(true);
    expect(createTranslator('zh-Hans', own).t('x.both')).toBe('둘 다');
  });
  it('어디에도 없으면 빈 문자열과 개발 경고', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ko = createTranslator('ko', own);
    expect(ko.t('nope.key')).toBe('');
    expect(ko.has('nope.key')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    ko.t('nope.key');
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('여러 묶음을 앞에서부터 찾는다', () => {
    const other: MessageBundle<string> = defineBundle({ id: 'o2', ko: { 'x.both': '다른' }, en: {}, 'zh-Hans': {}, 'zh-Hant': {} });
    expect(createTranslator('ko', own, other).t('x.both')).toBe('둘 다');
    expect(createTranslator('ko', other, own).t('x.both')).toBe('다른');
  });
  it('서식은 공통 묶음이 없어도 동작한다', () => {
    expect(createTranslator('en', own).format.money(1284000, 'compact')).toBe('₩1,284,000');
  });
  it('모든 언어의 공통 문구는 키 이름이나 빈칸이 없다', () => {
    for (const l of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const t = createTranslator<string>(l, commonBundle);
      for (const k of Object.keys(commonBundle.ko)) {
        const v = t.t(k, { n: 2, name: 'A', layer: 'B', current: 1, total: 2, state: 'S', text: 'T', sign: '', full: '1', big: 'no' });
        expect(v, `${k} ${l}`).not.toBe('');
        expect(v, `${k} ${l}`).not.toContain('{');
      }
    }
  });
});
