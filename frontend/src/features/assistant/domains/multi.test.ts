import { describe, expect, it, vi } from 'vitest';
import { classifyMultiRequest, planMultiRequest, type MultiStepSelection } from './multi';
import { createDomainRegistry, registeredDomains } from './registry';

const scope = { planId: 'owner-turn', runId: 'cafe-run' };
const sale: MultiStepSelection<string> = {
  intent: { kind: 'command', command: 'menu.setSaleStatus' }, local: '아메리카노 품절',
};
const sales: MultiStepSelection<string> = {
  intent: { kind: 'read', featureId: 'ledger', condition: { kind: 'default' } }, local: '오늘 매출',
};

describe('N21 compound planning', () => {
  it('registers the classifier independently of the ordinary domain routes (S8-066)', () => {
    const registry = createDomainRegistry(registeredDomains);
    const selected = vi.fn((clause: string) => {
      if (clause === '오늘 매출 알려줘') return { kind: 'step', ...sales } as const;
      if (clause === '크루아상 품절로 바꿔줘') return { kind: 'step', ...sale, local: '크루아상' } as const;
    });
    const result = registry.classifyMulti(scope, '오늘 매출 알려주고 크루아상 품절로 바꿔줘', selected);
    expect(result).toMatchObject({ kind: 'plan', value: { plan: { steps: [
      { id: 'step-1', intent: sales.intent },
      { id: 'step-2', intent: sale.intent },
    ] } } });
    expect(selected.mock.calls.map(([clause]) => clause)).toEqual(['오늘 매출 알려줘', '크루아상 품절로 바꿔줘']);
    expect(createDomainRegistry([]).classifyMulti(scope, '오늘 매출 알려주고 크루아상 품절로 바꿔줘', selected)).toBeUndefined();
  });

  it('keeps local drafts and handle arguments out of the plan, and assigns the explicit prerequisite (S8-069)', () => {
    const result = planMultiRequest(scope, [{
      intent: { kind: 'menu.create', category: 'drink' }, local: { name: 'private-name', price: 5800 },
    }, {
      intent: { kind: 'command', command: 'menu.setSaleStatus', args: { menuId: { handle: 'old-handle' }, status: 'sold_out' } },
      local: { name: 'private-name' }, dependsOn: [0],
    }]);

    expect(result?.plan).toEqual({ ...scope, steps: [
      { id: 'step-1', intent: { kind: 'command', command: 'menu.create' } },
      { id: 'step-2', intent: { kind: 'command', command: 'menu.setSaleStatus' }, dependsOn: ['step-1'] },
    ] });
    expect(result?.localByStep.get('step-1')).toEqual({ name: 'private-name', price: 5800 });
    expect(result?.localByStep.get('step-2')).toEqual({ name: 'private-name' });
  });

  it('passes the prior clause to the classifier for shorthand (S8-063)', () => {
    const result = classifyMultiRequest(scope, '우유 재고 5리터로 바꾸고 발주도 넣어줘', (clause, index, clauses) =>
      index === 0 ? { kind: 'step', intent: { kind: 'command', command: 'inventory.updateItem' }, local: clause }
        : { kind: 'step', intent: { kind: 'command', command: 'suppliers.createOrder' }, local: clauses[0], dependsOn: [0] });
    expect(result).toMatchObject({ kind: 'plan', value: { plan: { steps: [
      { intent: { command: 'inventory.updateItem' } },
      { intent: { command: 'suppliers.createOrder' }, dependsOn: ['step-1'] },
    ] } } });
    if (result?.kind === 'plan') expect(result.value.localByStep.get('step-2')).toBe('우유 재고 5리터로 바꿔줘');
  });

  it('splits a "…로 하고" setting from the next instruction (S8-064)', () => {
    const select = vi.fn((clause: string) => ({ kind: 'step' as const, ...sale, local: clause }));
    classifyMultiRequest(scope, '아메리카노 품절로 하고 카페라테는 5500원으로 해줘', select);
    expect(select.mock.calls.map(([clause]) => clause)).toEqual(['아메리카노 품절로 해줘', '카페라테는 5500원으로 해줘']);
    select.mockClear();
    classifyMultiRequest(scope, '카페라테 5500원으로 하고 아메리카노 품절 처리해줘', select);
    expect(select.mock.calls.map(([clause]) => clause)).toEqual(['카페라테 5500원으로 해줘', '아메리카노 품절 처리해줘']);
  });

  it('splits an explicit read list in order (S8-071)', () => {
    const select = vi.fn((clause: string) => ({ kind: 'step' as const, ...sales, local: clause }));
    classifyMultiRequest(scope, '오늘 매출이랑 쿠폰 성과랑 재고 부족한 거 한꺼번에 알려줘', select);
    expect(select.mock.calls.map(([clause]) => clause)).toEqual(['오늘 매출', '쿠폰 성과', '재고 부족한 거 한꺼번에 알려줘']);
  });

  it('preserves prices, quoted content and ordinary single-action requests', () => {
    const select = vi.fn((clause: string) => ({ kind: 'step' as const, ...sale, local: clause }));
    expect(classifyMultiRequest(scope, '카페라테 가격 5,500원으로 바꿔줘', select)).toBeUndefined();
    expect(classifyMultiRequest(scope, '공지 제목 "오늘 주문, 그리고 안내"로 바꿔줘', select)).toBeUndefined();
    expect(classifyMultiRequest(scope, "공지 제목 '오늘 주문, 그리고 안내'로 바꿔줘", select)).toBeUndefined();
    expect(classifyMultiRequest(scope, '사랑 쿠키 품절 처리해줘', select)).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    classifyMultiRequest(scope, '쿠폰 "그리고 쿠키" 가격 5,500원으로 바꿔줘; 오늘 매출 알려줘', select);
    expect(select.mock.calls.map(([clause]) => clause)).toEqual(['쿠폰 "그리고 쿠키" 가격 5,500원으로 바꿔줘', '오늘 매출 알려줘']);
  });

  it.each([
    ['메뉴 전부 500원 올려줘', 'refusal', 'bulk_menu_edit'],
    ['아메리카노 품절로 바꾸고 다시 판매 중으로 바꿔줘', 'clarification', 'contradictory_status'],
    ['아메리카노 품절 처리하고 바로 취소해줘', 'clarification', 'contradictory_status'],
  ])('stops unsafe compound interpretation for %s (S8-075/S8-076)', (text, kind, reason) => {
    const select = vi.fn();
    expect(classifyMultiRequest(scope, text, select)).toMatchObject({ kind, reason });
    expect(select).not.toHaveBeenCalled();
  });

  it('requests clarification when a clause cannot be safely classified', () => {
    expect(classifyMultiRequest(scope, '아메리카노 품절 처리해줘; 그거도 해줘', (_clause, index) =>
      index ? undefined : { kind: 'step', ...sale },
    )).toMatchObject({ kind: 'clarification', reason: 'unresolved_clause', clause: '그거도 해줘' });
  });

  it('validates the shared two-to-twelve-step range, ordered dependencies and single-delete cap', () => {
    expect(planMultiRequest(scope, [sale])).toBeUndefined();
    expect(planMultiRequest(scope, Array.from({ length: 12 }, () => sales))?.plan.steps).toHaveLength(12);
    expect(planMultiRequest(scope, Array.from({ length: 13 }, () => sales))).toBeUndefined();
    expect(planMultiRequest(scope, [sale, { ...sales, dependsOn: [1] }])).toBeUndefined();
    expect(planMultiRequest(scope, [{ ...sale, dependsOn: [0] }, sales])).toBeUndefined();
    expect(planMultiRequest(scope, [sale, { ...sales, intent: { kind: 'conversation', action: 'confirm', pendingId: 'foreign' } }])).toBeUndefined();
    expect(planMultiRequest(scope, [
      { ...sale, intent: { kind: 'command', command: 'menu.delete' } },
      { ...sale, intent: { kind: 'command', command: 'calendar.deleteEvent' } },
    ])).toBeUndefined();
  });
});
