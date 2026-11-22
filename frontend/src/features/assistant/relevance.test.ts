// D-413: a read answer that shares no content word with the question is a sign that a loose router claimed the sentence. That is checked against the
// answer's own words, for any question, and the model's read-only plan then gets its turn; no phrase is listed here.
import { describe, expect, it } from 'vitest';
import { contentWords, mentionsQuestion } from './relevance';

describe('the content words of a question', () => {
  it('drops particles, endings and the asking words, keeping the subjects', () => {
    expect(contentWords('이번주에 시켜야 하는 재료 있나')).toEqual(expect.arrayContaining(['재료']));
    expect(contentWords('아이스 아메리카노 값 알려줘')).toEqual(expect.arrayContaining(['아이스', '아메리카노']));
    expect(contentWords('아이스 아메리카노 값 알려줘')).not.toContain('알려줘');
    expect(contentWords('그 중에 확인 필요한 건?')).toEqual(expect.arrayContaining(['확인', '필요한']));
    expect(contentWords('몇 시야?')).toEqual([]);
  });
});

describe('does the answer talk about what was asked', () => {
  it('is true when any line shares a content word, with 떼/테 spelled alike', () => {
    expect(mentionsQuestion('라떼 얼마 받더라', ['카페라테 가격 3,800원'])).toBe(true);
    expect(mentionsQuestion('단골이 총 몇 명이지', ['단골 250명'])).toBe(true);
    expect(mentionsQuestion('오늘 뭐부터 챙겨야돼', ['중요 알림 2건', '오늘 예약 6건 · 10명'])).toBe(true);
  });
  it('is true for a question that asks for a name, a time or an amount: its answer is that value, not an echo of the question', () => {
    expect(mentionsQuestion('마진 제일 좋은 메뉴 뭐야?', ['캐모마일 티 87.9%'])).toBe(true);
    expect(mentionsQuestion('원두 어느 업체에서 받지', ['상도브루 로스터리'])).toBe(true);
    expect(mentionsQuestion('손님 제일 많이 오는 시간이 언제야', ['12:00 · 2명'])).toBe(true);
  });
  it('is false when no line shares one, and says nothing against a question with no content word', () => {
    expect(mentionsQuestion('이번주에 시켜야 하는 재료 있나', ['사진 36장'])).toBe(false);
    expect(mentionsQuestion('곧 상하는 재료 있어?', ['우리 매장 시간대별 판매 POS · 11월 11일~17일'])).toBe(false);
    expect(mentionsQuestion('몇 시야?', ['사진 36장'])).toBe(true);
    expect(mentionsQuestion('아무 말', [])).toBe(true);
  });
});
