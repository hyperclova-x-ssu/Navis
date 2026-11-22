import { cafeMemberId } from '../../db/cafe-identity';
import { seedCatalog, seedSupplement } from '../../db/cafe-fixtures';
import type { CustomMoneyState, CustomOrder, CustomOrderTables, CustomTemplate, CustomTemplateField, PickupReservation } from './types';

export function exampleTemplate(templateId: string, name: string, keywords = ''): CustomTemplate {
  const fields: readonly CustomTemplateField[] = [
    { fieldId: 'message', label: '요청 문구', input: 'text', required: true, options: [] },
    { fieldId: 'size', label: '크기', input: 'single', required: true, options: [{ optionId: 'one', label: '기본', extraAmount: 0 }, { optionId: 'large', label: '크게', extraAmount: 5000 }] },
    { fieldId: 'extras', label: '추가 옵션', input: 'multiple', required: false, options: [{ optionId: 'candle', label: '초 추가', extraAmount: 1000 }, { optionId: 'ribbon', label: '리본 포장', extraAmount: 0 }] },
    { fieldId: 'eventAt', label: '행사 일시', input: 'datetime', required: false, options: [] },
  ];
  return { templateId, name: `${name}${keywords ? ` · ${keywords}` : ''}`, revision: 1, fields, archivedAt: null };
}
/** Only custom rows and the CO-001 advance; caller merges with existing visit/member/POS sources. */
export function createLegacyCustomOrderSeed(): { tables: CustomOrderTables; money: CustomMoneyState } {
  const cake = exampleTemplate('CT-CAKE', '주문제작 케이크 주문서');
  const gift = exampleTemplate('CT-GIFT', '단체 답례품 주문서');
  const make = (template: CustomTemplate, id: string): CustomOrder => ({
    customOrderId: id, templateId: template.templateId, templateRevision: 1, templateSnapshot: structuredClone(template),
    answers: { message: '감사해요', size: 'one', extras: ['ribbon'] }, productLabel: '답례 쿠키 세트 20박스', options: ['리본 포장'], quantity: 20,
    request: '', referencePhotoKeys: [], channel: 'phone', memberId: null, guest: { name: '한○○', phone: '010-****-8120' }, desiredPickupAt: '2026-10-27T14:00',
    proposedPickupAt: '2026-10-27T14:00', productionAt: null, quoteAmount: 60000, quoteRevision: 1, customerDecision: 'pending', approvedQuoteRevision: null,
    stage: 'approval_pending', paymentTiming: 'on_pickup', pickupReservationId: null, settlementId: null,
    history: [{ historyId: `${id}:history:1`, at: '2026-10-26T10:00', kind: 'quoted', stage: 'approval_pending', quoteRevision: 1, detail: '60000', referenceId: null }],
  });
  const first: CustomOrder = { ...make(cake, 'CO-001'), answers: { message: '생일 축하해요', size: 'one', extras: ['candle'] }, productLabel: '레터링 생크림 케이크 1호', options: ['초 추가'], quantity: 1,
    channel: 'message', memberId: 'M-0001', guest: null, desiredPickupAt: '2026-10-26T17:00', proposedPickupAt: '2026-10-26T17:00', quoteAmount: 45000,
    customerDecision: 'approved', approvedQuoteRevision: 1, stage: 'production_complete', paymentTiming: 'advance', pickupReservationId: 'PICKUP-CO-001', settlementId: 'CUSTOM-SETTLEMENT-CO-001',
    history: [
      { historyId: 'CO-001:history:1', at: '2026-10-26T09:00', kind: 'decision', stage: 'payment_pending', quoteRevision: 1, detail: 'approved', referenceId: 'PICKUP-CO-001' },
      { historyId: 'CO-001:history:2', at: '2026-10-26T09:30', kind: 'settled', stage: 'in_production', quoteRevision: 1, detail: '45000', referenceId: 'CUSTOM-SETTLEMENT-CO-001' },
      { historyId: 'CO-001:history:3', at: '2026-10-26T14:00', kind: 'stage', stage: 'production_complete', quoteRevision: 1, detail: 'production_complete', referenceId: null },
    ],
  };
  return { tables: { customTemplate: [cake, gift], customOrder: [first, make(gift, 'CO-002')], reservation: [{ kind: 'pickup', reservationId: 'PICKUP-CO-001', customOrderId: 'CO-001', date: '2026-10-26', time: '17:00', status: 'confirmed', updatedAt: '2026-10-26T09:00' }] },
    money: {
      settlements: [{ settlementId: 'CUSTOM-SETTLEMENT-CO-001', purpose: 'custom_order', sourceRef: { kind: 'custom_order', id: 'CO-001' }, billId: null, partId: null, memberId: 'M-0001', at: '2026-10-26T09:30', amount: 45000,
        allocations: [{ allocationId: 'CUSTOM-SETTLEMENT-CO-001:card', kind: 'method', method: 'card', amount: 45000 }], status: 'paid', paymentTiming: 'advance' }],
      payments: [{ paymentId: 'CUSTOM-PAYMENT-CO-001', settlementId: 'CUSTOM-SETTLEMENT-CO-001', purpose: 'custom_order', sourceRef: { kind: 'custom_order', id: 'CO-001' }, at: '2026-10-26T09:30', amount: 45000, splits: [{ method: 'card', amount: 45000 }] }],
      recognitions: [], corrections: [],
    } };
}

export function createCustomOrderSeed(): { tables: CustomOrderTables; money: CustomMoneyState } {
  const template = exampleTemplate('sample-group-order', `${seedCatalog.store.name} 단체 주문서`);
  const reservation: PickupReservation[] = [];
  const customOrder = seedSupplement.customOrders.map((row): CustomOrder => {
    const customOrderId = `CO-${row.id.slice('sample-custom-'.length).padStart(3, '0')}`;
    const pickupAt = `${row.pickupDate}T${row.pickupTime}`;
    const order: CustomOrder = {
      // Reuse the sample's stable order number in the same namespace as new orders.
      customOrderId, templateId: template.templateId, templateRevision: template.revision,
      templateSnapshot: template, answers: {}, productLabel: row.menuName, options: [], quantity: row.quantity,
      request: '', referencePhotoKeys: [], channel: 'message', memberId: cafeMemberId(row.memberId), guest: null,
      desiredPickupAt: pickupAt, proposedPickupAt: null, productionAt: null,
      quoteAmount: null, quoteRevision: 0, customerDecision: 'pending', approvedQuoteRevision: null,
      stage: row.stage, paymentTiming: 'on_pickup', pickupReservationId: null, settlementId: null, history: [],
    };
    // D-313 café example: approve the latte group order for payment at pickup.
    if (row.id !== 'sample-custom-1') return order;

    const reservationId = `PICKUP-${customOrderId}`;
    const at = row.receivedAt.slice(0, 16);
    reservation.push({ kind: 'pickup', reservationId, customOrderId, date: row.pickupDate, time: row.pickupTime, status: 'confirmed', updatedAt: at });
    return {
      ...order, proposedPickupAt: pickupAt, quoteAmount: row.quoteAmount, quoteRevision: 1,
      customerDecision: 'approved', approvedQuoteRevision: 1, stage: 'in_production', pickupReservationId: reservationId,
      history: [
        { historyId: `${customOrderId}:history:1`, at, kind: 'quoted', stage: 'approval_pending', quoteRevision: 1, detail: String(row.quoteAmount), referenceId: null },
        { historyId: `${customOrderId}:history:2`, at, kind: 'decision', stage: 'in_production', quoteRevision: 1, detail: 'approved', referenceId: reservationId },
      ],
    };
  });
  return { tables: { customTemplate: [template], customOrder, reservation }, money: { settlements: [], payments: [], recognitions: [], corrections: [] } };
}
