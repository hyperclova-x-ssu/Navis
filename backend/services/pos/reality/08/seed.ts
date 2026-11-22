import type { PoolClient } from 'pg';
import { seedCatalog } from '../../../../../frontend/src/data/db/generated/catalog.ts';
import { seedSupplement } from '../../../../../frontend/src/data/db/generated/supplement.ts';
import type { CustomReceipt, CustomTemplate, PickupReservation } from '../../../../../frontend/src/data/iteration7/custom-orders/types.ts';
import type { SeedContext } from '../../../../packages/db/seed-context.ts';
import { insertSeedRows, seedId, shiftSeedDate } from '../../../../packages/db/seed-history.ts';
import { requestFingerprint } from './records.ts';

const template: CustomTemplate = {
  templateId: seedId('sample-group-order'), name: seedCatalog.store.name + ' 단체 주문서', revision: 1, archivedAt: null,
  fields: [
    { fieldId: 'message', label: '요청 문구', input: 'text', required: false, options: [] },
    { fieldId: 'size', label: '크기', input: 'single', required: false, options: [
      { optionId: 'one', label: '기본', extraAmount: 0 }, { optionId: 'large', label: '크게', extraAmount: 5000 },
    ] },
    { fieldId: 'extras', label: '추가 옵션', input: 'multiple', required: false, options: [
      { optionId: 'candle', label: '초 추가', extraAmount: 1000 }, { optionId: 'ribbon', label: '리본 포장', extraAmount: 0 },
    ] },
    { fieldId: 'eventAt', label: '행사 일시', input: 'datetime', required: false, options: [] },
  ],
};

export function customOrderExamples({ cutoff, businessDate }: SeedContext) {
  const offset = (Date.parse(businessDate) - Date.parse('2026-11-17')) / 86_400_000;
  return seedSupplement.customOrders.map(sample => {
    const id = seedId(sample.id);
    const date = shiftSeedDate(sample.pickupDate, offset);
    const time = sample.pickupTime;
    const pickup: PickupReservation | null = sample.stage === 'quote_pending' ? {
      kind: 'pickup', customOrderId: id, reservationId: seedId('pickup:' + sample.id), date, time,
      status: 'confirmed', updatedAt: cutoff,
    } : null;
    return { id, sample, pickup, desiredPickupAt: `${date}T${time}` };
  });
}

export async function seedCustomOrders(db: PoolClient, storeId: string, context: SeedContext) {
  await insertSeedRows(db, 'pos.custom_template', 'store_id, template_id, name, fields, revision', [
    { store_id: storeId, template_id: template.templateId, name: template.name, fields: template.fields, revision: 1 },
  ]);
  for (const { id, sample, pickup, desiredPickupAt } of customOrderExamples(context)) {
    const receipt: CustomReceipt = {
      answers: {}, productLabel: sample.menuName, options: [], quantity: sample.quantity,
      request: '', referencePhotoKeys: [], channel: 'message', memberId: sample.memberId, guest: null, desiredPickupAt,
    };
    const status = pickup ? 'in_production' : 'received';
    const result = await db.query(`
      INSERT INTO pos.custom_order (store_id, custom_order_id, order_no, template_id, template_snapshot, receipt,
        request_fingerprint, desired_pickup_at, proposed_pickup_at, stage, customer_decision, payment_timing,
        quote_amount, quote_revision, approved_quote_revision, revision)
      SELECT $1, $2, coalesce(max(order_no), 0) + 1, $3, $4, $5, $6, $7::timestamp,
        CASE WHEN $8::boolean THEN $7::timestamp END, $9, $10, 'on_pickup', $11, $12, $13, $14
      FROM pos.custom_order WHERE store_id = $1
      ON CONFLICT DO NOTHING
    `, [storeId, id, template.templateId, template, receipt, requestFingerprint(template.templateId, receipt), desiredPickupAt,
      !!pickup, status, pickup ? 'approved' : 'pending', pickup ? sample.quoteAmount : null, pickup ? 1 : 0,
      pickup ? 1 : null, pickup ? 2 : 1]);
    if (!result.rowCount) continue;
    const history = pickup ? [
      { kind: 'quoted', detail: String(sample.quoteAmount), stage: 'approval_pending', referenceId: null },
      { kind: 'decision', detail: 'approved', stage: status, referenceId: pickup.reservationId },
    ] : [{ kind: 'created', detail: 'received', stage: status, referenceId: null }];
    await insertSeedRows(db, 'pos.custom_order_history', 'store_id, custom_order_id, order_revision, record',
      history.map((entry, index) => ({ store_id: storeId, custom_order_id: id, order_revision: index + 1,
        record: { ...entry, historyId: seedId(`${id}:history:${index}`), at: context.cutoff, quoteRevision: pickup ? 1 : 0 } })));
    if (pickup) await insertSeedRows(db, 'pos.custom_pickup', 'store_id, custom_order_id, reservation_id, scheduled_at, status, updated_at',
      [{ store_id: storeId, custom_order_id: id, reservation_id: pickup.reservationId, scheduled_at: desiredPickupAt,
        status: pickup.status, updated_at: pickup.updatedAt }]);
  }
}
