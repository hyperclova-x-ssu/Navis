import manifest from './db/generated/manifest.json';
import { seedToday } from './db/generated/today';
import { seedMembers } from './db/generated/members';
import { addDays, dateRange, NOW, TOMORROW } from './db/time';
import { describe, expect, it } from 'vitest';
import {
  createWidgetDataStore, deriveRecipeCost, deriveStock, deriveSuggestions, deriveUsage,
  selectPayments, selectStockHistory, selectMembers, selectReservations, selectBriefing, selectClosing,
  readModel, widgetFacts, selectWidget, TODAY, type DataCommandResult, type WidgetDataStore,
} from './widget-data';

const day = { date: TODAY };
const payments = { ...day, scenario: 'normal' as const };
function success(result: DataCommandResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}
function recipe(store: WidgetDataStore, menuId: string, itemId: string, quantity: number) {
  const lines = store.getSnapshot().tables.recipeLine.filter((r) => r.menuId === menuId).map((r) => r.itemId === itemId ? { ...r, quantity } : r);
  return success(store.dispatch({ type: 'menu.setRecipe', menuId, lines }));
}

describe('반복 5 공용 원본과 파생값', () => {
  it('대조한 카페 결제 합계, 환불 참조, 판매량과 판매 당시 원가를 보존한다', () => {
    const s = createWidgetDataStore().getSnapshot();
    const p = selectPayments(s, payments);
    expect(p.rows).toHaveLength(manifest.counts.payments);
    expect(p.totals).toMatchObject({ gross: 859_500, discount: 28_280, net: 831_220, paymentCount: 153, refundCount: 0, byMethod: { card: 557_050, easy_pay: 217_270, cash: 56_900 } });
    expect(p.totals.refund === 0).toBe(true);
    expect(p.rows.slice(0, 4).map(r => [r.time, r.method, r.net])).toEqual([['15:42', 'card', 3000], ['15:40', 'easy_pay', 3000], ['15:39', 'card', 3800], ['15:38', 'card', 12600]]);
    expect(p.rows.every(r => r.kind === 'payment' && r.net > 0)).toBe(true);
    expect(p.totals.methodCounts).toEqual({ card: 103, easy_pay: 39, cash: 11 });
    expect(selectPayments(s, { ...payments, method: 'card' }).totals).toBe(p.totals);
    const original = s.tables.payment.find(row => row.paymentId === p.rows[0].paymentId)!;
    const refund = { ...original, paymentId: 'test-refund', kind: 'refund' as const, gross: 0, discount: 0, refundAmount: 3000,
      refundOf: original.paymentId, methodSplits: [{ method: 'card' as const, amount: -3000 }] };
    const historical = selectPayments({ ...s, pos: undefined, tables: { ...s.tables, payment: [original, refund] } }, payments);
    expect(historical.rows.find(row => row.kind === 'refund')).toMatchObject({ refundOf: original.paymentId, net: -3000 });
    expect(historical.rows.find(row => row.paymentId === refund.refundOf)?.net).toBe(3000);
    expect(historical.totals).toMatchObject({ net: 0, refund: 3000, refundCount: 1 });
    expect(deriveUsage(s, day).soldQty).toEqual(Object.fromEntries(seedToday.rollup.menu.map(([menuId, qty]) => [menuId, qty])));
    expect(readModel(s, 'margin')).toMatchObject({ cost: 244_333, grossProfit: 586_887, rate: 70.6 });
    expect(readModel(s, 'ledger')).toMatchObject({ remaining: 721_220 });
  });

  it('시작 재고와 메뉴별 사용을 정수 단위로 계산하고 7일 잔량을 연결한다', () => {
    const s = createWidgetDataStore().getSnapshot();
    const stock = deriveStock(s, day);
    // D-439 lowers the seeded salt-bread stock for the ref-1 countdown.
    expect(['i-milk', 'i-bean-house', 'i-cup-takeout', 'i-vanilla-syrup', 'i-saltbread', 'i-basque-cake'].map((id) => {
      const r = stock.rows.find((r) => r.itemId === id)!;
      return [r.opening, r.usedToday, r.display];
    })).toEqual([[42360, 21960, 20400], [8046, 2358, 5688], [607, 201, 1406], [3205, 655, 2550], [28, 16, 12], [21, 3, 18]]);
    expect(stock).toMatchObject({ restockCount: 0, outOfStockCount: 0 });
    expect(deriveSuggestions(s, day)).toEqual([]);
    const history = selectStockHistory(s, { itemId: 'i-milk', period: 'last7days' });
    expect(history.dayGroups.map((g) => g.date)).toEqual(dateRange(addDays(TODAY, -6), TODAY).reverse());
    expect(history.dayGroups[1].rows.some((r) => r.kind === 'receive' && r.delta === 56_000)).toBe(true);
    for (const [i, g] of history.dayGroups.entries()) {
      expect(g.opening + g.rows.filter((r) => r.kind !== 'opening').reduce((n, r) => n + r.delta, 0)).toBeCloseTo(g.endingRaw, 8);
      if (i > 0) expect(g.endingRaw).toBe(history.dayGroups[i - 1].opening);
    }
    const todayMilk = selectStockHistory(s, { itemId: 'i-milk', period: 'today' }).dayGroups[0];
    expect(todayMilk.rows[0].delta).toBe(42_360);
    expect(todayMilk.rows.filter(row => row.kind === 'usage').reduce((sum, row) => sum + row.delta, 0)).toBe(-21_960);
    expect(todayMilk.endingRaw).toBe(20_400);
  });

  it('라떼 레시피 수정과 역변경은 원두 실적을 보존하고 예상 부족량과 발주 제안을 갱신한다', () => {
    const store = createWidgetDataStore();
    const beans = () => readModel(store.getSnapshot(), 'inventory-booking').ingredients.find(row => row.itemId === 'i-bean-house');
    const beanSuggestion = () => readModel(store.getSnapshot(), 'suppliers').suggestions.find(row => row.itemId === 'i-bean-house');
    const before = beans();
    expect(before).toMatchObject({ usedToday: 2_358, raw: 5_688, stock: 5_688, deficit: 0, expectedUsageRemaining: 684, projectedRaw: 5_004, projectedDeficit: 0 });
    expect(beanSuggestion()).toBeUndefined();

    const beanEdit = recipe(store, 'm-cafe-latte', 'i-bean-house', 1_800);
    expect(beans()).toMatchObject({ usedToday: 2_358, raw: 5_688, stock: 5_688, deficit: 0, expectedUsageRemaining: 6_030, projectedRaw: -342, projectedDeficit: 342 });
    expect(beanSuggestion()).toMatchObject({ qty: 9, total: 207_000, unit: 'kg', dueDate: addDays(TODAY, 2) });
    expect(readModel(store.getSnapshot(), 'margin')).toMatchObject({ cost: 244_333, rate: 70.6 });
    success(store.undo(beanEdit.undoToken!));
    expect(beans()).toEqual(before);
    expect(beanSuggestion()).toBeUndefined();

    const syrup = () => deriveStock(store.getSnapshot(), day).rows.find(row => row.itemId === 'i-vanilla-syrup');
    const beforeSyrup = syrup();
    const syrupEdit = recipe(store, 'm-vanilla-latte', 'i-vanilla-syrup', 160);
    expect(deriveRecipeCost(store.getSnapshot(), 'm-vanilla-latte')).toMatchObject({ cost: 3_380, margin: 920, rate: 21.4 });
    expect(syrup()).toMatchObject({ usedToday: 655, raw: 2_550, expectedUsageRemaining: 1_340, projectedRaw: 1_210 });
    success(store.undo(syrupEdit.undoToken!));
    expect(syrup()).toEqual(beforeSyrup);
    success(store.dispatch({ type: 'menu.delete', menuId: 'm-vanilla-latte' }));
    expect(syrup()).toMatchObject({ usedToday: 655, expectedUsageRemaining: 60 });
    expect(store.dispatch({ type: 'inventory.deleteItem', itemId: 'i-vanilla-syrup' })).toMatchObject({ ok: false, reason: 'REFERENCED_ITEM' });
  });

  it('목표 수량 수정은 음수 raw에서 보정하며 중복 이력을 만들지 않는다', () => {
    const { stockOpening } = createWidgetDataStore().getSnapshot().tables;
    const store = createWidgetDataStore({ stockOpening: stockOpening.map(row =>
      row.itemId === 'i-milk' && row.businessDate === TODAY ? { ...row, quantityBase: 17_400 } : row,
    ) });
    expect(deriveStock(store.getSnapshot(), day).rows.find(row => row.itemId === 'i-milk')).toMatchObject({ usedToday: 21_960, raw: -4_560, display: 0, deficit: 4_560 });
    const r = success(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', stock: 2000 }));
    expect(deriveStock(store.getSnapshot(), day).rows.find((r) => r.itemId === 'i-milk')?.raw).toBe(2000);
    expect(store.getSnapshot().tables.stockAdjustment.at(-1)?.deltaBase).toBe(6_560);
    const same = store.getSnapshot();
    success(store.dispatch({ type: 'inventory.updateItem', itemId: 'i-milk', stock: 2000 }));
    expect(store.getSnapshot()).toBe(same);
    success(store.undo(r.undoToken!));
    expect(deriveStock(store.getSnapshot(), day).rows.find((r) => r.itemId === 'i-milk')?.raw).toBe(-4560);
  });

  it('카페 판매의 초기 레시피는 회계 내역을 연결하기 전에도 고정된다', () => {
    const store = createWidgetDataStore();
    const usage = deriveUsage(store.getSnapshot(), day).byItem;
    recipe(store, 'm-cafe-latte', 'i-bean-house', 20);
    const edited = store.getSnapshot();
    expect(deriveUsage({ ...edited, pos: { ...edited.pos!, money: undefined } }, day).byItem).toEqual(usage);
  });

  it('입고 8 L는 한 revision에 23,200원 후보를 만들고 멱등 키와 역변경 묘비를 보존한다', () => {
    const initial = createWidgetDataStore().getSnapshot().tables;
    const milk = initial.purchaseItem.find(row => row.itemId === 'i-milk')!;
    const store = createWidgetDataStore({
      purchaseOrder: [...initial.purchaseOrder, { poId: 'test-order', supplierId: milk.supplierId, dueDate: TODAY, expectedTime: null, status: 'scheduled', variant: null }],
      purchaseOrderLine: [...initial.purchaseOrderLine, { poId: 'test-order', polId: 'test-line', itemId: milk.itemId,
        qtyOrdered: 12, unitPrice: milk.unitPrice, unitSnapshot: milk.purchaseUnit, basePerUnit: milk.basePerUnit }],
    });
    let notices = 0;
    store.subscribe(() => { notices++; });
    const c = { type: 'suppliers.recordReceipt' as const, polId: 'test-line', qty: 8, idempotencyKey: '입고' };
    const r = success(store.dispatch(c));
    expect(store.getSnapshot().revision).toBe(1);
    expect(notices).toBe(1);
    expect(deriveStock(store.getSnapshot(), day).rows.find((r) => r.itemId === 'i-milk')?.display).toBe(28_400);
    expect(readModel(store.getSnapshot(), 'ledger').candidates[0].amount).toBe(23_200);
    expect(store.dispatch(c)).toMatchObject({ ok: true, duplicate: true });
    expect(store.dispatch({ ...c, qty: 4 })).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_MISMATCH' });
    expect(store.getSnapshot().revision).toBe(1);
    success(store.undo(r.undoToken!));
    expect(store.dispatch(c)).toMatchObject({ ok: false, reason: 'COMMAND_UNDONE' });
    expect(store.getSnapshot().tables.receipt.filter(r => r.polId === 'test-line')).toHaveLength(0);
  });

  it('카페 회원과 방문 및 마케팅 대상은 같은 고객 원본이다', () => {
    const store = createWidgetDataStore();
    const snapshot = store.getSnapshot();
    const m = selectMembers(snapshot, {});
    expect(m.total).toBe(manifest.counts.members);
    expect(m.gradeCounts).toEqual({ regular: 250, frequent: 152, occasional: 43, inactive: 15 });
    const recentFrom = addDays(TODAY, -27);
    const expected = seedMembers.members.slice(0, 5).map(row => [
      row.code, row.maskedName, `010-****-${row.phoneLast4}`,
      row.visits.filter(visit => addDays(seedMembers.start, Math.floor(visit / 24)) >= recentFrom).length,
    ]);
    expect(expected.map(([id]) => {
      const row = m.rows.find(member => member.memberId === id)!;
      return [row.memberId, row.name, row.phone, row.recentVisits];
    })).toEqual(expected);
    expect(readModel(snapshot, 'customer-groups').counts).toEqual({ 'churn-risk': 29, 'first-visit': 2, regular: 250 });
    expect(readModel(snapshot, 'slot-coupon').regularsCount).toBe(1);
    expect(readModel(snapshot, 'expiry-coupon').routes.sms.recipients).toBe(151);
    const regular = m.rows.find(row => row.automaticGrade === 'regular' && row.memberId !== 'M-0012' && row.memberId !== 'M-0024' && row.memberId !== 'M-0052')!;
    success(store.dispatch({ type: 'members.setGrade', memberId: regular.memberId, grade: 'inactive' }));
    expect(selectMembers(store.getSnapshot(), {}).rows.find(row => row.memberId === regular.memberId)).toMatchObject({ automaticGrade: 'regular', grade: 'inactive' });
    expect(readModel(store.getSnapshot(), 'customer-groups').counts.regular).toBe(250);
    expect(store.dispatch({ type: 'members.delete', memberId: 'M-0012' })).toMatchObject({ ok: false, reason: 'MEMBER_HAS_OPEN_BALANCE' });
    const deletion = success(store.dispatch({ type: 'members.delete', memberId: regular.memberId }));
    expect(readModel(store.getSnapshot(), 'customer-groups').counts.regular).toBe(249);
    success(store.undo(deletion.undoToken!));
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(manifest.counts.members);
  });

  it('기본 카페 예약과 비활성 배치의 다음 시각 여유석을 읽는다', () => {
    const s = createWidgetDataStore().getSnapshot();
    expect(selectReservations(s, day)).toMatchObject({ count: 4, partyTotal: 10, changes: 1, availability: { at: '17:30', kind: 'seats', value: 27 } });
    expect(selectReservations(s, { date: TOMORROW })).toMatchObject({ count: 0, partyTotal: 0 });
  });

  it('중요 알림은 항목 수로 체크와 지원 및 카메라를 함께 읽는다', () => {
    const seed = createWidgetDataStore().getSnapshot().tables;
    const opening = seed.manual.find(row => row.category === 'opening')!;
    const grant = { ...seed.grantNotice[0], applyEnd: `${addDays(TODAY, 3)}T18:00` };
    const store = createWidgetDataStore({ grantNotice: [grant] });
    expect(selectBriefing(store.getSnapshot(), day).importantAlerts.count).toBe(3);
    for (const stepNo of [1, 2, 3, 4, 5]) success(store.dispatch({ type: 'manuals.toggleStep', manualId: opening.manualId, stepNo }));
    expect(selectBriefing(store.getSnapshot(), day).importantAlerts.count).toBe(2);
    success(store.dispatch({ type: 'grants.apply', noticeId: grant.noticeId, idempotencyKey: '신청' }));
    expect(selectBriefing(store.getSnapshot(), day).importantAlerts.count).toBe(1);
    expect(selectBriefing(store.getSnapshot(), day).importantAlerts.groups.map(group => group.id)).toEqual(['tax']);
    const preview = selectBriefing(store.getSnapshot(), { ...day, viewContext: { cameraDisconnected: true } }).importantAlerts;
    expect(preview.count).toBe(2);
    expect(preview.groups.find(group => group.id === 'tasks')?.items.map(item => item.id)).toEqual(['camera:sample-window']);
    expect(selectBriefing(store.getSnapshot(), day).importantAlerts.count).toBe(1);
  });

  it('마감은 15:45에 매출만 확정하고 늦은 역명령은 지출과 일반 undo 및 다른 시나리오를 보존한다', () => {
    const store = createWidgetDataStore();
    const c = { type: 'closing.closeDay' as const, ...payments, expectedGeneration: 0, idempotencyKey: '마감' };
    const close = success(store.dispatch(c));
    expect(selectClosing(store.getSnapshot(), payments)).toMatchObject({ status: 'closed', generation: 1, closedAt: NOW }); // D-248 / API-249
    success(store.dispatch({ ...c, scenario: 'empty', idempotencyKey: '빈마감' }));
    const expense = success(store.dispatch({ type: 'ledger.recordExpense', ...day, category: 'supplies', amount: 30_000 }));
    success(store.undo(close.undoToken!));
    expect(readModel(store.getSnapshot(), 'ledger').expenses.total).toBe(140_000);
    expect(selectClosing(store.getSnapshot(), { ...day, scenario: 'empty' }).status).toBe('closed');
    success(store.undo(expense.undoToken!));
    expect(selectClosing(store.getSnapshot(), payments).status).toBe('reopened');
    expect(selectClosing(store.getSnapshot(), { ...day, scenario: 'empty' }).status).toBe('closed');
    success(store.dispatch({ ...c, expectedGeneration: 1, idempotencyKey: '재마감' }));
    expect(store.undo(close.undoToken!)).toMatchObject({ ok: false, reason: 'STALE_CLOSING' });
    expect(store.dispatch(c)).toMatchObject({ ok: false, reason: 'STALE_CLOSING' });
  });
});

it('마진 품목은 현재 원가와 마진율을 읽고 실적 합계는 당시 원가를 유지한다', () => {
  const store = createWidgetDataStore();
  recipe(store, 'm-cafe-latte', 'i-milk', 250);
  const model = readModel(store.getSnapshot(), 'margin');
  expect(model.menus.find((m) => m.menuId === 'm-cafe-latte')).toMatchObject({ unitCost: 1_249, unitMargin: 2_551, rate: 67.1 });
  expect(model).toMatchObject({ cost: 244_333, grossProfit: 586_887, rate: 70.6 });
  success(store.dispatch({ type: 'menu.create', name: '원가 없는 메뉴', category: 'drink', price: 4_000, idempotencyKey: '메뉴' }));
  expect(readModel(store.getSnapshot(), 'margin')).toMatchObject({ cost: 244_333, grossProfit: 586_887, rate: 70.6 });
});

it('Navis 재고 사실은 레시피 수정 후에도 판매 당시 우유 사용량을 읽는다', () => {
  const store = createWidgetDataStore();
  const facts = () => widgetFacts(selectWidget(store.getSnapshot(), 'inventory-booking', { kind: 'default' }, 'normal'));
  const milkUsage = () => facts().find((f) => f.key === 'inventory.usedToday' && f.labelText && 'raw' in f.labelText && f.labelText.raw === '목장 1등급 우유');
  const before = milkUsage();
  expect(before).toMatchObject({ value: 21_960, unit: 'mL' });
  recipe(store, 'm-cafe-latte', 'i-milk', 250);
  expect(milkUsage()).toEqual(before);
});
