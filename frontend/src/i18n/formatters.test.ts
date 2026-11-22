import { describe, expect, it } from 'vitest';
import { createTranslator } from './translator';
import { commonBundle } from './messages/common';
import { locales } from '../contracts';
import { readLocalesTables } from './locales-doc.test-util';
import type { Locale } from './types';

const tables = readLocalesTables();
const col: Record<Locale, number> = { ko: 1, en: 2, 'zh-Hans': 3, 'zh-Hant': 4 };
const f = (l: Locale) => createTranslator(l).format;

describe('서식: LOCALES 3절 정답표(문서를 직접 읽어 대조)', () => {
  // 01_product/LOCALES.md 3절 예시는 안숭잘부 카페 시드 기준(DOC-R2 478941c, D-312·D-313): 오늘 매출 831,220원 · 지출 110,000원 · 남은 돈 721,220원 · 증감 ▼5.8% · 2026-11-17(화).
  const rows = new Map(tables['3'].map((r) => [r[0], r]));
  const cases: [string, (x: ReturnType<typeof f>) => string][] = [
    ['오늘 매출', (x) => x.money(831220, 'compact')],
    ['지출', (x) => x.money(110000, 'compact')],
    ['남은 돈', (x) => x.money(721220, 'compact')],
    ['작은 금액', (x) => x.money(5000, 'compact')],
    ['천 단위 구분', (x) => x.number(831220)],
    ['증감', (x) => x.delta(-5.8, 'percent')],
    ['퍼센트포인트', (x) => x.delta(1.6, 'pp')],
    ['손님 수', (x) => x.count(92, 'person')],
    ['주문 건수', (x) => x.count(3, 'order')],
    ['개수', (x) => x.count(120, 'pcs')],
    ['용량·무게', (x) => `${x.quantity(12, 'L')} · ${x.quantity(2, 'kg')}`],
    ['날짜(요일 포함)', (x) => x.date('2026-11-17', 'long')],
    ['짧은 날짜', (x) => x.date('2026-11-17', 'short')],
    ['시간 범위', (x) => x.hourRange(14, 17)],
  ];
  for (const [label, run] of cases) {
    for (const l of locales) {
      it(`${label} / ${l}`, () => {
        const row = rows.get(label);
        expect(row, label).toBeDefined();
        expect(run(f(l))).toBe(row![col[l]]);
      });
    }
  }
});

describe('서식: 글자 그대로', () => {
  it('레시피의 g·mL를 모든 언어에서 같은 숫자와 단위로 표시한다', () => {
    for (const locale of locales) {
      expect(f(locale).quantity(24, 'g')).toBe('24 g');
      expect(f(locale).quantity(300, 'mL')).toBe('300 mL');
      expect(f(locale).quantity(6632, 'g')).toBe('6,632 g');
      expect(f(locale).count(1250.5, 'mL')).toBe('1,250.5 mL');
      expect(f(locale).delta(-20, 'count', 'mL')).toBe('▼20 mL');
    }
  });
  it('새 단위 문구는 한국어만 두고 다른 언어에서 fallback한다', () => {
    for (const locale of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      expect(commonBundle[locale]).not.toHaveProperty('unit.g');
      expect(commonBundle[locale]).not.toHaveProperty('unit.mL');
      expect(f(locale).quantity(0, 'g')).toBe('0 g');
      expect(f(locale).quantity(0, 'mL')).toBe('0 mL');
    }
  });
  it('금액', () => {
    expect(f('ko').money(1284000, 'compact')).toBe('128.4만 원');
    expect(f('en').money(1284000, 'compact')).toBe('₩1,284,000');
    expect(f('zh-Hans').money(1284000, 'compact')).toBe('128.4万韩元');
    expect(f('zh-Hant').money(1284000, 'compact')).toBe('128.4萬韓元');
    expect(f('ko').money(5000, 'compact')).toBe('5,000원');
    expect(f('ko').money(1284000, 'full')).toBe('1,284,000원');
    expect(f('ko').money(100000, 'compact')).toBe('10.0만 원');
    expect(f('ko').money(29375000, 'compact')).toBe('2,937.5만 원');
    expect(f('ko').money(-462000, 'compact')).toBe('−46.2만 원');
    expect(f('en').money(0, 'full')).toBe('₩0');
    expect(f('ko').money(10000, 'compact')).toBe('1.0만 원');
    expect(f('ko').money(9999, 'compact')).toBe('9,999원');
    expect(f('ko').money(1270500, 'compact')).toBe('127.1만 원');
    expect(f('ko').money(1270499, 'compact')).toBe('127.0만 원');
    expect(f('ko').money(-10000, 'compact')).toBe('−1.0만 원');
  });
  it('퍼센트, 퍼센트포인트, 증감', () => {
    expect(f('ko').percent(67.8)).toBe('67.8%');
    expect(f('ko').percentPoint(1.6)).toBe('1.6%p');
    expect(f('en').percentPoint(1.6)).toBe('1.6 pp');
    expect(f('zh-Hans').percentPoint(1.6)).toBe('1.6个百分点');
    expect(f('zh-Hant').percentPoint(1.6)).toBe('1.6個百分點');
    expect(f('ko').delta(-3.4, 'percent')).toBe('▼3.4%');
    expect(f('ko').delta(7, 'count', 'person')).toBe('▲7명');
    expect(f('ko').delta(0, 'percent')).toBe('0%');
  });
  it('수량·개수와 영어 복수', () => {
    expect(f('ko').count(92, 'person')).toBe('92명');
    expect(f('en').count(92, 'person')).toBe('92 customers');
    expect(f('zh-Hans').count(92, 'person')).toBe('92人');
    expect(f('en').count(3, 'order')).toBe('3 orders');
    expect(f('zh-Hans').count(3, 'order')).toBe('3笔订单');
    expect(f('zh-Hant').count(3, 'order')).toBe('3筆訂單');
    expect(f('en').count(120, 'pcs')).toBe('120 pcs');
    expect(f('zh-Hans').count(120, 'pcs')).toBe('120个');
    expect(f('zh-Hant').count(120, 'pcs')).toBe('120個');
    expect(f('ko').count(120, 'pcs')).toBe('120개');
    expect(f('en').count(1, 'item')).toBe('1 item');
    expect(f('en').count(2, 'item')).toBe('2 items');
    expect(f('ko').quantity(12, 'L')).toBe('12 L');
    expect(f('ko').count(1500, 'item')).toBe('1,500개');
    expect(f('ko').count(1284000, 'KRW')).toBe('1,284,000원');
  });
  it('날짜·요일·시각·범위', () => {
    expect(f('ko').date('2026-10-26', 'long')).toBe('10월 26일 월요일');
    expect(f('en').date('2026-10-26', 'long')).toBe('Monday, Oct 26');
    expect(f('zh-Hans').date('2026-10-26', 'long')).toBe('10月26日 星期一');
    expect(f('zh-Hant').date('2026-10-26', 'long')).toBe('10月26日 週一');
    expect(f('ko').date('2026-10-26', 'short')).toBe('10/26(월)');
    expect(f('zh-Hant').date('2026-10-26', 'short')).toBe('10/26(週一)');
    expect(f('ko').date('2026-10-26', 'monthDay')).toBe('10월 26일');
    expect(f('ko').date('2026-11-01', 'long')).toBe('11월 1일 일요일');
    expect(f('en').weekday('2026-10-31', 'short')).toBe('Sat');
    expect(f('zh-Hans').weekday('2026-10-27', 'long')).toBe('星期二');
    expect(f('ko').time('9:00')).toBe('09:00');
    expect(f('ko').time('17:30')).toBe('17:30');
    expect(f('ko').hourRange(14, 17)).toBe('14~17시');
    expect(f('en').hourRange(9, 12)).toBe('09:00–12:00');
    expect(f('zh-Hans').hourRange(14, 17)).toBe('14–17点');
    expect(f('zh-Hant').hourRange(14, 17)).toBe('14–17點');
    expect(f('ko').dateRange('2026-10-20', '2026-10-26')).toBe('10월 20일~26일');
    expect(f('en').dateRange('2026-10-20', '2026-10-26')).toBe('Oct 20 – Oct 26');
  });
  it('요일 계산은 기기 시간대와 상관없다', () => {
    const prev = process.env.TZ;
    for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      expect(f('ko').weekday('2026-10-26', 'long')).toBe('월요일');
    }
    process.env.TZ = prev;
  });
  it('잘못된 날짜·시각은 던진다', () => {
    expect(() => f('ko').date('10/26', 'long')).toThrow(RangeError);
    expect(() => f('ko').time('abc')).toThrow(RangeError);
  });
});

describe('서식: 날짜+시각 (DS 6.1 G-25, K-C)', () => {
  it('짧은 날짜+시각은 {M}/{D}({요일}) {HH:MM}, ISO 문자열이 나오지 않는다', () => {
    expect(f('ko').dateTime('2026-10-26 15:45')).toBe('10/26(월) 15:45');
    expect(f('ko').dateTime('2026-10-26T09:05')).toBe('10/26(월) 09:05');
    expect(f('ko').dateTime('2026-11-02 9:00')).toBe('11/2(월) 09:00');
    expect(f('zh-Hans').dateTime('2026-10-27 14:00')).toBe('10/27(周二) 14:00');
    expect(f('zh-Hant').dateTime('2026-10-27 14:00')).toBe('10/27(週二) 14:00');
    expect(f('en').dateTime('2026-10-31 18:30')).toBe('Sat, Oct 31 18:30');
    for (const locale of locales) expect(f(locale).dateTime('2026-10-26 15:45')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  it('오늘 날짜면 오늘 {HH:MM} (현재 시각은 읽지 않고 today를 받는다)', () => {
    expect(f('ko').dateTime('2026-10-26 15:45', { today: '2026-10-26' })).toBe('오늘 15:45');
    expect(f('en').dateTime('2026-10-26 15:45', { today: '2026-10-26' })).toBe('Today 15:45');
    expect(f('zh-Hans').dateTime('2026-10-26 15:45', { today: '2026-10-26' })).toBe('今天 15:45');
    expect(f('zh-Hant').dateTime('2026-10-26 15:45', { today: '2026-10-26T08:00' })).toBe('今天 15:45');
    expect(f('ko').dateTime('2026-10-27 15:45', { today: '2026-10-26' })).toBe('10/27(화) 15:45');
  });
  it('시각이 없으면 오늘 또는 짧은 날짜만, 잘못된 값은 던진다', () => {
    expect(f('ko').dateTime('2026-10-26')).toBe('10/26(월)');
    expect(f('ko').dateTime('2026-10-26', { today: '2026-10-26' })).toBe('오늘');
    expect(() => f('ko').dateTime('10/26 15:45')).toThrow(RangeError);
  });
  it('짧은 날짜(요일 포함)와 전체 날짜는 기존 date()와 같은 규칙', () => {
    expect(f('ko').date('2026-11-02', 'short')).toBe('11/2(월)');
    expect(f('ko').date('2026-11-02', 'long')).toBe('11월 2일 월요일');
  });
});
