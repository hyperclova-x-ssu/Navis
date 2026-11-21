import { setup as setupMoney } from '../pos/loyalty/test-setup';
import { getPaymentBillId, quotePaymentBill } from '../pos/loyalty';
import { describe, expect, it, vi } from 'vitest';
import * as posSeed from '../pos/seed';
import { createSeedTables } from './db/seed';
import manifest from './db/generated/manifest.json';
import { YESTERDAY } from './db/time';
import type { Reservation } from './db/types';
import { initializeCustomPos } from './pos/projection';
import type { SessionGate, SessionTransaction, TableLayout } from '../contracts';
import {
  createWidgetDataStore, deriveRecipeCost, deriveSuggestions, deriveOpenOrders, selectMembers, selectPayments,
  selectReservations, selectClosing, selectCalendar, selectBriefing, selectStockHistory, selectWidget,
  readMemberships, previewViewContext, resolveClosingVariant, TODAY, type DataCommand, type DataCommandResult, type WidgetDataStore,
} from './widget-data';
import { projectPosLoyalty } from './pos/loyalty';
import { inputOf } from './marketing/promo-fixtures';

const day = { date: TODAY };
function ok(r: DataCommandResult) { expect(r.ok, JSON.stringify(r)).toBe(true); if (!r.ok) throw new Error(r.messageKey); return r; }
const value = <T>(r: DataCommandResult) => ok(r).value as T;
const baseLayout: TableLayout = { layoutId: '테이블', columns: 9, rows: 6, revision: 0, tables: [1, 2, 3, 4, 5, 6].map((number) => ({ tableId: `T${number}`, number, seats: number < 4 ? 2 : 4, column: [1, 4, 7][(number - 1) % 3], row: number <= 3 ? 1 : 3 })) };
const tx = (s: WidgetDataStore, n = '설정'): SessionTransaction => ({ transactionId: n, runId: s.getSnapshot().runId!, expectedDataRevision: s.getSnapshot().revision, expectedRunRevision: 0, transitionToken: n });
function settings(s: WidgetDataStore, layout: TableLayout | null, paymentStyle: 'prepaid' | 'postpaid' = 'postpaid') {
  const transaction = tx(s);
  const prepared = s.session.prepare(transaction, { type: 'shop.updateSettings', businessType: 'cafe', paymentStyle, tableLayout: layout });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.reason);
  expect(s.session.isCurrent(prepared.change)).toBe(true);
  s.session.publish(prepared.change); s.session.flush(transaction.transactionId);
}

const seed = createSeedTables();
const milk = seed.purchaseItem.find(row => row.itemId === 'i-milk')!;
const syrup = seed.purchaseItem.find(row => row.itemId === 'i-vanilla-syrup')!;
const openingPassId = 'sample-pass-1';
const passHolder = 'M-0008';
const cafeDelivery = seed.purchaseOrder.find(row => row.dueDate === TODAY && row.status === 'complete')!;
const runningCoupon = seed.marketing.coupon.find(row => row.status === 'active')!;

function ordersScenario(includeOverdue = false) {
  const orders = [{ poId: 'test-milk-delivery', dueDate: TODAY }, ...(includeOverdue ? [{ poId: 'test-overdue', dueDate: YESTERDAY }] : [])];
  return createWidgetDataStore({
    purchaseOrder: [...seed.purchaseOrder, ...orders.map(order => ({ ...order, supplierId: milk.supplierId, expectedTime: null, status: 'scheduled' as const, variant: null }))],
    purchaseOrderLine: [...seed.purchaseOrderLine, ...orders.map(({ poId }) => ({
      poId, polId: `line:${poId}`, itemId: milk.itemId, qtyOrdered: 12, unitPrice: milk.unitPrice, unitSnapshot: milk.purchaseUnit, basePerUnit: milk.basePerUnit,
    }))],
  });
}

function oneUseScenario() {
  const pos = initializeCustomPos(posSeed.createPosSeed());
  const money = pos.money!;
  const memberships = money.memberships.map(row => row.membershipId === openingPassId ? { ...row, memberId: passHolder, openingUses: 9 } : row);
  const spy = vi.spyOn(posSeed, 'createPosSeed').mockReturnValueOnce({ ...pos, money: { ...money, memberships } });
  try { return setupMoney(); } finally { spy.mockRestore(); }
}

function bookingScenario() {
  const template = seed.reservation.find((row): row is Reservation => row.kind === 'visit' && row.reservationId === 'sample-booking-1')!;
  const rows = [
    { reservationId: 'test-past', time: '13:00', tableId: null, partySize: 2 },
    { reservationId: 'test-future', time: '17:00', tableId: 'T5', partySize: 3 },
    { reservationId: 'test-future-2', time: '17:00', tableId: 'T6', partySize: 3 },
  ];
  return rows.map(row => ({ ...template, ...row, assignmentMode: 'manual' as const, memberId: undefined, guestName: { key: 'data.management.guest' } }));
}

describe('업무 명령의 원자성과 참조 경계', () => {
  it('새 메뉴는 원가 미등록이며 판매량이 없고 편집과 보관을 되돌린다', () => {
    const s = createWidgetDataStore();
    const c = { type: 'menu.create' as const, name: '새 음료', category: 'drink' as const, price: 4_000, idempotencyKey: '메뉴' };
    const created = ok(s.dispatch(c)), { menuId } = created.value as { menuId: string };
    expect(deriveRecipeCost(s.getSnapshot(), menuId)).toMatchObject({ cost: null, margin: null, rate: null, soldQty: 0 });
    const updated = ok(s.dispatch({ type: 'menu.update', menuId, patch: { price: 4_500, memo: '메모' } }));
    ok(s.undo(updated.undoToken!));
    expect(deriveRecipeCost(s.getSnapshot(), menuId).cost).toBeNull();
    const removed = ok(s.dispatch({ type: 'menu.delete', menuId }));
    expect(selectWidget(s.getSnapshot(), 'menu', { kind: 'default' }, 'normal')).toMatchObject({ model: { total: manifest.counts.menu } });
    ok(s.undo(removed.undoToken!));
    expect(selectWidget(s.getSnapshot(), 'menu', { kind: 'default' }, 'normal')).toMatchObject({ model: { total: manifest.counts.menu + 1 } });
    expect(s.undo(created.undoToken!)).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
  });
  it.each([
    { type: 'menu.setRecipe', menuId: 'm-cafe-latte', lines: [{ itemId: 'i-milk', quantity: 0.0001, unit: 'L' }] },
    { type: 'menu.setRecipe', menuId: 'm-cafe-latte', lines: [{ itemId: 'i-milk', quantity: 1, unit: 'g' }] },
    { type: 'menu.setRecipe', menuId: 'm-cafe-latte', lines: [{ itemId: 'i-milk', quantity: 0, unit: 'mL' }] },
    { type: 'menu.update', menuId: 'm-cafe-latte', patch: { price: 0 } },
    { type: 'inventory.updateItem', itemId: 'i-cup-takeout', stock: 0.5 },
    { type: 'inventory.updateItem', itemId: 'i-milk', stock: Number.NaN },
    { type: 'inventory.updateItem', itemId: 'i-milk', sku: '바꿀수없음' },
    { type: 'suppliers.recordReceipt', polId: 'line:test-milk-delivery', qty: 13, idempotencyKey: '초과' },
  ] as const)('유효하지 않은 입력 $type은 쓰기와 알림이 없다', (command) => {
    const s = ordersScenario(), before = s.getSnapshot(); let notifications = 0;
    s.subscribe(() => { notifications++; });
    expect(s.dispatch(command as DataCommand)).toMatchObject({ ok: false });
    expect(s.getSnapshot()).toBe(before); expect(notifications).toBe(0);
  });
  it('현재 단가만 고치고 과거 주문과 실적 원가는 보존한다', () => {
    const s = ordersScenario();
    ok(s.dispatch({ type: 'suppliers.updatePurchaseItem', purchaseItemId: milk.purchaseItemId, patch: { unitPrice: 4_000 } }));
    expect(deriveRecipeCost(s.getSnapshot(), 'm-cafe-latte')).toMatchObject({ cost: 1_564, rate: 58.8 });
    expect(deriveRecipeCost(s.getSnapshot(), 'm-vanilla-latte')).toMatchObject({ cost: 1_822, rate: 57.6 });
    expect(deriveOpenOrders(s.getSnapshot(), day)).toMatchObject({ monthCount: 20, monthTotal: 2_656_800 });
    const r = value<{ expenseId: string }>(s.dispatch({ type: 'suppliers.recordReceipt', polId: 'line:test-milk-delivery', qty: 8, idempotencyKey: '입고' }));
    expect(s.getSnapshot().tables.expense.find((e) => e.expenseId === r.expenseId)?.amount).toBe(23_200);
    expect(selectPayments(s.getSnapshot(), { ...day, scenario: 'normal' }).totals.net).toBe(831_220);
  });
  it('초기 수량은 한 번만 기록하고 MOQ 제안을 다시 검사하며 부분 취소는 입고를 남긴다', () => {
    const s = createWidgetDataStore();
    const { itemId } = value<{ itemId: string }>(s.dispatch({ type: 'inventory.createItem', sku: 'RM-991', name: '새 재료', unit: 'L', stock: 2, threshold: 1, idempotencyKey: '품목' }));
    expect(selectStockHistory(s.getSnapshot(), { itemId, period: 'today' }).dayGroups[0]).toMatchObject({ opening: 0, endingRaw: 2 });
    expect(s.getSnapshot().tables.stockOpening.some((o) => o.itemId === itemId)).toBe(false);
    const deletion = ok(s.dispatch({ type: 'inventory.deleteItem', itemId })); ok(s.undo(deletion.undoToken!));
    ok(s.dispatch({ type: 'inventory.updateItem', itemId: 'i-vanilla-syrup', stock: 500 }));
    expect(deriveSuggestions(s.getSnapshot(), day)).toMatchObject([{ qty: 4, total: 54_000 }]);
    const order = { type: 'suppliers.createOrder' as const, purchaseItemId: syrup.purchaseItemId, qty: 4, suggestionItemId: 'i-vanilla-syrup', idempotencyKey: '제안발주' };
    const { poId, polId } = value<{ poId: string; polId: string }>(s.dispatch(order));
    expect(s.dispatch({ ...order, idempotencyKey: '옛제안' })).toMatchObject({ ok: false, reason: 'STALE_SUGGESTION' });
    ok(s.dispatch({ type: 'suppliers.recordReceipt', polId, qty: 1, idempotencyKey: '부분입고' }));
    ok(s.dispatch({ type: 'suppliers.cancelOrder', poId }));
    expect(deriveOpenOrders(s.getSnapshot(), day).orders.find((o) => o.poId === poId)).toMatchObject({ status: 'canceled', lines: [{ received: 1, remaining: 3 }] });
    expect(s.getSnapshot().tables.expense.filter((e) => e.receiptId?.startsWith('rc-'))).toHaveLength(1);
  });
  it('회원권 마지막 사용과 취소는 연결된 활성 수만 바꾸고 활성 회원권이 남은 회원은 지울 수 없다', () => {
    const h = oneUseScenario(), s = h.data;
    expect(readMemberships(s.getSnapshot())).toMatchObject({ activeCount: 3, endingThisWeekCount: 1 });
    const { useId } = value<{ useId: string }>(coveredUse(h,openingPassId,'마지막'));
    expect(selectMembers(s.getSnapshot(), {}).membershipCount).toBe(2);
    ok(s.dispatch({ type: 'memberships.cancelUse', useId }));
    expect(selectMembers(s.getSnapshot(), {}).membershipCount).toBe(3);
    const before = s.getSnapshot(), beforeUses = before.tables.membershipUse;
    const unchanged = projectPosLoyalty(before.tables, { ...before.pos!, revision: before.pos!.revision + 1 }, before.pos);
    expect(unchanged.membershipUse).toBe(beforeUses);
    // The restored pass prevents its holder from being archived.
    expect(s.dispatch({ type: 'members.delete', memberId: passHolder })).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'MEMBER_HAS_OPEN_BALANCE' });
    expect(selectMembers(s.getSnapshot(), {}).membershipCount).toBe(3);
    expect(s.getSnapshot().tables.membershipUse).toBe(beforeUses);
  });
  it('회원 CRUD와 메모는 광고 동의와 방문을 만들지 않고 숫자 연락처만 받는다', () => {
    const s = createWidgetDataStore();
    expect(s.dispatch({ type: 'members.create', name: '새회원', phone: '010-1234-5678', idempotencyKey: '잘못된전화' })).toMatchObject({ ok: false });
    const { memberId } = value<{ memberId: string }>(s.dispatch({ type: 'members.create', name: '새회원', phone: '01012345678', idempotencyKey: '회원' }));
    expect(selectMembers(s.getSnapshot(), { query: '5678' }).rows[0]).toMatchObject({ memberId, grade: 'occasional', recentVisits: 0, consentSms: false });
    const note = value<{ noteId: string }>(s.dispatch({ type: 'members.addNote', memberId, body: '가짜 메모' }));
    ok(s.dispatch({ type: 'members.updateNote', memberId, noteId: note.noteId, body: '바꾼 메모' }));
    expect(selectMembers(s.getSnapshot(), { query: '5678' }).rows[0].notes[0].body).toEqual({ raw: '바꾼 메모' });
    const deletion = ok(s.dispatch({ type: 'members.deleteNote', memberId, noteId: note.noteId })); ok(s.undo(deletion.undoToken!));
    expect(selectMembers(s.getSnapshot(), { query: '5678' }).rows[0].notes).toHaveLength(1);
  });
});

describe('예약 배정과 설정 transaction', () => {
  it('예약 이름만 고치면 연락처와 요청을 보존하고 되돌리기는 변경분만 복원한다', () => {
    const s = createWidgetDataStore();
    const { reservationId } = value<{ reservationId: string }>(s.dispatch({ type: 'booking.create', guest: { name: '홍길동', phone: '01012345678' }, request: '창가', date: TODAY, time: '19:00', partySize: 2, tableChoice: 'auto', idempotencyKey: '연락처 보존' }));
    const before = s.getSnapshot().tables.reservation.find((r) => r.reservationId === reservationId)!;
    const edit = ok(s.dispatch({ type: 'booking.update', reservationId, patch: { guest: { name: '김하나' } } }));
    const after = s.getSnapshot().tables.reservation.find((r) => r.reservationId === reservationId)!;
    expect(after).toMatchObject({ guestName: { raw: '김○나' }, phone: { raw: '010-****-5678' }, request: { raw: '창가' } });
    ok(s.undo(edit.undoToken!));
    expect(s.getSnapshot().tables.reservation.find((r) => r.reservationId === reservationId)).toEqual(before);
  });
  it('예약의 다른 항목을 수정할 때 기존 이름과 연락처와 요청을 보존하고 명시적으로 요청을 지운다', () => {
    const s = createWidgetDataStore();
    const { reservationId } = value<{ reservationId: string }>(s.dispatch({ type: 'booking.create', guest: { name: '홍길동', phone: '01012345678' }, request: '창가', date: TODAY, time: '19:00', partySize: 2, tableChoice: 'auto', idempotencyKey: '요청 보존' }));
    ok(s.dispatch({ type: 'booking.update', reservationId, patch: { partySize: 3 } }));
    expect(s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === reservationId)).toMatchObject({ guestName: { raw: '홍○동' }, phone: { raw: '010-****-5678' }, request: { raw: '창가' }, partySize: 3 });
    const clear = ok(s.dispatch({ type: 'booking.update', reservationId, patch: { request: null } }));
    expect(s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === reservationId)?.request).toBeNull();
    ok(s.undo(clear.undoToken!));
    expect(s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === reservationId)?.request).toEqual({ raw: '창가' });
  });
  it('명시한 연락처는 교체하고 회원에서 비회원으로 바꾸면 이전 회원 연락처를 가져오지 않는다', () => {
    const s = createWidgetDataStore();
    const { reservationId } = value<{ reservationId: string }>(s.dispatch({ type: 'booking.create', guest: { name: '홍길동', phone: '01012345678' }, date: TODAY, time: '19:00', partySize: 2, tableChoice: 'auto', idempotencyKey: '연락처 변경' }));
    const edit = ok(s.dispatch({ type: 'booking.update', reservationId, patch: { guest: { name: '홍길동', phone: '01098765432' } } }));
    expect(s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === reservationId)?.phone).toEqual({ raw: '010-****-5432' });
    ok(s.undo(edit.undoToken!));
    expect(s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === reservationId)?.phone).toEqual({ raw: '010-****-5678' });
    ok(s.dispatch({ type: 'booking.update', reservationId, patch: { memberId: 'M-0001' } }));
    ok(s.dispatch({ type: 'booking.update', reservationId, patch: { guest: { name: '김하나' } } }));
    const guest = s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === reservationId)!;
    expect(guest.memberId).toBeUndefined();
    expect(guest.phone).toBeUndefined();
  });
  it('부분 수정의 undo는 이후 설정이 바꾼 같은 예약의 자리 배정을 보존한다', () => {
    const s = createWidgetDataStore();
    const { reservationId } = value<{ reservationId: string }>(s.dispatch({ type: 'booking.create', guest: { name: '홍길동', phone: '01012345678' }, date: TODAY, time: '19:00', partySize: 2, tableChoice: 'auto', idempotencyKey: '자리 보존' }));
    const edit = ok(s.dispatch({ type: 'booking.update', reservationId, patch: { guest: { name: '김하나' } } }));
    settings(s, baseLayout);
    const assigned = s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === reservationId)?.tableId;
    expect(assigned).toBeTruthy();
    ok(s.undo(edit.undoToken!));
    expect(s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === reservationId)).toMatchObject({ guestName: { raw: '홍○동' }, phone: { raw: '010-****-5678' }, tableId: assigned });
  });
  it('자리 선택이 없는 예약 수정은 기존 배정 방식과 확정 정보를 유지한다', () => {
    const reservations = bookingScenario();
    const s = createWidgetDataStore({ reservation: reservations.map((r) => r.reservationId === 'test-past' ? { ...r, assignmentMode: 'manual', tableId: null, confirmedBy: 'person', status: 'proposed', proposedTime: '18:00' } : r) });
    ok(s.dispatch({ type: 'booking.update', reservationId: 'test-past', patch: { request: '창가' } }));
    expect(s.getSnapshot().tables.reservation.filter(r=>r.kind!=='pickup').find((r) => r.reservationId === 'test-past')).toMatchObject({ assignmentMode: 'manual', tableId: null, confirmedBy: 'person', status: 'proposed', proposedTime: '18:00' });
  });
  it('시드 예약의 번역 키 이름은 다른 항목만 고칠 때 유지된다', () => {
    const reservations = bookingScenario();
    const s = createWidgetDataStore({ reservation: reservations.map((r) => r.reservationId === 'test-past' ? { ...r, memberId: undefined, guestName: { key: 'data.management.guest' } } : r) });
    const original = s.getSnapshot().tables.reservation.find((r) => r.reservationId === 'test-past')!;
    const edit = ok(s.dispatch({ type: 'booking.update', reservationId: original.reservationId, patch: { partySize: 3 } }));
    expect(s.getSnapshot().tables.reservation.find((r) => r.reservationId === original.reservationId)).toMatchObject({ guestName: { key: 'data.management.guest' }, partySize: 3 });
    ok(s.undo(edit.undoToken!));
    expect(s.getSnapshot().tables.reservation.find((r) => r.reservationId === original.reservationId)).toEqual(original);
  });
  // GD-1: a new booking can no longer start before the business clock (15:45), so the 120-minute end is checked against the 17:00 rows (was 11:00 rows with 13:00 / 12:59).
  it('120분 끝은 다음 시작과 겹치지 않고 새 예약과 과거 예약 표시를 가린다', () => {
    const s = createWidgetDataStore({ reservation: bookingScenario() }); settings(s, baseLayout);
    expect(selectReservations(s.getSnapshot(), day).availability).toEqual({ at: '17:00', kind: 'tables', value: 4 });
    const command = { type: 'booking.create' as const, guest: { name: '홍길동', phone: '01012345678' }, date: TODAY, time: '19:00', partySize: 2, tableChoice: 'auto' as const, idempotencyKey: '예약' };
    const first = value<{ reservationId: string }>(s.dispatch(command));
    expect(selectReservations(s.getSnapshot(), day).rows.find((r) => r.reservationId === first.reservationId)).toMatchObject({ tableId: 'T1', name: { raw: '홍○동' }, phone: { raw: '010-****-5678' } });
    const blocked = value<{ status: string; tableId: string | null }>(s.dispatch({ ...command, time: '18:59', tableChoice: { tableId: 'T5' }, idempotencyKey: '충돌' }));
    expect(blocked).toMatchObject({ status: 'needs-check', tableId: null });
    expect(s.dispatch({ type: 'booking.markCompleted', reservationId: 'test-future' })).toMatchObject({ ok: false });
    ok(s.dispatch({ type: 'booking.markCompleted', reservationId: 'test-past' }));
    expect(selectReservations(s.getSnapshot(), day).rows.find((r) => r.reservationId === 'test-past')?.counts).toBe(true);
  });
  it('처음 활성화에만 미배정 확정을 배정하고 다시 켜면 기존 자리와 대기를 유지한다', () => {
    const s = createWidgetDataStore({ reservation: bookingScenario().map(row => ({ ...row, tableId: null })) });
    settings(s, baseLayout);
    expect(selectReservations(s.getSnapshot(), day).rows.find((r) => r.reservationId === 'test-past')?.tableId).toBe('T1');
    settings(s, baseLayout, 'prepaid'); settings(s, baseLayout);
    expect(selectReservations(s.getSnapshot(), day).rows.find((r) => r.reservationId === 'test-past')?.tableId).toBe('T1');
    const group = value<{ reservationId: string; status: string; tableId: null }>(s.dispatch({ type: 'booking.create', guest: { name: '단체' }, date: TODAY, time: '17:00', partySize: 20, tableChoice: 'auto', idempotencyKey: '단체' }));
    expect(group.status).toBe('needs-check');
    ok(s.dispatch({ type: 'booking.confirm', reservationId: group.reservationId }));
    expect(selectReservations(s.getSnapshot(), day).rows.find((r) => r.reservationId === group.reservationId)).toMatchObject({ status: 'confirmed', tableId: null, capacityOverride: true, allocationWarning: 'NO_MATCHING_TABLE' });
  });
  it('prepare는 공개하지 않고 stale·abort·위조 ticket은 쓰지 않으며 flush 재진입을 거절한다', () => {
    const gate = { phase: 'idle', transactionId: null } as { phase: SessionGate['phase']; transactionId: string | null };
    const s = createWidgetDataStore(undefined, { runId: '세션', sessionGate: gate });
    const before = s.getSnapshot(); let first = 0, second = 0;
    s.subscribe(() => { first++; expect(s.dispatch({ type: 'members.setGrade', memberId: 'M-0001', grade: 'inactive' })).toMatchObject({ ok: false, reason: 'TRANSACTION_BUSY' }); throw new Error('구독자 예외'); });
    s.subscribe(() => { second++; });
    expect(s.dispatch({ type: 'shop.updateSettings', businessType: 'cafe', paymentStyle: 'postpaid', tableLayout: baseLayout })).toMatchObject({ ok: false, reason: 'COORDINATOR_REQUIRED' });
    const transaction = tx(s); gate.phase = 'preparing'; gate.transactionId = transaction.transactionId;
    const result = s.session.prepare(transaction, { type: 'shop.updateSettings', businessType: 'cafe', paymentStyle: 'postpaid', tableLayout: baseLayout });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
    expect(s.getSnapshot()).toBe(before); expect(first).toBe(0);
    expect(s.session.isCurrent(result.change)).toBe(true);
    s.session.publish({ ...result.change, ticket: '가짜' }); expect(s.getSnapshot()).toBe(before);
    gate.phase = 'publishing'; s.session.publish(result.change); expect(first).toBe(0);
    expect(s.getSnapshot().transactionId).toBe(transaction.transactionId);
    gate.phase = 'flushing'; s.session.flush(transaction.transactionId); s.session.flush(transaction.transactionId);
    expect([first, second]).toEqual([1, 1]); gate.phase = 'idle'; gate.transactionId = null;
    expect(s.session.isCurrent(result.change)).toBe(false);
    expect(s.session.prepare(transaction, { type: 'shop.updateSettings', businessType: 'cafe', paymentStyle: 'postpaid' })).toMatchObject({ ok: false });
  });
});

describe('장부와 일반 undo의 교차', () => {
  it('멱등 payload 순서와 revision 사전조건을 구분하고 이전 token과 재사용 키를 거절한다', () => {
    const s = createWidgetDataStore();
    const c = { type: 'menu.create' as const, name: '음료', category: 'drink' as const, price: 4_000, idempotencyKey: '키' };
    const first = ok(s.dispatch(c));
    expect(s.dispatch({ idempotencyKey: '키', price: 4_000, category: 'drink', name: '음료', type: 'menu.create', baseRevision: 0 })).toMatchObject({ ok: true, duplicate: true });
    expect(s.dispatch({ ...c, price: 4_100 })).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_MISMATCH' });
    const before = s.getSnapshot();
    expect(s.dispatch({ type: 'menu.update', menuId: 'm-cafe-latte', patch: { price: 1 }, baseRevision: 0 })).toMatchObject({ ok: false, reason: 'STALE_REVISION' });
    expect(s.getSnapshot()).toBe(before);
    ok(s.undo(first.undoToken!));
    expect(s.dispatch(c)).toMatchObject({ ok: false, reason: 'COMMAND_UNDONE' });
    expect(s.dispatch({ ...c, idempotencyKey: '새키' })).toMatchObject({ ok: true });
  });
  it('영상 진행 중 일반 undo는 그 진행과 두 마감 및 장부를 보존한다', () => {
    const menuId = 'm-cafe-latte';
    const photos = Array.from({ length: 5 }, (_, order) => ({ photoId: `test-photo-${order}`, menuId, url: `/test/photo/${order}`, width: 900, height: 900, order }));
    const s = createWidgetDataStore({ marketing: { ...seed.marketing, promoPhoto: photos } });
    const { videoId } = value<{ videoId: string }>(s.dispatch({ type: 'video.make', input: inputOf(s, photos.length, { menuIds: [menuId] }), idempotencyKey: '영상' }));
    const c = { type: 'closing.closeDay' as const, date: TODAY, scenario: 'normal' as const, expectedGeneration: 0, idempotencyKey: '마감' };
    const close = ok(s.dispatch(c)); ok(s.dispatch({ ...c, scenario: 'empty', idempotencyKey: '빈마감' }));
    const edit = ok(s.dispatch({ type: 'coupon.pause', couponId: runningCoupon.couponId }));
    ok(s.dispatch({ type: 'video.progress', videoId, stage: 'story', stageState: 'active' }));
    ok(s.undo(edit.undoToken!));
    expect(s.getSnapshot().tables.marketing.promoVideo[0].stage).toBe('story');
    expect(selectClosing(s.getSnapshot(), { ...day, scenario: 'empty' }).status).toBe('closed');
    const booking = ok(s.dispatch({ type: 'booking.cancel', reservationId: 'sample-booking-1' }));
    ok(s.undo(close.undoToken!));
    expect(selectReservations(s.getSnapshot(), day).count).toBe(3);
    ok(s.undo(booking.undoToken!));
    expect(selectClosing(s.getSnapshot(), { ...day, scenario: 'normal' }).status).toBe('reopened');
    expect(s.getSnapshot().tables.marketing.promoVideo[0].stage).toBe('story');
    expect(s.dispatch({ ...c, expectedGeneration: 1, idempotencyKey: '마감2' })).toMatchObject({ ok: true });
    expect(s.undo(close.undoToken!)).toMatchObject({ ok: false, reason: 'STALE_CLOSING' });
  });
  it('달력의 임의 날짜와 자동 출처·분류, 세금·지원·문서의 역변경을 보존한다', () => {
    const s = createWidgetDataStore();
    ok(s.dispatch({ type: 'calendar.addEvent', title: '다음 해', date: '2027-01-05', categoryId: 'tax-admin' }));
    expect(selectCalendar(s.getSnapshot(), { date: '2027-01-05' }).todayCount).toBe(1);
    expect(s.dispatch({ type: 'calendar.deleteEvent', eventId: `delivery:${cafeDelivery.poId}` })).toMatchObject({ ok: false, reason: 'AUTO_EVENT_READ_ONLY' });
    ok(s.dispatch({ type: 'calendar.setCategoryVisible', categoryId: 'tax-admin', visible: false }));
    expect(selectCalendar(s.getSnapshot(), { date: '2027-01-05' }).todayCount).toBe(0);
    ok(s.dispatch({ type: 'tax.markPaid', taxPaymentId: 'sample-tax-1' }));
    expect(selectBriefing(s.getSnapshot(), day).importantAlerts.groups.map((g) => g.id)).not.toContain('tax');
    const note = value<{ applicationId: string }>(s.dispatch({ type: 'grants.apply', noticeId: 'sample-grant-1', idempotencyKey: '신청' }));
    const deletion = ok(s.dispatch({ type: 'grants.deleteApplication', applicationId: note.applicationId })); ok(s.undo(deletion.undoToken!));
    const manual = value<{ manualId: string }>(s.dispatch({ type: 'manuals.create', section: 'store-info', title: '안내', category: 'hygiene', steps: ['손 씻기'], idempotencyKey: '안내' }));
    const removed = ok(s.dispatch({ type: 'manuals.delete', manualId: manual.manualId })); ok(s.undo(removed.undoToken!));
    expect(s.getSnapshot().tables.manual.some((m) => m.manualId === manual.manualId && m.section === 'store-info')).toBe(true);
  });
});

describe('예시 상태와 정상 원본', () => {
  it('카메라 context만 브리핑에 연결하고 마감 empty/error를 독립 해석한다', () => {
    const s = createWidgetDataStore(), snapshot = s.getSnapshot();
    const context = previewViewContext({ family: 'special', overrides: { 'customer-analysis': 'camera-disconnected' } });
    expect(context).toEqual({ cameraDisconnected: true, reservationVariant: 'needs-confirmation', environmentVariant:'out_of_range' });
    expect(selectBriefing(snapshot, { ...day, viewContext: context }).importantAlerts.groups.at(-1)?.items.some((i) => i.id === 'camera:sample-window')).toBe(true);
    expect(selectBriefing(snapshot, day).importantAlerts.groups.at(-1)?.items.some((i) => i.id === 'camera:sample-window')).toBe(false);
    expect(resolveClosingVariant({ family: 'empty', overrides: {} })).toBe('no-payments');
    expect(resolveClosingVariant({ family: 'error', overrides: {}, closing: 'normal' })).toBe('normal');
    expect(s.dispatch({ type: 'closing.closeDay', ...day, scenario: 'error' as never, expectedGeneration: 0, idempotencyKey: '오류' })).toMatchObject({ ok: false, reason: 'PAYMENTS_UNAVAILABLE' });
    expect(s.getSnapshot()).toBe(snapshot);
  });
});

it('같은 레시피 저장은 revision과 기존 undo를 바꾸지 않으며 사용 기록 순서가 안정적이다', () => {
  const s = createWidgetDataStore();
  const edit = ok(s.dispatch({ type: 'menu.update', menuId: 'm-cafe-latte', patch: { price: 5_100 } }));
  const before = s.getSnapshot();
  const lines = before.tables.recipeLine.filter((r) => r.menuId === 'm-cafe-latte');
  ok(s.dispatch({ type: 'menu.setRecipe', menuId: 'm-cafe-latte', lines }));
  expect(s.getSnapshot()).toBe(before);
  ok(s.undo(edit.undoToken!));
  ok(s.dispatch({ type: 'menu.setRecipe', menuId: 'm-cafe-latte', lines: lines.map((r) => r.itemId === 'i-milk' ? { ...r, quantity: 250 } : r) }));
  const query = { itemId: 'i-milk', period: 'today' } as const;
  const baseline = selectStockHistory(before, query);
  const history = selectStockHistory(s.getSnapshot(), query);
  expect(history).toEqual(baseline);
  expect(history.dayGroups[0].rows.find(row => row.kind === 'usage' && row.sourceRef === 'm-cafe-latte')?.delta).toBe(-6_240);
});
it('마감 no-op 키도 재전송으로 다시 마감하지 않으며 다음 generation에서는 거절한다', () => {
  const s = createWidgetDataStore();
  const first = ok(s.dispatch({ type: 'closing.closeDay', ...day, scenario: 'normal', expectedGeneration: 0, idempotencyKey: '첫마감' }));
  const noop = { type: 'closing.closeDay' as const, ...day, scenario: 'normal' as const, expectedGeneration: 1, idempotencyKey: '이미마감' };
  const before = s.getSnapshot(); ok(s.dispatch(noop)); expect(s.getSnapshot()).toBe(before);
  ok(s.undo(first.undoToken!));
  expect(s.dispatch(noop)).toMatchObject({ ok: true, duplicate: true });
  expect(selectClosing(s.getSnapshot(), { ...day, scenario: 'normal' }).status).toBe('reopened');
  ok(s.dispatch({ ...noop, idempotencyKey: '다시마감' }));
  expect(s.dispatch(noop)).toMatchObject({ ok: false, reason: 'STALE_CLOSING' });
});
it('정상 원본 자체가 비면 새 메뉴와 회원 위젯은 추가 동작이 있는 빈 상태를 낸다', () => {
  const s = createWidgetDataStore({ menuItem: [], memberProfile: [] });
  expect(selectWidget(s.getSnapshot(), 'menu', { kind: 'default' }, 'normal')).toMatchObject({ status: 'empty', messageKey: 'data.state.menu.no-menus', actionKey: 'data.management.action.addMenu' });
  expect(selectWidget(s.getSnapshot(), 'members', { kind: 'default' }, 'normal')).toMatchObject({ status: 'empty', messageKey: 'data.state.members.no-members', actionKey: 'data.management.action.addMember' });
});
it('재고와 납부를 해결하면 중요 알림이 줄고 지연 발주는 남는다', () => {
  const s = ordersScenario(true);
  ok(s.dispatch({ type: 'inventory.updateItem', itemId: 'i-bean-house', stock: 2000 }));
  expect(selectBriefing(s.getSnapshot(), day).importantAlerts.count).toBe(5);
  ok(s.dispatch({ type: 'suppliers.recordReceipt', polId: 'line:test-milk-delivery', qty: 12, idempotencyKey: '전량' }));
  expect(selectBriefing(s.getSnapshot(), day).importantAlerts.count).toBe(4);
  ok(s.dispatch({ type: 'inventory.updateItem', itemId: 'i-bean-house', stock: 6000 }));
  expect(selectBriefing(s.getSnapshot(), day).importantAlerts.count).toBe(3);
  ok(s.dispatch({ type: 'tax.markPaid', taxPaymentId: 'sample-tax-1' }));
  expect(selectBriefing(s.getSnapshot(), day).importantAlerts.count).toBe(2);
  expect(selectBriefing(s.getSnapshot(), day).importantAlerts.groups[0].items.map(item => item.id)).toEqual(['order:test-overdue']);
});
it('설정이 일반 undo의 쓰기 대상을 바꾸면 역변경은 0건이며 새 실행 token은 독립이다', () => {
  const a = createWidgetDataStore(undefined, { runId: '첫실행' });
  const created = ok(a.dispatch({ type: 'booking.create', guest: { name: '가짜예약' }, date: TODAY, time: '19:00', partySize: 2, tableChoice: 'auto', idempotencyKey: '추가' }));
  settings(a, baseLayout);
  const before = a.getSnapshot();
  expect(a.undo(created.undoToken!)).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
  expect(a.getSnapshot()).toBe(before);
  const b = createWidgetDataStore(undefined, { runId: '다음실행' });
  ok(b.dispatch({ type: 'members.setGrade', memberId: 'M-0001', grade: 'inactive' }));
  expect(b.undo(created.undoToken!)).toMatchObject({ ok: false, reason: 'UNDO_UNAVAILABLE' });
});

it('보관 회원의 회원권 사용 취소는 남은 횟수와 이력을 바꾸지 않는다', () => {
  const h = oneUseScenario(), s = h.data;
  const { useId } = value<{ useId: string }>(coveredUse(h,openingPassId,'사용'));
  ok(s.dispatch({ type: 'members.delete', memberId: passHolder }));
  const before = s.getSnapshot();
  expect(s.dispatch({ type: 'memberships.cancelUse', useId })).toMatchObject({ ok: false, code: 'CONFLICT' });
  expect(s.getSnapshot()).toBe(before);
});

// API-277 / PRD 12.6: uses require a real covered menu; the shared coordinator owns money.
function coveredUse(h:ReturnType<typeof setupMoney>,membershipId:string,key:string):DataCommandResult {
  h.pos.execute({type:'cart.clear',meta:h.meta()});
  const menu = h.pos.read().data.catalog.items.find(item => item.menuId === 'm-americano')!;
  const optionIds = menu.groups.filter(group => group.required).map(group => group.options[0].optionId);
  expect(h.pos.execute({ type: 'cart.add', menuId: menu.menuId, optionIds, meta: h.meta() })).toMatchObject({ ok: true });
  const pass=h.actions.money.read().state.memberships.find(m=>m.membershipId===membershipId)!;
  const billId=getPaymentBillId(h.pos.read());
  const member=h.pos.execute({type:'bill.member',billId,memberId:pass.memberId,meta:h.meta()});if(!member.ok)return member;
  const allocationId=quotePaymentBill(h.pos.read(),billId).lines[0].lineId;
  const begin=h.data.dispatch({type:'memberships.useOnce',membershipId,billId,allocationId,quantity:1,idempotencyKey:key});if(!begin.ok)return begin;
  const pending=h.actions.money.approval()!;
  const end=h.actions.money.finishApproval({runId:pending.runId,attemptId:pending.attemptId,outcome:'approved'});if(!end.ok)return end;h.actions.money.dismissApproval();
  const use=h.actions.money.read().state.uses.find(u=>u.sourceRef.id===billId&&!u.canceledAt)!;
  return {ok:true,revision:h.data.getSnapshot().revision,value:{useId:use.useId}};
}
