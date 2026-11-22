import { describe, expect, it } from 'vitest';
import {
  isNavisStandaloneRead, resolveNavisContinuation,
  type NavisChoice, type NavisContinuation, type NavisContinuationContext, type NavisContinuationSlot,
} from './continuation';

const scope = { runId: 'run-1', revision: 7, target: 'menu-latte', stepId: 'plan-1#2' } as const;
const context: NavisContinuationContext = { scope, businessDate: '2026-10-26', businessNow: '2026-10-26T15:45:00+09:00' };
const open = (slot: NavisContinuationSlot, extra: Partial<NavisContinuation> = {}): NavisContinuation => ({
  id: 'clarify-1', field: 'value', slot, scope, mutation: true, ...extra,
});
const text = (value: string) => ({ text: value });

const syrups: readonly NavisChoice[] = [
  { id: 'i-vanilla-syrup', label: '바닐라 시럽' }, { id: 'i-caramel-syrup', label: '카라멜 시럽' },
];
const rounding: readonly NavisChoice[] = [
  { id: 'exact', label: '5,775원', value: 5775 }, { id: 'nearest100', label: '5,800원', value: 5800 },
];

describe('a continuation only resumes inside its own run, revision, target and plan step', () => {
  const slot = { kind: 'money', min: 1 } as const;
  it('accepts the exact binding', () => {
    expect(resolveNavisContinuation(open(slot), text('4,800원'), context)).toEqual({ kind: 'resume', field: 'value', value: 4800, via: 'typed', correction: false });
  });

  it.each([
    ['run', { runId: 'run-2' }], ['revision', { revision: 8 }], ['target', { target: 'menu-vanilla' }], ['step', { stepId: 'plan-1#3' }],
  ])('asks again when the %s changed, even for a valid chip or amount', (_, change) => {
    const moved = { ...context, scope: { ...scope, ...change } };
    expect(resolveNavisContinuation(open(slot), text('4,800원'), moved)).toEqual({ kind: 'reask', reason: 'stale', field: 'value' });
    expect(resolveNavisContinuation(open({ kind: 'choice', choices: syrups }), { chipId: 'i-caramel-syrup' }, moved))
      .toEqual({ kind: 'reask', reason: 'stale', field: 'value' });
  });

  it('treats a missing binding on one side as stale instead of widening the scope', () => {
    const unbound = { ...context, scope: { runId: scope.runId, revision: scope.revision } };
    expect(resolveNavisContinuation(open(slot), text('4,800원'), unbound)).toMatchObject({ kind: 'reask', reason: 'stale' });
  });
});

describe('money slot', () => {
  const slot = { kind: 'money', min: 1, max: 1_000_000 } as const;
  it.each([
    ['4,800원', 4800], ['4800', 4800], ['사천팔백 원', 4800], ['5천으로 바꿔줘', 5000], ['5천원', 5000], ['4800원으로 해줘', 4800], ['삼천오백 원이요', 3500], ['₩5,500', 5500],
  ])('reads %s as one amount', (reply, value) => {
    expect(resolveNavisContinuation(open(slot), text(reply), context)).toMatchObject({ kind: 'resume', value, via: 'typed' });
  });

  it.each([['아니 4,500원으로', 4500], ['아메리카노 말고 4,500원', 4500], ['아냐 4500', 4500]])('marks a typed correction in %s', (reply, value) => {
    expect(resolveNavisContinuation(open(slot), text(reply), context)).toMatchObject({ kind: 'resume', value, correction: true });
  });

  it('asks again for a value outside the range, a free price, two amounts or no amount', () => {
    expect(resolveNavisContinuation(open(slot), text('0원'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
    expect(resolveNavisContinuation(open(slot), text('2,000,000원'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
    expect(resolveNavisContinuation(open(slot), text('4,800원이나 5,000원'), context)).toEqual({ kind: 'reask', reason: 'ambiguous', field: 'value' });
    expect(resolveNavisContinuation(open(slot), text('대략 5천원'), context)).toEqual({ kind: 'reask', reason: 'ambiguous', field: 'value' });
    expect(resolveNavisContinuation(open(slot), text('글쎄 얼마가 좋을까'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
  });
});

describe('choice slot', () => {
  const slot = { kind: 'choice', choices: syrups } as const;
  it('takes a chip, an ordinal or the typed name', () => {
    expect(resolveNavisContinuation(open(slot), { chipId: 'i-caramel-syrup' }, context)).toEqual({ kind: 'resume', field: 'value', value: 'i-caramel-syrup', via: 'chip', correction: false });
    expect(resolveNavisContinuation(open(slot), text('두 번째'), context)).toEqual({ kind: 'resume', field: 'value', value: 'i-caramel-syrup', via: 'ordinal', correction: false });
    expect(resolveNavisContinuation(open(slot), text('마지막'), context)).toMatchObject({ value: 'i-caramel-syrup', via: 'ordinal' });
    expect(resolveNavisContinuation(open(slot), text('바닐라 시럽'), context)).toMatchObject({ value: 'i-vanilla-syrup', via: 'typed' });
    expect(resolveNavisContinuation(open(slot), text('카라멜'), context)).toMatchObject({ value: 'i-caramel-syrup', via: 'typed' });
    expect(resolveNavisContinuation(open(slot), text('바닐라 말고 카라멜 시럽'), context)).toMatchObject({ value: 'i-caramel-syrup', correction: true });
  });

  it('returns the numeric value of a rounding chip', () => {
    expect(resolveNavisContinuation(open({ kind: 'choice', choices: rounding }), { chipId: 'nearest100' }, context))
      .toEqual({ kind: 'resume', field: 'value', value: 5800, via: 'chip', correction: false });
    expect(resolveNavisContinuation(open({ kind: 'choice', choices: rounding }), text('5,775원 그대로'), context)).toMatchObject({ value: 5775 });
  });

  it('asks again with the candidates when the name matches several choices or none', () => {
    expect(resolveNavisContinuation(open(slot), text('시럽'), context)).toEqual({ kind: 'reask', reason: 'ambiguous', field: 'value', candidates: syrups });
    expect(resolveNavisContinuation(open(slot), text('초코 소스'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
    expect(resolveNavisContinuation(open(slot), text('세 번째'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
    expect(resolveNavisContinuation(open(slot), { chipId: 'i-unknown' }, context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
  });

  it('resolves a local nickname only to a listed official choice', () => {
    const menus: readonly NavisChoice[] = [{ id: 'm-americano', label: '아메리카노' }, { id: 'm-latte', label: '카페라테' }];
    expect(resolveNavisContinuation(open({ kind: 'choice', choices: menus }), text('아아'), context)).toMatchObject({ value: 'm-americano', via: 'typed' });
    expect(resolveNavisContinuation(open({ kind: 'choice', choices: syrups }), text('아아'), context)).toMatchObject({ kind: 'reask', reason: 'invalid' });
  });
});

describe('confirmation, cancel and the card', () => {
  it('lets an alias confirmation resume on yes and close on no', () => {
    const confirm = open({ kind: 'confirm' }, { field: 'alias' });
    expect(resolveNavisContinuation(confirm, text('네'), context)).toEqual({ kind: 'resume', field: 'alias', value: true, via: 'typed', correction: false });
    expect(resolveNavisContinuation(confirm, { chipId: 'yes' }, context)).toMatchObject({ kind: 'resume', value: true, via: 'chip' });
    expect(resolveNavisContinuation(confirm, text('아니요'), context)).toEqual({ kind: 'cancel' });
    expect(resolveNavisContinuation(confirm, { chipId: 'no' }, context)).toEqual({ kind: 'cancel' });
  });

  it('presents the card, never a commit, when a complete mutation is affirmed', () => {
    const ready = open({ kind: 'money' }, { ready: true });
    for (const reply of ['응', '네', '확인', '진행해줘']) {
      const outcome = resolveNavisContinuation(ready, text(reply), context);
      expect(outcome, reply).toEqual({ kind: 'present-card', field: 'value' });
      expect(Object.keys(outcome)).not.toContain('commit');
    }
  });

  it('cannot affirm a value that is still missing', () => {
    expect(resolveNavisContinuation(open({ kind: 'money' }), text('응'), context)).toEqual({ kind: 'reask', reason: 'missing', field: 'value' });
  });

  it.each(['취소', '그만', '아니', '하지 마'])('closes the continuation on %s', reply => {
    expect(resolveNavisContinuation(open({ kind: 'money' }), text(reply), context)).toEqual({ kind: 'cancel' });
  });
});

describe('a standalone read leaves the continuation available', () => {
  it.each(['오늘 매출 알려줘', '카페라테 가격 얼마야?', '재고 현황 보여줘', '어제는?'])('does not consume %s', reply => {
    expect(isNavisStandaloneRead(reply)).toBe(true);
    expect(resolveNavisContinuation(open({ kind: 'money' }), text(reply), context)).toEqual({ kind: 'leave' });
  });
  it.each(['4,800원', '5천으로 바꿔줘', '두 번째', '네', '카라멜 시럽'])('does not mistake %s for a read', reply => expect(isNavisStandaloneRead(reply)).toBe(false));
  it('prefers an exact choice label over a read word inside it', () => {
    const choices = [{ id: 'sales', label: '매출 현황' }, { id: 'stock', label: '재고' }];
    expect(resolveNavisContinuation(open({ kind: 'choice', choices }), text('매출 현황'), context)).toMatchObject({ kind: 'resume', value: 'sales' });
  });
});

describe('quantity slot', () => {
  const slot = { kind: 'quantity', unit: 'L' } as const;
  it.each([['2리터', 2], ['두 리터', 2], ['500mL', 0.5], ['2', 2], ['1,500 mL', 1.5], ['2L로 수정', 2]])('reads %s in liters', (reply, value) => {
    expect(resolveNavisContinuation(open(slot), text(reply), context)).toMatchObject({ kind: 'resume', value });
  });
  it('rejects another measure, a negative amount, an approximate amount and an unknown pack size', () => {
    expect(resolveNavisContinuation(open(slot), text('3kg'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
    expect(resolveNavisContinuation(open(slot), text('-3리터'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
    expect(resolveNavisContinuation(open(slot), text('두세 리터'), context)).toEqual({ kind: 'reask', reason: 'ambiguous', field: 'value' });
    expect(resolveNavisContinuation(open({ kind: 'quantity', unit: 'pcs' }), text('두 박스'), context)).toEqual({ kind: 'reask', reason: 'packSize', field: 'value' });
    expect(resolveNavisContinuation(open({ kind: 'quantity', unit: 'pcs', max: 100 }), text('500개'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
  });
});

describe('date, time and period slots follow the business clock', () => {
  it('resolves a date against the Asia/Seoul business date', () => {
    expect(resolveNavisContinuation(open({ kind: 'date' }), text('모레'), context)).toMatchObject({ kind: 'resume', value: '2026-10-28' });
    expect(resolveNavisContinuation(open({ kind: 'date' }), text('다음 주 화요일'), context)).toMatchObject({ value: '2026-11-03' });
    expect(resolveNavisContinuation(open({ kind: 'date' }), text('오늘과 내일'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
  });

  it('asks again for a bare 9시 instead of guessing the meridiem', () => {
    expect(resolveNavisContinuation(open({ kind: 'time' }), text('오후 3시 반'), context)).toMatchObject({ kind: 'resume', value: '15:30' });
    expect(resolveNavisContinuation(open({ kind: 'time' }), text('21:00'), context)).toMatchObject({ value: '21:00' });
    expect(resolveNavisContinuation(open({ kind: 'time' }), text('9시'), context)).toEqual({
      kind: 'reask', reason: 'ambiguous', field: 'value',
      candidates: [{ id: '09:00', label: '오전 9시', value: '09:00' }, { id: '21:00', label: '오후 9시', value: '21:00' }],
    });
  });

  it('resolves a period to an inclusive range', () => {
    expect(resolveNavisContinuation(open({ kind: 'period' }), text('지난달'), context)).toMatchObject({ value: { start: '2026-09-01', end: '2026-09-30' } });
    expect(resolveNavisContinuation(open({ kind: 'period' }), text('내일'), context)).toEqual({ kind: 'reask', reason: 'invalid', field: 'value' });
  });
});
