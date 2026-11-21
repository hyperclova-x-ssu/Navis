import { describe, expect, it } from 'vitest';
import { planCustomOrderCommand, type CustomOrderCommand, type CustomOrderRead, type CustomPlanResult } from '../iteration7/custom-orders';
import { createLegacyCustomOrderSeed } from '../iteration7/custom-orders/seed';
import { dataBundles } from '../messages';
import { createTranslator } from '../../i18n';

const now = '2026-10-26T15:45';
const receipt = {
  type: 'customOrder.create', templateId: 'CT-CAKE', answers: { message: '생일 축하해요', size: 'one' },
  channel: 'phone', productLabel: '생크림 케이크', quantity: 1, desiredPickupAt: '2026-10-27T16:00',
  guest: { name: '이서연', phone: '010-4321-8765' }, idempotencyKey: 'first',
} as const satisfies CustomOrderCommand;

function readFixture(): CustomOrderRead {
  return { ...createLegacyCustomOrderSeed(), revision: 0, now, businessDate: now.slice(0, 10) };
}

function apply(read: CustomOrderRead, plan: CustomPlanResult): CustomOrderRead {
  if (!plan.ok) throw new Error(plan.reason);
  return { ...read, revision: read.revision + 1, tables: plan.tables };
}

describe('N13 custom order guards', () => {
  it('replays the original key and rejects a separate copy of the same receipt', () => {
    const initial = readFixture();
    const read = apply(initial, planCustomOrderCommand(initial, receipt));
    expect(planCustomOrderCommand(read, receipt)).toMatchObject({ ok: true, changed: false });
    expect(planCustomOrderCommand(read, {
      ...receipt, guest: { name: '이 서연', phone: '+82 10 4321 8765' }, productLabel: '생크림케이크',
      idempotencyKey: 'duplicate',
    })).toMatchObject({ ok: false, code: 'CONFLICT', reason: 'DUPLICATE_CUSTOM_ORDER', details: { customOrderId: 'CO-003' } });
    expect(planCustomOrderCommand(read, {
      ...receipt, desiredPickupAt: '2026-10-28T16:00', idempotencyKey: 'repeat-tomorrow',
    })).toMatchObject({ ok: true, changed: true });
    expect(planCustomOrderCommand(read, {
      ...receipt, answers: { ...receipt.answers, message: '다른 문구' }, idempotencyKey: 'different-cake',
    })).toMatchObject({ ok: true, changed: true });
  });

  it('rechecks an edited receipt against other active orders and preserves metadata edits', () => {
    const original = readFixture();
    const one = apply(original, planCustomOrderCommand(original, receipt));
    const two = apply(one, planCustomOrderCommand(one, {
      ...receipt, desiredPickupAt: '2026-10-28T16:00', idempotencyKey: 'second',
    }));
    const edit = { type: 'customOrder.update', customOrderId: 'CO-004', expectedQuoteRevision: 0 } as const;
    expect(planCustomOrderCommand(two, { ...edit, desiredPickupAt: receipt.desiredPickupAt })).toMatchObject({
      ok: false, code: 'CONFLICT', reason: 'DUPLICATE_CUSTOM_ORDER', details: { customOrderId: 'CO-003' },
    });
    expect(planCustomOrderCommand(two, { ...edit, request: '포장해 주세요' })).toMatchObject({ ok: true, changed: true });
  });

  it('demands a fresh quote after a material edit or a customer revision request', () => {
    const initial = readFixture();
    const approval = { type: 'customOrder.recordDecision', customOrderId: 'CO-002', decision: 'approved',
      quoteRevision: 1, paymentTiming: 'on_pickup', idempotencyKey: 'approval' } as const;
    const edited = apply(initial, planCustomOrderCommand(initial, {
      type: 'customOrder.update', customOrderId: 'CO-002', expectedQuoteRevision: 1, quantity: 21,
    }));
    expect(planCustomOrderCommand(edited, { ...approval, quoteRevision: 2 })).toMatchObject({
      ok: false, reason: 'QUOTE_REISSUE_REQUIRED',
    });
    const requested = apply(initial, planCustomOrderCommand(initial, { ...approval, decision: 'revision_requested', idempotencyKey: 'revision' }));
    expect(planCustomOrderCommand(requested, approval)).toMatchObject({ ok: false, reason: 'QUOTE_REISSUE_REQUIRED' });
    const quoted = apply(edited, planCustomOrderCommand(edited, {
      type: 'customOrder.quote', customOrderId: 'CO-002', quoteAmount: 65000, proposedPickupAt: '2026-10-27T14:00', idempotencyKey: 'requote',
    }));
    expect(planCustomOrderCommand(quoted, { ...approval, quoteRevision: 3 })).toMatchObject({
      ok: true, value: { pickupReservationId: 'PICKUP-CO-002' },
    });
  });

  it('protects a conflicting visit and refuses multiple pickup rows linked to one order', () => {
    const initial = readFixture();
    const pickup = initial.tables.reservation[0];
    const visit = { kind: 'visit', reservationId: pickup.reservationId, date: pickup.date, time: pickup.time, status: 'confirmed' } as const;
    const collision = { ...initial, tables: { ...initial.tables, reservation: [pickup, visit] } };
    expect(planCustomOrderCommand(collision, { type: 'pickup.reschedule', reservationId: pickup.reservationId,
      date: pickup.date, time: '18:00', idempotencyKey: 'reschedule' })).toMatchObject({ ok: false, code: 'CONFLICT', field: 'reservationId' });
    expect(planCustomOrderCommand(collision, { type: 'customOrder.receive', customOrderId: 'CO-001',
      idempotencyKey: 'receive' })).toMatchObject({ ok: false, code: 'CONFLICT', field: 'reservationId' });

    if (pickup.kind !== 'pickup') throw new Error('Expected a pickup fixture');
    const duplicate = { ...initial, tables: { ...initial.tables, reservation: [pickup, { ...pickup, reservationId: 'a-second-pickup' }] } };
    expect(planCustomOrderCommand(duplicate, { type: 'pickup.cancel', reservationId: pickup.reservationId,
      idempotencyKey: 'cancel' })).toMatchObject({ ok: false, code: 'CONFLICT', field: 'reservationId' });
  });

  it('localizes both direct guard errors', () => {
    const translators = (['ko', 'en', 'zh-Hans', 'zh-Hant'] as const).map(locale => createTranslator<string>(locale, ...dataBundles));
    expect(translators.map(tr => tr.t('data.custom.error.DUPLICATE_CUSTOM_ORDER')))
      .toEqual(['같은 주문이 이미 있어요', 'This order already exists', '已存在相同订单', '已有相同訂單']);
    expect(translators.map(tr => tr.t('data.custom.error.QUOTE_REISSUE_REQUIRED')))
      .toEqual(['견적을 다시 내 주세요', 'Issue a new quote', '请重新报价', '請重新報價']);
  });
});
