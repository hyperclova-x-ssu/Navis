import { cafeTodayNet, cafeWeek, cafeFacts } from './__fixtures__/cafe';
import { describe, expect, it } from 'vitest';
import { simpleReply } from './simple';
import { buildAssistantContext, questionContext, storeFactSource, type WidgetFactSource } from './snapshot';
import { createWidgetDataStore, posFacts, TODAY } from '../../data/widget-data';

describe('staff schedule Navis (API-279)', () => {
  it('answers the working count from the supplied facts and recommends a 3×2 staff panel', () => {
    let count = 4;
    const source: WidgetFactSource = {
      view: (featureId, condition) => ({ status: 'ready', featureId, condition, variant: 'normal', model: {} }),
      facts: () => [{ key: 'staff.today.working', value: count, unit: 'person', date: '2026-10-26', labelKey: 'unused', labelText: { raw: '오늘 근무' } }],
    };
    const ask = () => simpleReply({ text: '오늘 근무 몇 명이야?', locale: 'ko', layer: 'management', source });
    expect(questionContext('오늘 근무 몇 명이야?').topics.has('staff-schedule')).toBe(true);
    expect(ask()).toMatchObject({ answer: expect.stringContaining('4명'), panels: [{ featureId: 'staff-schedule', size: { width: 3, height: 2 } }] });
    count = 5;
    expect(ask().answer).toContain('5명');
  });
  it('reads changed staff facts from the same run store for both fallback and provider context', () => {
    const store = createWidgetDataStore(), source = storeFactSource(store);
    const before = cafeFacts('staff-schedule');
    const working = Number(before.find(fact => fact.key === 'staff.today.working')!.value) + 1;
    const at14 = Number(before.find(fact => fact.key === 'staff.hourly.14.count')!.value) + 1;
    const created = store.dispatch({ type: 'staff.create', name: '한지민', idempotencyKey: 'staff' });
    if (!created.ok) throw new Error(created.messageKey);
    const staffId = (created.value as { staffId: string }).staffId;
    expect(store.dispatch({ type: 'staff.saveSchedule', staffId, date: TODAY, kind: 'work', start: '14:00', end: '18:00', breakMinutes: 0, idempotencyKey: 'shift' }).ok).toBe(true);
    const reply = simpleReply({ text: '오늘 근무 몇 명이야?', locale: 'ko', layer: 'management', source });
    expect(reply.answer).toContain(`${working}명`);
    const entry = buildAssistantContext({ text: '오늘 근무 몇 명이야?', store }).snapshot.find(e => 'featureId' in e && e.featureId === 'staff-schedule');
    expect(entry && 'facts' in entry && entry.facts).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'staff.today.working', value: working, date: TODAY }), expect.objectContaining({ key: 'staff.hourly.14.count', value: at14, date: TODAY })]));
  });
});

it('routes M2 questions to source facts and recommends their registered sizes', () => {
  let active = 2;
  const source: WidgetFactSource = {
    view: (featureId, condition) => ({ status: 'ready', featureId, condition, variant: 'normal', model: {} }),
    facts: view => view.featureId === 'custom-order' ? [
      { key: 'custom.active.count', value: active, unit: 'item', labelKey: '', labelText: { raw: '진행 중' } },
      { key: 'pickup.today.count', value: 1, unit: 'item', labelKey: '', labelText: { raw: '오늘 픽업' } },
    ] : view.featureId === 'store-environment' ? [
      { key: 'environment.temperature', value: 22.5, unit: '', labelKey: '', labelText: { raw: '현재 온도' } },
      { key: 'environment.humidity', value: 48, unit: 'percent', labelKey: '', labelText: { raw: '현재 습도' } },
    ] : [{ key: 'notice.unsentClosure.count', value: 1, unit: 'item', labelKey: '', labelText: { raw: '미발송 휴무 공지' } }],
  };
  for (const [text, featureId, width, height] of [
    ['주문제작 진행 상황 알려줘', 'custom-order', 3, 2],
    ['매장 온도와 습도 알려줘', 'store-environment', 2, 2],
    ['휴무 공지 보냈어?', 'notice-send', 2, 2],
  ] as const) {
    const reply = simpleReply({ text, locale: 'ko', layer: 'management', source });
    expect(reply.panels).toMatchObject([{ featureId, size: { width, height } }]);
    expect(questionContext(text).topics.has(featureId)).toBe(true);
  }
  active = 3;
  expect(simpleReply({ text: '주문제작 알려줘', locale: 'ko', layer: 'management', source }).answer).toContain('3');
  const context = buildAssistantContext({ text: '휴무 공지 보냈어?', layer: 'management', source });
  expect(context.catalog).toHaveLength(17);
  expect(context.snapshot).toContainEqual(expect.objectContaining({ featureId: 'notice-send', facts: expect.arrayContaining([expect.objectContaining({ key: 'notice.unsentClosure.count', value: 1 })]) }));
});

it('keeps recognized sales, actual deposits and receivables labeled in money answers', () => {
  let deposits = 1_386_336;
  const source: WidgetFactSource = {
    view: (featureId, condition) => ({ status: 'ready', featureId, condition, variant: 'normal', model: {} }),
    facts: view => view.featureId === 'ledger' ? [
      { key: 'ledger.sales.net', value: 1_284_000, unit: 'KRW', labelKey: '', labelText: { raw: '오늘 매출' } },
      { key: 'accounting.deposits.total', value: deposits, unit: 'KRW', labelKey: '', labelText: { raw: '실제 입금' } },
    ] : [
      { key: 'account.charge.total', value: 55_000, unit: 'KRW', labelKey: '', labelText: { raw: '총 충전금' } },
      { key: 'account.receivable.total', value: 10_000, unit: 'KRW', labelKey: '', labelText: { raw: '총 외상' } },
    ],
  };
  const finance = simpleReply({ text: '오늘 매출과 실제 입금 알려줘', locale: 'ko', layer: 'management', source });
  expect(finance.answer).toContain('오늘 매출');
  expect(finance.answer).toContain('실제 입금');
  deposits = 1_436_336;
  expect(simpleReply({ text: '오늘 입금 알려줘', locale: 'ko', layer: 'management', source }).answer).toContain('143.6');
  const credit = simpleReply({ text: '충전금과 미수금 알려줘', locale: 'ko', layer: 'management', source });
  expect(credit.answer).toContain('총 충전금');
  expect(credit.answer).toContain('총 외상');
  expect(credit.panels).toMatchObject([{ featureId: 'credit-receivable', size: { width: 2, height: 2 } }]);
  expect(questionContext('외상 미수금').topics.has('credit-receivable')).toBe(true);
  const context = buildAssistantContext({ text: '실제 입금 알려줘', layer: 'marketing', source });
  expect(context.snapshot).toContainEqual(expect.objectContaining({ featureId: 'ledger', facts: expect.arrayContaining([expect.objectContaining({ key: 'accounting.deposits.total', value: deposits, label: '실제 입금' })]) }));
});

it('reads actual finance facts from the canonical run projection without borrowing deposits for history', () => {
  const store = createWidgetDataStore(), source = storeFactSource(store);
  const context = buildAssistantContext({ text: '오늘 입금 알려줘', source });
  const deposits = posFacts(store.getSnapshot()).find(fact => fact.key === 'accounting.deposits.total')!.value;
  expect(context.snapshot).toContainEqual(expect.objectContaining({ featureId: 'ledger', facts: expect.arrayContaining([
    expect.objectContaining({ key: 'ledger.sales.net', value: cafeTodayNet }),
    expect.objectContaining({ key: 'accounting.deposits.total', value: deposits, label: expect.stringContaining('실제 입금') }),
  ]) }));
  expect(simpleReply({ text: '오늘 입금 알려줘', locale: 'ko', layer: 'management', source }).answer).toContain('실제 입금');
  const history = context.snapshot.filter(entry => 'featureId' in entry && entry.featureId === 'ledger' && entry.condition.kind === 'dateRange' && entry.condition.start !== TODAY);
  expect(history).toContainEqual(expect.objectContaining({ condition: cafeWeek }));
  expect(history.every(entry => !('facts' in entry) || entry.facts.every(fact => !fact.key.startsWith('accounting.deposits.')))).toBe(true);
});
