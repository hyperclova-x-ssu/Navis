import { describe, expect, it } from 'vitest';
import { objectParticle } from './destinations';

describe('the object particle of a widget name', () => {
  it.each([['메뉴', '를'], ['세무관리', '를'], ['재고', '를'], ['손익', '을'], ['마진', '을'], ['캘린더', '를'], ['회원목록', '을'], ['Navis', '를']] as const)('%s takes %s', (word, particle) => {
    expect(objectParticle(word)).toBe(particle);
  });
});
