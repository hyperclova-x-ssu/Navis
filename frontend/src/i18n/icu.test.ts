import { describe, expect, it } from 'vitest';
import { formatMessage, hasBatchim } from './icu';

describe('ICU 부분 구현', () => {
  it('{name} 치환, 없는 값은 빈 문자열', () => {
    expect(formatMessage('안녕 {name}', 'ko', { name: '민수' })).toBe('안녕 민수');
    expect(formatMessage('안녕 {name}', 'ko')).toBe('안녕 ');
  });
  it('plural: =0, one, other, # 는 숫자 서식', () => {
    const m = '{n, plural, =0 {No items} one {# item} other {# items}}';
    expect(formatMessage(m, 'en', { n: 0 })).toBe('No items');
    expect(formatMessage(m, 'en', { n: 1 })).toBe('1 item');
    expect(formatMessage(m, 'en', { n: 2 })).toBe('2 items');
    expect(formatMessage(m, 'en', { n: 1284000 })).toBe('1,284,000 items');
    expect(formatMessage('{n, plural, other {#명}}', 'ko', { n: 92 })).toBe('92명');
  });
  it('select와 other 대체', () => {
    const m = '{x, select, a {에이} b {비} other {기타}}';
    expect(formatMessage(m, 'ko', { x: 'a' })).toBe('에이');
    expect(formatMessage(m, 'ko', { x: 'z' })).toBe('기타');
    expect(formatMessage(m, 'ko')).toBe('기타');
  });
  it('중첩 한 단계: select 안의 {변수}', () => {
    expect(formatMessage('{big, select, yes {{n}만 원} other {{full}원}}', 'ko', { big: 'yes', n: '128.4', full: '5,000' })).toBe('128.4만 원');
    expect(formatMessage('{big, select, yes {{n}만 원} other {{full}원}}', 'ko', { big: 'no', n: '0.5', full: '5,000' })).toBe('5,000원');
  });
  it('한국어 조사 4쌍', () => {
    const t = (pair: string, name: string) => formatMessage(`{name, particle, ${pair}}`, 'ko', { name });
    expect(t('을/를', '가계부')).toBe('가계부를');
    expect(t('을/를', '재고관리')).toBe('재고관리를');
    expect(t('은/는', '커뮤니티')).toBe('커뮤니티는');
    expect(t('은/는', '세금계산')).toBe('세금계산은');
    expect(t('이/가', '캘린더')).toBe('캘린더가');
    expect(t('이/가', '정부지원')).toBe('정부지원이');
    expect(t('과/와', '브리핑')).toBe('브리핑과');
    expect(t('과/와', '거래처')).toBe('거래처와');
    expect(t('을/를', '3')).toBe('3을');
    expect(t('을/를', '2')).toBe('2를');
    expect(t('은/는', '마진·원가분석')).toBe('마진·원가분석은');
    expect(t('은/는', 'CCTV')).toBe('CCTV는');
  });
  it('받침 판정은 닫는 괄호를 건너뛴다', () => {
    expect(hasBatchim('지원 (확정)')).toBe(true);
    expect(hasBatchim('가계부(예시)')).toBe(false);
    expect(hasBatchim('')).toBe(false);
  });
  it('짝 없는 중괄호는 던지지 않는다', () => {
    expect(() => formatMessage('a } b', 'ko')).not.toThrow();
    expect(() => formatMessage('a {n, plural, one {x', 'en', { n: 1 })).not.toThrow();
  });
});
