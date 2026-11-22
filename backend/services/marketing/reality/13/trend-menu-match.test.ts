import { describe, expect, it } from 'vitest';
import { matchTrendMenu } from './trend-menu-match.ts';

const catalog = [
  { name: '제주 말차 라떼', category: 'beverage' },
  { name: '디카페인 아메리카노', category: 'coffee' },
  { name: '겉바속촉 버터 소금빵', category: 'dessert' },
  { name: '카페라떼', category: 'coffee' },
] as const;

describe('search trend menu labels', () => {
  it.each([
    ['말차 라떼', '제주 말차 라떼'], ['말차라떼', '제주 말차 라떼'],
    ['디카페인 커피', '디카페인 아메리카노'], ['디카페인커피', '디카페인 아메리카노'],
    ['소금빵', '겉바속촉 버터 소금빵'], ['카페 라떼', '카페라떼'],
    ['디카페인 에이드', null], ['저당 디카페인 커피', null], ['소금빵 커피', null], ['   ', null],
  ])('matches %s against the authoritative menu', (keyword, expected) => {
    expect(matchTrendMenu(keyword, catalog)).toBe(expected);
  });

  it('prefers an exact name to a longer match or a category match', () => {
    expect(matchTrendMenu('말차 라떼', [...catalog, { name: '말차라떼', category: 'beverage' }])).toBe('말차라떼');
  });

  it('prefers the lower-priced item when two names match equally', () => {
    const menus = [{ name: '오트 말차 라떼', category: 'beverage', price: 5100 }, { ...catalog[0], price: 4600 }];
    expect(matchTrendMenu('말차 라떼', menus)).toBe('제주 말차 라떼');
    expect(matchTrendMenu('말차 라떼', menus.reverse())).toBe('제주 말차 라떼');
  });
});
