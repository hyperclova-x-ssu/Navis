import { describe, expect, it } from 'vitest';
import {
  planCustomOrderCommand, selectCustomOrders, selectCustomCalendar,
  selectCustomAccounting, quoteCustomSettlement, planCustomSettlement, quoteCustomReversal,
  planCustomReversal, type CustomOrder, type CustomOrderRead, type CustomOrderCommand, type CustomPlanResult,
} from './index';

import { createCustomOrderSeed, exampleTemplate } from './seed';

function initial(): CustomOrderRead {
  const date = '2026-10-26', now = `${date}T15:45`;
  const cake = exampleTemplate('CT-CAKE', '주문제작 케이크 주문서');
  const gifts = exampleTemplate('CT-GIFT', '단체 답례품 주문서');
  const quoted: CustomOrder = {
    customOrderId: 'CO-002', templateId: gifts.templateId, templateRevision: 1, templateSnapshot: gifts,
    answers: { message: '감사해요', size: 'one' }, productLabel: '답례 쿠키 세트', options: [], quantity: 20,
    request: '', referencePhotoKeys: [], channel: 'phone', memberId: null, guest: { name: '한○○', phone: '010-****-8120' },
    desiredPickupAt: '2026-10-27T14:00', proposedPickupAt: '2026-10-27T14:00', productionAt: null,
    quoteAmount: 60000, quoteRevision: 1, customerDecision: 'pending', approvedQuoteRevision: null, stage: 'approval_pending',
    paymentTiming: 'on_pickup', pickupReservationId: null, settlementId: null, history: [],
  };
  const settlementId = 'CUSTOM-SETTLEMENT-CO-001';
  const paid: CustomOrder = {
    ...quoted, customOrderId: 'CO-001', templateId: cake.templateId, templateSnapshot: cake, productLabel: '레터링 케이크', quantity: 1,
    memberId: 'M-0001', guest: null, desiredPickupAt: `${date}T17:00`, proposedPickupAt: `${date}T17:00`, quoteAmount: 45000,
    customerDecision: 'approved', approvedQuoteRevision: 1, stage: 'production_complete', paymentTiming: 'advance',
    pickupReservationId: 'PICKUP-CO-001', settlementId,
  };
  const sourceRef = { kind: 'custom_order' as const, id: paid.customOrderId };
  const split = { method: 'card' as const, amount: 45000 };
  const paidAt = `${date}T09:30`;
  return {
    revision: 0, businessDate: date, now,
    tables: {
      customTemplate: [cake, gifts], customOrder: [paid, quoted], member: [{ memberId: 'M-0001' }],
      reservation: [{ kind: 'pickup', reservationId: 'PICKUP-CO-001', customOrderId: paid.customOrderId, date, time: '17:00', status: 'confirmed', updatedAt: paidAt }],
    },
    money: {
      settlements: [{ settlementId, sourceRef, purpose: 'custom_order', billId: null, partId: null, memberId: paid.memberId, at: paidAt, amount: split.amount,
        allocations: [{ ...split, allocationId: 'advance-card', kind: 'method' }], status: 'paid', paymentTiming: 'advance' }],
      payments: [{ paymentId: 'CUSTOM-PAYMENT-CO-001', settlementId, sourceRef, purpose: 'custom_order', at: paidAt, amount: split.amount, splits: [split] }],
      recognitions: [], corrections: [],
    },
  };
}
function apply(read: CustomOrderRead, plan: CustomPlanResult): CustomOrderRead {
  if (!plan.ok) throw new Error(`${plan.reason}: ${plan.field}`);
  return { ...read, revision: read.revision + Number(plan.changed), tables: plan.tables, money: {
    settlements: [...read.money.settlements, ...plan.moneyEffects.settlements],
    payments: [...read.money.payments, ...plan.moneyEffects.payments],
    recognitions: [...read.money.recognitions, ...plan.moneyEffects.recognitions],
    corrections: [...read.money.corrections, ...plan.moneyEffects.corrections],
  } };
}
const order = (read: CustomOrderRead, id = 'CO-002') => selectCustomOrders(read).orders.find(o => o.customOrderId === id)!;
const approve = (read: CustomOrderRead, paymentTiming: 'advance' | 'on_pickup' = 'on_pickup') => apply(read, planCustomOrderCommand(read, {
  type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: order(read).quoteRevision,
  decision: 'approved', paymentTiming, idempotencyKey: 'approve',
}));
function settle(read: CustomOrderRead, id = 'CO-002'): CustomOrderRead {
  const amount = order(read, id).quoteAmount!;
  const quote = quoteCustomSettlement(read, { customOrderId: id, allocations: [{ kind: 'method', method: 'cash', amount }] });
  return apply(read, planCustomSettlement(read, { quote, settlementId: `settle:${id}`, paymentId: `pay:${id}`, idempotencyKey: `pay:${id}` }));
}
const advance = (read: CustomOrderRead, nextStage: 'production_complete', id = 'CO-002') => apply(read, planCustomOrderCommand(read, {
  type: 'customOrder.setStage', customOrderId: id, nextStage, idempotencyKey: `stage:${id}`,
}));

describe('custom pickup source and event accounting (API-274/276 M2)', () => {
  it('starts with one paid unreceived pickup and one unapproved quote, with no custom sales', () => {
    const read = initial(), model = selectCustomOrders(read);
    expect(model.summary).toEqual({ inProgress: 2, approvalPending: 1, todayPickup: 1, tomorrowPickup: 0, todayNotComplete: 0 });
    expect(order(read, 'CO-001')).toMatchObject({ stage: 'production_complete', payment: { status: 'paid', amountSettled: 45000 }, confirmedPickupAt: '2026-10-26T17:00' });
    expect(order(read)).toMatchObject({ stage: 'approval_pending', pickup: null, payment: { status: 'unpaid' } });
    expect(selectCustomAccounting(read)).toMatchObject({ customPickup: 0, realDeposits: 45000, advanceDeposits: 45000, methodDeposits: { card: 45000, easy_pay: 0, cash: 0 } });
  });

  it('records revision requests, requotes 65000, and creates one pickup after latest approval', () => {
    let read = initial();
    read = apply(read, planCustomOrderCommand(read, { type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: 1, decision: 'revision_requested', paymentTiming: 'on_pickup', idempotencyKey: 'revise' }));
    expect(order(read)).toMatchObject({ stage: 'revision_requested', approvedQuoteRevision: null });
    read = apply(read, planCustomOrderCommand(read, { type: 'customOrder.quote', customOrderId: 'CO-002', quoteAmount: 65000, proposedPickupAt: '2026-10-27T14:00', idempotencyKey: 'quote' }));
    expect(planCustomOrderCommand(read, { type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: 1, decision: 'approved', paymentTiming: 'on_pickup', idempotencyKey: 'old' })).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
    read = approve(read);
    expect(order(read)).toMatchObject({ stage: 'in_production', approvedQuoteRevision: 2, pickup: { kind: 'pickup', status: 'confirmed', date: '2026-10-27', time: '14:00' } });
    expect(selectCustomOrders(read).summary.tomorrowPickup).toBe(1);
    const again = planCustomOrderCommand(read, { type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: 2, decision: 'approved', paymentTiming: 'on_pickup', idempotencyKey: 'approve-again' });
    expect(apply(read, again).tables.reservation.filter(r => r.kind === 'pickup' && r.customOrderId === 'CO-002')).toHaveLength(1);
  });

  it('never creates a pickup for a rejected quote', () => {
    const read = initial();
    const next = apply(read, planCustomOrderCommand(read, { type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: 1, decision: 'rejected', paymentTiming: 'on_pickup', idempotencyKey: 'reject' }));
    expect(order(next)).toMatchObject({ customerDecision: 'rejected', pickup: null });
    expect(selectCustomOrders(next).summary.approvalPending).toBe(0);
  });

  it('uses the reservation as the only confirmed date and preserves visit rows and unlimited simultaneous pickups', () => {
    let read = initial();
    const visit = { kind: 'visit' as const, reservationId: 'visit-T4', date: '2026-10-26', time: '14:30', status: 'confirmed', partySize: 3, tableId: 'T4', memo: '케이크 픽업' };
    read = { ...read, tables: { ...read.tables, reservation: [...read.tables.reservation, visit] } };
    read = approve(read);
    const pickupId = order(read, 'CO-001').pickup!.reservationId;
    read = apply(read, planCustomOrderCommand(read, { type: 'pickup.reschedule', reservationId: pickupId, date: '2026-10-27', time: '14:00', idempotencyKey: 'move' }));
    expect(order(read, 'CO-001').confirmedPickupAt).toBe('2026-10-27T14:00');
    expect(read.tables.reservation.find(r => r.reservationId === 'visit-T4')).toEqual(visit);
    expect(read.tables.reservation.filter(r => r.kind === 'pickup')).toHaveLength(2);
    expect(order(read, 'CO-001').pickup).not.toHaveProperty('tableId');
    expect(order(read, 'CO-001').pickup).not.toHaveProperty('partySize');
    expect(planCustomOrderCommand(read, { type: 'pickup.reschedule', reservationId: 'visit-T4', date: '2026-10-27', time: '14:00', idempotencyKey: 'bad' })).toMatchObject({ ok: false, reason: 'PICKUP_HAS_NO_TABLE' });
  });

  it('cancels both unpaid states and removes only active projections, preserving history', () => {
    let read = approve(initial());
    const id = order(read).pickup!.reservationId;
    read = apply(read, planCustomOrderCommand(read, { type: 'pickup.cancel', reservationId: id, idempotencyKey: 'cancel' }));
    expect(order(read)).toMatchObject({ stage: 'canceled', pickup: { status: 'canceled' } });
    expect(order(read).history.at(-1)).toMatchObject({ kind: 'canceled' });
    expect(selectCustomCalendar(read).some(e => e.customOrderId === 'CO-002')).toBe(false);
    expect(selectCustomOrders(read).summary.tomorrowPickup).toBe(0);
  });

  it('recognizes CO-001 exactly once at receive with unknown cost and no second deposit', () => {
    const read = initial(), before = JSON.stringify(read);
    const command: CustomOrderCommand = { type: 'customOrder.receive', customOrderId: 'CO-001', idempotencyKey: 'receive' };
    const result = planCustomOrderCommand(read, command), next = apply(read, result);
    expect(JSON.stringify(read)).toBe(before);
    expect(order(next, 'CO-001')).toMatchObject({ stage: 'received_by_customer', pickup: { status: 'completed' } });
    expect(selectCustomAccounting(next)).toMatchObject({ customPickup: 45000, realDeposits: 45000, rows: [{ customOrderId: 'CO-001', amount: 45000, cost: null }] });
    expect(result.ok && result.moneyEffects.payments).toHaveLength(0);
    expect(result.ok && result.moneyEffects.recognitions).toHaveLength(1);
    const duplicate = planCustomOrderCommand(next, command);
    expect(duplicate).toMatchObject({ ok: true, changed: false, moneyEffects: { recognitions: [] } });
    expect(planCustomOrderCommand(next, { ...command, idempotencyKey: 'another-receive' })).toMatchObject({ ok: true, changed: false });
  });

  it('gates advance production on payment and on-pickup receive on complete settlement', () => {
    let read = approve(initial(), 'advance');
    expect(order(read).stage).toBe('payment_pending');
    expect(planCustomOrderCommand(read, { type: 'customOrder.setStage', customOrderId: 'CO-002', nextStage: 'in_production', idempotencyKey: 'start' })).toMatchObject({ ok: false, reason: 'PAYMENT_REQUIRED' });
    read = settle(read);
    expect(order(read).stage).toBe('in_production');
    expect(selectCustomAccounting(read)).toMatchObject({ customPickup: 0, realDeposits: 105000 });
    read = advance(read, 'production_complete');
    read = apply(read, planCustomOrderCommand(read, { type: 'customOrder.receive', customOrderId: 'CO-002', idempotencyKey: 'receive' }));
    expect(selectCustomAccounting(read)).toMatchObject({ customPickup: 60000, realDeposits: 105000 });
    const unpaid = advance(approve(initial()), 'production_complete');
    expect(planCustomOrderCommand(unpaid, { type: 'customOrder.receive', customOrderId: 'CO-002', idempotencyKey: 'receive' })).toMatchObject({ ok: false, reason: 'PAYMENT_REQUIRED' });
  });

  it('quotes mixed real methods, pins revisions, and rejects tampered or duplicate money approvals', () => {
    const read = approve(initial());
    const quote = quoteCustomSettlement(read, { customOrderId: 'CO-002', allocations: [{ kind: 'method', method: 'card', amount: 30000 }, { kind: 'method', method: 'card', amount: 10000 }, { kind: 'method', method: 'cash', amount: 20000 }] });
    expect(quote).toMatchObject({ amountDue: 60000, remaining: 0, canSubmit: true, realMethodSplits: [{ method: 'card', amount: 40000 }, { method: 'cash', amount: 20000 }] });
    const input = { quote, settlementId: 'new-settle', paymentId: 'new-pay', idempotencyKey: 'approval' };
    expect(planCustomSettlement({ ...read, revision: read.revision + 1 }, input)).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
    expect(planCustomSettlement(read, { ...input, quote: { ...quote, amountDue: 1 } })).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
    const next = apply(read, planCustomSettlement(read, input));
    expect(order(next).payment).toMatchObject({ status: 'paid', realDeposits: 60000 });
    expect(planCustomSettlement(next, input)).toMatchObject({ ok: true, changed: false });
    expect(planCustomSettlement(next, { ...input, paymentId: 'other-pay' })).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_MISMATCH' });
    expect(planCustomSettlement(next, { ...input, idempotencyKey: 'different-key' })).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
  });

  it('requires common confirmed reversal for paid cancellation and retains original money/history', () => {
    const read = initial();
    const command: CustomOrderCommand = { type: 'pickup.cancel', reservationId: order(read, 'CO-001').pickup!.reservationId, idempotencyKey: 'unsafe', confirmedCorrectionQuoteId: 'invented' };
    expect(planCustomOrderCommand(read, command)).toMatchObject({ ok: false, reason: 'PAYMENT_REVERSAL_REQUIRED' });
    const quote = quoteCustomReversal(read, { customOrderId: 'CO-001', kind: 'cancellation' });
    const next = apply(read, planCustomReversal(read, { quote, idempotencyKey: 'reverse', cancelOrder: true }));
    expect(order(next, 'CO-001')).toMatchObject({ stage: 'canceled', payment: { status: 'canceled', amountSettled: 45000, amountReturned: 45000 } });
    expect(next.money.payments).toEqual(read.money.payments);
    expect(next.money.corrections).toHaveLength(1);
    expect(selectCustomAccounting(next)).toMatchObject({ customPickup: 0, realDeposits: 0 });
    expect(planCustomReversal(next, { quote, idempotencyKey: 'reverse', cancelOrder: true })).toMatchObject({ ok: true, changed: false });
  });

  it('refunds received sales only in proportion to original real-method returns and prevents over-refunds', () => {
    let read = apply(initial(), planCustomOrderCommand(initial(), { type: 'customOrder.receive', customOrderId: 'CO-001', idempotencyKey: 'receive' }));
    const quote = quoteCustomReversal(read, { customOrderId: 'CO-001', kind: 'refund', amount: 15000 });
    read = apply(read, planCustomReversal(read, { quote, idempotencyKey: 'partial' }));
    expect(selectCustomAccounting(read)).toMatchObject({ customPickup: 30000, realDeposits: 30000, refund: 15000 });
    expect(order(read, 'CO-001')).toMatchObject({ stage: 'received_by_customer', payment: { status: 'refunded', amountReturned: 15000 } });
    expect(quoteCustomReversal(read, { customOrderId: 'CO-001', kind: 'refund', amount: 30001 })).toMatchObject({ canSubmit: false, issues: [{ reason: 'REFUND_LIMIT' }] });
    expect(quoteCustomReversal(read, { customOrderId: 'CO-001', kind: 'cancellation' })).toMatchObject({ canSubmit: false, issues: [{ reason: 'INVALID_STAGE_TRANSITION' }] });
  });

  it('allocates repeated partial returns against unreturned original methods without creating pre-handover sales', () => {
    let read = approve(initial());
    const payment = quoteCustomSettlement(read, { customOrderId: 'CO-002', allocations: [
      { kind: 'method', method: 'card', amount: 40001 }, { kind: 'method', method: 'cash', amount: 19999 },
    ] });
    read = apply(read, planCustomSettlement(read, { quote: payment, settlementId: 'mixed', paymentId: 'mixed-pay', idempotencyKey: 'mixed' }));
    const quote = quoteCustomReversal(read, { customOrderId: 'CO-002', kind: 'refund', amount: 1 });
    expect(quote.realMethodReturns).toEqual([{ method: 'card', amount: 1 }]);
    expect(planCustomReversal(read, { quote: { ...quote, amount: 2 }, idempotencyKey: 'tampered' })).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
    read = apply(read, planCustomReversal(read, { quote, idempotencyKey: 'one' }));
    expect(planCustomReversal(read, { quote, idempotencyKey: 'stale' })).toMatchObject({ ok: false, reason: 'QUOTE_CHANGED' });
    const remaining = quoteCustomReversal(read, { customOrderId: 'CO-002', kind: 'refund' });
    expect(remaining.realMethodReturns).toEqual([{ method: 'card', amount: 40000 }, { method: 'cash', amount: 19999 }]);
    read = apply(read, planCustomReversal(read, { quote: remaining, idempotencyKey: 'rest', cancelOrder: true }));
    expect(selectCustomAccounting(read)).toMatchObject({ customPickup: 0, realDeposits: 45000, methodDeposits: { card: 45000, easy_pay: 0, cash: 0 } });
    expect(read.money.recognitions).toHaveLength(0);
    expect(order(read)).toMatchObject({ stage: 'canceled', pickup: { status: 'canceled' } });
  });

  it('derives date-specific money independently of pickup date and emits read-only internal work events', () => {
    let read = initial();
    read = apply(read, planCustomOrderCommand(read, { type: 'customOrder.quote', customOrderId: 'CO-002', quoteAmount: 60000, proposedPickupAt: '2026-10-27T14:00', productionAt: '2026-10-26T16:00', idempotencyKey: 'work' }));
    read = approve(read);
    expect(selectCustomCalendar(read).filter(e => e.customOrderId === 'CO-002')).toMatchObject([
      { source: 'pickup', category: 'store-operations', readonly: true, kind: 'pickup' },
      { source: 'pickup', category: 'store-operations', readonly: true, kind: 'production' },
    ]);
    expect(selectCustomAccounting(read, { date: '2026-10-27' })).toMatchObject({ customPickup: 0, realDeposits: 0 });
  });

  it('clears an optional internal production date when the revised quote explicitly supplies null', () => {
    let read = initial();
    read = apply(read, planCustomOrderCommand(read, { type: 'customOrder.quote', customOrderId: 'CO-002', quoteAmount: 60000, proposedPickupAt: '2026-10-27T14:00', productionAt: '2026-10-26T16:00', idempotencyKey: 'work' }));
    read = apply(read, planCustomOrderCommand(read, { type: 'customOrder.quote', customOrderId: 'CO-002', quoteAmount: 60000, proposedPickupAt: '2026-10-27T14:00', productionAt: null, idempotencyKey: 'clear-work' }));
    expect(order(read).productionAt).toBeNull();
  });
});

describe('receipt/template validation and replay guards', () => {
  const receipt = { type: 'customOrder.create' as const, templateId: 'CT-CAKE', answers: { message: '감사해요', size: 'one', extras: ['candle'] }, channel: 'visit' as const, productLabel: '케이크', options: ['초 추가'], quantity: 1, request: '', referencePhotoKeys: [], desiredPickupAt: '2026-10-28T12:30', guest: { name: '손님', phone: '010-1234-5678' }, idempotencyKey: 'receipt' };
  it('requires template answers and receipt fields without changing inputs or fabricating a pickup', () => {
    const read = initial(), frozen = JSON.stringify(read);
    for (const patch of [{ answers: { message: '', size: 'one' } }, { answers: { message: 'a', size: 'unknown' } }, { quantity: 0 }, { guest: { name: '', phone: '' } }, { desiredPickupAt: '2026-02-30T12:30' }, { memberId: 'missing' }]) {
      expect(planCustomOrderCommand(read, { ...receipt, ...patch } as CustomOrderCommand)).toMatchObject({ ok: false });
    }
    const next = apply(read, planCustomOrderCommand(read, receipt));
    expect(next.tables.customOrder.at(-1)).toMatchObject({ stage: 'received', pickupReservationId: null, templateRevision: 1 });
    expect(JSON.stringify(read)).toBe(frozen);
    expect(planCustomOrderCommand(next, receipt)).toMatchObject({ ok: true, changed: false });
    expect(planCustomOrderCommand(next, { ...receipt, quantity: 2 })).toMatchObject({ ok: false, reason: 'IDEMPOTENCY_MISMATCH' });
  });

  it('refuses new past pickups and keeps a historical pickup editable when its time is unchanged', () => {
    const read = initial();
    const past = '2026-10-26T15:30';
    const rejected = (field: string) => ({ ok: false, code: 'VALIDATION', reason: 'BOOKING_PAST', field, messageKey: 'data.custom.error.BOOKING_PAST' });
    expect(planCustomOrderCommand(read, { ...receipt, desiredPickupAt: past })).toMatchObject(rejected('desiredPickupAt'));
    expect(planCustomOrderCommand(read, { ...receipt, desiredPickupAt: read.now! }).ok).toBe(true);
    expect(planCustomOrderCommand(read, { type: 'customOrder.update', customOrderId: 'CO-002', expectedQuoteRevision: 1, desiredPickupAt: past })).toMatchObject(rejected('desiredPickupAt'));
    expect(planCustomOrderCommand(read, { type: 'customOrder.quote', customOrderId: 'CO-002', quoteAmount: 60000, proposedPickupAt: past, idempotencyKey: 'past-quote' })).toMatchObject(rejected('proposedPickupAt'));
    expect(planCustomOrderCommand(read, { type: 'pickup.reschedule', reservationId: 'PICKUP-CO-001', date: '2026-10-26', time: '15:30', idempotencyKey: 'past-pickup' })).toMatchObject(rejected('time'));

    const historical = { ...read, now: '2026-10-28T15:45' };
    expect(planCustomOrderCommand(historical, { type: 'customOrder.update', customOrderId: 'CO-002', expectedQuoteRevision: 1, request: '포장', desiredPickupAt: order(read).desiredPickupAt }).ok).toBe(true);
    expect(planCustomOrderCommand(historical, { type: 'customOrder.quote', customOrderId: 'CO-002', quoteAmount: 62000, proposedPickupAt: order(read).proposedPickupAt!, idempotencyKey: 'unchanged-quote' }).ok).toBe(true);
    expect(planCustomOrderCommand(historical, { type: 'customOrder.recordDecision', customOrderId: 'CO-002', quoteRevision: 1, decision: 'approved', paymentTiming: 'on_pickup', idempotencyKey: 'expired-quote' })).toMatchObject(rejected('proposedPickupAt'));
  });

  it('gives seeded orders stable public numbers and assigns the next number to a new order', () => {
    const read = initial();
    const { tables, money } = createCustomOrderSeed();
    expect(tables.customOrder.map(row => row.customOrderId)).toEqual(['CO-001', 'CO-002']);
    expect(JSON.stringify(tables.customOrder)).not.toContain('sample-custom-');
    const cafe = { ...read, tables, money };
    const result = planCustomOrderCommand(cafe, { ...receipt, templateId: tables.customTemplate[0].templateId });
    expect(result).toMatchObject({ ok: true, value: { customOrderId: 'CO-003' } });
  });

  it('preserves selected template/answer snapshots after editing, deletion, and caller mutation', () => {
    let read = initial();
    const input = structuredClone(receipt);
    read = apply(read, planCustomOrderCommand(read, input));
    const created = read.tables.customOrder.at(-1)!;
    input.answers.extras.push('later');
    expect(created.answers.extras).toEqual(['candle']);
    read = apply(read, planCustomOrderCommand(read, { type: 'customTemplate.save', templateId: 'CT-CAKE', name: '수정 주문서', fields: [{ fieldId: 'new', label: '새 항목', input: 'text', required: true, options: [] }] }));
    read = apply(read, planCustomOrderCommand(read, { type: 'customTemplate.delete', templateId: 'CT-CAKE', idempotencyKey: 'delete' }));
    expect(read.tables.customOrder.find(o => o.customOrderId === created.customOrderId)?.templateSnapshot.name).toBe('주문제작 케이크 주문서');
    expect(read.tables.customTemplate.some(t => t.templateId === 'CT-CAKE')).toBe(false);
  });

  it('generates an editable deterministic example with all four input kinds and replays without another template', () => {
    const read = initial(), command: CustomOrderCommand = { type: 'customTemplate.generate', productKind: '케이크', keywords: '생일', idempotencyKey: 'generate' };
    const result = planCustomOrderCommand(read, command), next = apply(read, result);
    expect(new Set(next.tables.customTemplate.at(-1)!.fields.map(f => f.input))).toEqual(new Set(['text', 'single', 'multiple', 'datetime']));
    expect(planCustomOrderCommand(next, command)).toMatchObject({ ok: true, changed: false });
  });

  it('validates template uniqueness, option money and datetime/multiple required answers', () => {
    const read = initial();
    for (const fields of [
      [{ fieldId: 'x', label: '', input: 'text', required: true, options: [] }],
      [{ fieldId: 'x', label: 'X', input: 'single', required: true, options: [{ optionId: 'o', label: 'O', extraAmount: -1 }] }],
      [{ fieldId: 'x', label: 'X', input: 'text', required: false, options: [] }, { fieldId: 'x', label: 'Y', input: 'text', required: false, options: [] }],
    ]) expect(planCustomOrderCommand(read, { type: 'customTemplate.save', name: 'Test', fields, idempotencyKey: 'bad' } as CustomOrderCommand)).toMatchObject({ ok: false, reason: 'REQUIRED_FIELD' });
    const next = apply(read, planCustomOrderCommand(read, { type: 'customTemplate.save', templateId: 'CT-CAKE', name: 'Required extras', fields: [
      { fieldId: 'choices', label: '선택', input: 'multiple', required: true, options: [{ optionId: 'a', label: 'A', extraAmount: 0 }] },
      { fieldId: 'when', label: '일시', input: 'datetime', required: true, options: [] },
    ] }));
    for (const answers of [{ choices: [], when: '2026-10-27T11:00' }, { choices: ['a', 'a'], when: '2026-10-27T11:00' }, { choices: ['a'], when: '2026-10-27T25:00' }]) {
      expect(planCustomOrderCommand(next, { ...receipt, answers })).toMatchObject({ ok: false, reason: 'REQUIRED_FIELD' });
    }
    expect(planCustomOrderCommand(next, { ...receipt, answers: { choices: ['a'], when: '2026-10-27T11:00' } })).toMatchObject({ ok: true });
  });

  it.each([
    ['zero quote', { type: 'customOrder.quote', customOrderId: 'CO-002', quoteAmount: 0, proposedPickupAt: '2026-10-27T14:00', idempotencyKey: 'a' }, 'INVALID_QUOTE_AMOUNT'],
    ['unapproved production', { type: 'customOrder.setStage', customOrderId: 'CO-002', nextStage: 'in_production', idempotencyKey: 'a' }, 'APPROVAL_REQUIRED'],
    ['skip to received', { type: 'customOrder.setStage', customOrderId: 'CO-001', nextStage: 'received_by_customer', idempotencyKey: 'a' }, 'INVALID_STAGE_TRANSITION'],
    ['pickup boundary', { type: 'pickup.reschedule', reservationId: 'PICKUP-CO-001', date: '2026-10-27', time: '14:15', idempotencyKey: 'a' }, 'REQUIRED_FIELD'],
    ['stale revision', { type: 'customOrder.receive', customOrderId: 'CO-001', baseRevision: 99, idempotencyKey: 'a' }, 'STALE_REVISION'],
    ['missing key', { type: 'customOrder.receive', customOrderId: 'CO-001', idempotencyKey: '' }, 'REQUIRED_FIELD'],
  ])('rejects %s with zero writes', (_name, command, reason) => {
    const read = initial(), before = JSON.stringify(read);
    expect(planCustomOrderCommand(read, command as CustomOrderCommand)).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(read)).toBe(before);
  });

  it('invalidates approval and active projections when a receipt changes, but protects paid price snapshots', () => {
    const read = approve(initial());
    const next = apply(read, planCustomOrderCommand(read, { type: 'customOrder.update', customOrderId: 'CO-002', expectedQuoteRevision: 1, quantity: 21 }));
    expect(order(next)).toMatchObject({ approvedQuoteRevision: null, customerDecision: 'pending', stage: 'quote_pending', pickup: { status: 'canceled' } });
    expect(selectCustomOrders(next).summary.tomorrowPickup).toBe(0);
    expect(planCustomOrderCommand(initial(), { type: 'customOrder.update', customOrderId: 'CO-001', expectedQuoteRevision: 1, quantity: 2 })).toMatchObject({ ok: false, reason: 'PAYMENT_REVERSAL_REQUIRED' });
  });

  it('blocks unapproved, non-real-method, overpaid and unsafe-number settlement quotes', () => {
    expect(quoteCustomSettlement(initial(), { customOrderId: 'CO-002', allocations: [] })).toMatchObject({ canSubmit: false, issues: [{ reason: 'APPROVAL_REQUIRED' }] });
    const read = approve(initial());
    for (const allocations of [[{ kind: 'charge', amount: 60000 }], [{ kind: 'method', method: 'cash', amount: 60001 }], [{ kind: 'method', method: 'cash', amount: Number.MAX_SAFE_INTEGER + 1 }]]) {
      expect(quoteCustomSettlement(read, { customOrderId: 'CO-002', allocations } as Parameters<typeof quoteCustomSettlement>[1]).canSubmit).toBe(false);
    }
  });
});
