import assert from 'node:assert/strict';
import test from 'node:test';
import { guardAnswer, guardComposed, numbersIn } from '../../shared/navis-answer-guard.mjs';

const lines = ['오늘 매출 48.1만 원', '비교 기간 대비 -33.6%', '근무 11/18(수) 윤서진 08:00~16:30', '근무 11/18(수) 박도현 10:00~15:00', '지출 12,252,500원'];

test('numbers are read in the formats the app shows them', () => {
  assert.deepEqual(numbersIn('481,220원 · 48.1만 원 · -33.6% · 08:00~16:30 · 11/18'), [481220, 48.1, 33.6, 8, 0, 16, 30, 11, 18]);
  assert.deepEqual(numbersIn('아메리카노2잔'), [2]);
  assert.deepEqual(numbersIn('숫자가 없는 문장이에요'), []);
});

test('a sentence made only of numbers the facts hold is kept as written', () => {
  assert.equal(guardAnswer({ text: '오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.', lines, used: [0, 1] }), '오늘 매출은 48.1만 원이에요. 비교 기간보다 33.6% 낮아요.');
  assert.equal(guardAnswer({ text: '내일 오전에는 윤서진 님이 8시부터 16시 30분까지 일해요.', lines, used: [2], question: '내일 근무 누구야?' }), '내일 오전에는 윤서진 님이 8시부터 16시 30분까지 일해요.');
  // The turn before a follow-up may have named the day ("내일"); its period words are known, its numbers are not.
  assert.equal(guardAnswer({ text: '내일 오전에는 윤서진 님이 8시부터 일해요.', lines, used: [2], question: '그 중에 오전은?', context: '내일 근무 누구야?' }), '내일 오전에는 윤서진 님이 8시부터 일해요.');
  assert.equal(guardAnswer({ text: '내일 매출은 99원이에요.', lines, used: [0], question: '그 중에 오전은?', context: '내일 매출 99원' }), null);
});

test('one sentence that breaks a rule spoils the whole answer: no fragment and no cut-short list is ever shown, the fact lines stay', () => {
  assert.equal(guardAnswer({ text: '오늘 매출은 48.1만 원이에요. 어제보다 12만 원 적어요.', lines, used: [0] }), null);
  assert.equal(guardAnswer({ text: '오늘 매출은 50만 원이에요. 비교 기간보다 33.6% 낮아요.', lines, used: [0, 1] }), null);
  assert.equal(guardAnswer({ text: '비교 기간보다 33.6% 낮아요. 오늘 매출은 48.1만 원이에요. 어제보다 12만 원 적어요.', lines, used: [0, 1] }), null);
  // A lead-in that promises a list the answer then does not hold is such a sentence.
  for (const text of ['최근 결제는 총 9건이고, 내용은 다음과 같아요.', '내일 근무표는 아래와 같습니다.']) assert.equal(guardAnswer({ text, lines: ['최근 결제 9건'], used: [0] }), null, text);
  for (const lead of ['다만, 비교 기간보다 33.6% 낮아요.', '그리고 비교 기간보다 33.6% 낮아요.', '이 중 비교 기간보다 33.6% 낮은 날이에요.', '따라서 33.6%예요.']) assert.equal(guardAnswer({ text: lead, lines, used: [1] }), null, lead);
  assert.equal(guardAnswer({ text: '오늘 매출은 50만 원이에요.', lines, used: [0] }), null);
  // A number from a line the answer did not claim to use is not allowed either.
  assert.equal(guardAnswer({ text: '지출은 12,252,500원이에요.', lines, used: [0] }), null);
  assert.equal(guardAnswer({ text: '지출은 12,252,500원이에요.', lines, used: [4] }), '지출은 12,252,500원이에요.');
});

test('numbers the owner wrote in the question are allowed, other counts and spelled-out numbers are not', () => {
  assert.equal(guardAnswer({ text: '가장 많이 판 3개를 알려 드릴게요.', lines, used: [0], question: '제일 많이 판 3개 알려줘' }), '가장 많이 판 3개를 알려 드릴게요.');
  assert.equal(guardAnswer({ text: '가장 많이 판 4개를 알려 드릴게요.', lines, used: [0], question: '제일 많이 판 3개 알려줘' }), null);
  assert.equal(guardAnswer({ text: '오늘 근무는 두 명이에요.', lines, used: [2, 3] }), null);
  assert.equal(guardAnswer({ text: '입고까지 이틀이 걸려요.', lines: ['입고까지 2일'], used: [0] }), null);
  assert.equal(guardAnswer({ text: '입고까지 2일이 걸려요.', lines: ['입고까지 2일'], used: [0] }), '입고까지 2일이 걸려요.');
  assert.equal(guardAnswer({ text: '매출은 삼만 원이에요.', lines, used: [0] }), null);
  assert.equal(guardAnswer({ text: '두 종류 모두 1kg이에요.', lines: ['최소 주문 1 kg'], used: [0] }), null);
  assert.equal(guardAnswer({ text: '오늘 근무하는 두 분은 윤서진 님과 박도현 님이에요.', lines, used: [2, 3] }), null);
});

test('markup, links, code and empty answers are refused, and a missing or out-of-range used list falls back sensibly', () => {
  for (const text of ['', '   ', '{"text":"x"}', '링크 https://example.com 참고', '`코드`', '<b>굵게</b>']) assert.equal(guardAnswer({ text, lines, used: [0] }), null, text);
  assert.equal(guardAnswer({ text: '오늘 매출은 48.1만 원이에요.', lines, used: [99] }), null);
  assert.equal(guardAnswer({ text: '오늘 매출은 48.1만 원이에요.', lines }), '오늘 매출은 48.1만 원이에요.');
  assert.equal(guardAnswer({ text: '오늘 매출은 48.1만 원이에요.', lines: [] }), null);
});

test('a period word the facts and the question do not use is a claim about another period: its sentence is dropped', () => {
  const periodLines = ['오늘 매출 84.6만 원', '비교 기간(11월 10일) 매출 1,110,820원', '비교 기간 대비 -23.8%'];
  assert.equal(guardAnswer({ text: '오늘 매출은 84.6만 원이에요. 어제보다 23.8% 낮아요.', lines: periodLines, used: [0, 1, 2] }), null);
  assert.equal(guardAnswer({ text: '오늘 매출은 84.6만 원이에요. 어제보다 23.8% 낮아요.', lines: periodLines, used: [0, 1, 2], question: '어제보다 많아?' }),
    '오늘 매출은 84.6만 원이에요. 어제보다 23.8% 낮아요.');
  assert.equal(guardAnswer({ text: '비교 기간(11월 10일) 매출은 1,110,820원이에요.', lines: periodLines, used: [1] }), '비교 기간(11월 10일) 매출은 1,110,820원이에요.');
  assert.equal(guardAnswer({ text: '지난 주 매출은 1,110,820원이에요.', lines: periodLines, used: [1] }), null);
  assert.equal(guardAnswer({ text: '지난주 매출은 1,110,820원이에요.', lines: ['지난주 매출 1,110,820원'], used: [0] }), '지난주 매출은 1,110,820원이에요.');
});

test('an answer that only says the data could not be read is no answer', () => {
  for (const text of ['그 자료는 읽지 못했어요.', '자료에 없어서 알 수 없어요.', '확인할 수 없어요.', '예약 취소 건수는 확인되지 않아요.']) assert.equal(guardAnswer({ text, lines, used: [0] }), null, text);
});

test('a comparison ("더 많이", "어제보다 적어요", "늘었어요") with no number to check it against is not an answer', () => {
  const sales = ['11월 16일 1,077,440원', '11월 17일 843,220원'];
  for (const text of ['네, 어제보다 적어요.', '소금빵이 베이글보다 많이 팔려요.', '지난달보다 늘었어요.', '매출이 줄었어요.']) assert.equal(guardAnswer({ text, lines: sales, used: [0, 1], question: '어제보다 많아? 지난달보다 늘었어?' }), null, text);
  assert.equal(guardAnswer({ text: '11월 16일은 1,077,440원, 11월 17일은 843,220원으로 어제보다 적어요.', lines: sales, used: [0, 1], question: '어제보다 많아?' }),
    '11월 16일은 1,077,440원, 11월 17일은 843,220원으로 어제보다 적어요.');
});

test('a long answer is more room to wander: past 260 characters nothing is used', () => {
  const long = Array.from({ length: 20 }, () => '진행 중인 주문은 2건이에요.').join(' ');
  assert.ok(long.length > 260);
  assert.equal(guardAnswer({ text: long, lines: ['진행 중 2건'], used: [0] }), null);
});

test('a range word ("이번 주", "이번 달", "지난주") is a label the fact lines must carry: the owner\'s own wording does not make a last-7-days figure this week\'s', () => {
  const recent = ['최근 7일 매출 6,733,290원', '마진율 70%'];
  assert.equal(guardAnswer({ text: '이번 주 매출은 6,733,290원이고, 마진율은 70%예요.', lines: recent, used: [0, 1], question: '이번 주 매출이랑 마진 알려줘' }), null);
  assert.equal(guardAnswer({ text: '최근 7일 매출은 6,733,290원이고, 마진율은 70%예요.', lines: recent, used: [0, 1], question: '이번 주 매출이랑 마진 알려줘' }),
    '최근 7일 매출은 6,733,290원이고, 마진율은 70%예요.');
  assert.equal(guardAnswer({ text: '이번 달 세금은 183,000원이에요.', lines: ['11월 원천세 183,000원'], used: [0], question: '이번 달 세금 뭐 있어?' }), null);
  assert.equal(guardAnswer({ text: '지난주와 비교해 22.7% 낮아요.', lines: ['비교 기간 대비 -22.7%'], used: [0], question: '지난주 같은 요일이랑 비교하면?' }), null);
  assert.equal(guardAnswer({ text: '이번 달 매출은 16,807,300원이에요.', lines: ['이번 달 매출 16,807,300원'], used: [0] }), '이번 달 매출은 16,807,300원이에요.');
  // A single day named by the owner ("내일", "어제") is not a range: the question or the turn before it may name it.
  assert.equal(guardAnswer({ text: '내일은 윤서진 님이 일해요.', lines: ['근무 11/18(수) 윤서진 08:00~16:30'], used: [0], question: '내일 근무 누구야?' }), '내일은 윤서진 님이 일해요.');
});

test('more than three sentences is a report, not an answer: the fact lines stay', () => {
  const five = ['진행 중인 주문은 2건이에요.', '결제 전은 2건이에요.', '승인 대기는 0건이에요.', '내일 픽업은 1건이에요.', '오늘 픽업은 0건이에요.'].join(' ');
  assert.equal(guardAnswer({ text: five, lines: ['진행 중 2건', '결제 전 2건', '승인 대기 0건', '내일 픽업 1건', '오늘 픽업 0건'], used: [0, 1, 2, 3, 4] }), null);
  assert.equal(guardAnswer({ text: '진행 중인 주문은 2건이에요. 결제 전은 2건이에요. 승인 대기는 0건이에요.', lines: ['진행 중 2건', '결제 전 2건', '승인 대기 0건'], used: [0, 1, 2] }),
    '진행 중인 주문은 2건이에요. 결제 전은 2건이에요. 승인 대기는 0건이에요.');
});

test('a composed answer must carry the figure of every fact line that has one: leaving a tax, a person or a total out is not worded away', () => {
  const taxes = ['11월 원천세 12월 10일', '하반기 부가세 준비 971,170원 · 1월 25일 · 미납', '미납 합계 1,154,170원'];
  // Only the first tax: the VAT line (971,170 / 1월 25일) and the total are missing.
  assert.equal(guardComposed({ text: '11월 원천세는 12월 10일까지예요.', lines: taxes, question: '세금 신고 언제까지야?' }), null);
  assert.equal(guardComposed({ text: '이번 달에 내야 할 세금은 11월 원천세 12월 10일이고 하반기 부가세는 971,170원이에요.', lines: taxes }), null);
  assert.equal(guardComposed({ text: '11월 원천세는 12월 10일까지, 하반기 부가세 971,170원은 1월 25일까지예요. 미납 합계는 1,154,170원이에요.', lines: taxes }),
    '11월 원천세는 12월 10일까지, 하반기 부가세 971,170원은 1월 25일까지예요. 미납 합계는 1,154,170원이에요.');
  // A line with no figure ("후보가 없어요") does not have to be repeated; the figure lines still do.
  assert.equal(guardComposed({ text: '매출은 48.1만 원이에요.', lines: ['오늘 매출 48.1만 원', '확인할 후보가 없어요'] }), '매출은 48.1만 원이에요.');
  assert.equal(guardComposed({ text: '매출은 48.1만 원이에요.', lines: ['오늘 매출 48.1만 원', '비교 기간 대비 -33.6%'] }), null);
  // The rules of guardAnswer still apply first.
  assert.equal(guardComposed({ text: '매출은 50만 원이에요.', lines: ['오늘 매출 48.1만 원'] }), null);
});

// A number must belong to the thing it is said about: a figure of another line is not made right by being in the facts.
test('a sentence names the item of a fact line that holds its number: another item\'s figure is not attached to it', () => {
  const prices = ['카페라떼 가격 3,800원', '바닐라빈 라떼 가격 4,300원', '쿠키 세트 가격 11,000원', '아메리카노 가격 3,000원'];
  assert.equal(guardAnswer({ text: '카페라떼 가격은 11,000원이에요.', lines: prices, used: [0, 1, 2, 3] }), null);
  assert.equal(guardAnswer({ text: '카페라떼 가격은 3,800원이에요.', lines: prices, used: [0, 1, 2, 3] }), '카페라떼 가격은 3,800원이에요.');
  // The common spelling "라테" for "라떼" is the same item.
  assert.equal(guardAnswer({ text: '카페라테 가격은 3,800원이에요.', lines: prices, used: [0] }), '카페라테 가격은 3,800원이에요.');
  assert.equal(guardAnswer({ text: '카페라테 가격은 11,000원이에요.', lines: prices, used: [0, 2] }), null);
  // Words every line shares ("가격") name nothing; a line with no distinctive word of its own does not constrain the sentence.
  assert.equal(guardAnswer({ text: '가격은 3,800원이에요.', lines: ['가격 3,800원'], used: [0] }), '가격은 3,800원이에요.');
  assert.equal(guardAnswer({ text: '오늘 매출은 88.5만 원이에요. 비교 기간보다 -20.3%예요.', lines: ['오늘 매출 88.5만 원', '비교 기간 대비 -20.3%'], used: [0, 1] }),
    '오늘 매출은 88.5만 원이에요. 비교 기간보다 -20.3%예요.');
  // A sentence about the other line's subject is dropped.
  assert.equal(guardAnswer({ text: '비교 기간 매출은 88.5만 원이에요.', lines: ['오늘 매출 88.5만 원', '비교 기간(11월 10일) 매출 1,110,820원'], used: [0, 1] }), null);
});
