import type { PoolClient } from 'pg';

/** Install the synthetic PN02 cross-references to the matching PN16 and PN09 fixtures. */
export async function seedNaverOrderLinks(db: PoolClient, storeId: string, businessDate: string) {
  // PN16 places its first product order on the shared café business date.
  const smartstoreProductOrderId = businessDate.replaceAll('-', '') + '0001001';
  // PN09 uses merchant-order-02 for this approved payment and its settlement lines.
  const naverPayPaymentId = 'PN09SETTLED01';
  await db.query(`
    INSERT INTO pos.naver_order_link AS link (store_id, order_ref, naver_pay_payment_id, smartstore_product_order_id)
    VALUES ($1, 'order-01', NULL, $2), ($1, 'order-02', $3, NULL)
    ON CONFLICT (store_id, order_ref) DO UPDATE SET
      naver_pay_payment_id = EXCLUDED.naver_pay_payment_id,
      smartstore_product_order_id = EXCLUDED.smartstore_product_order_id
    WHERE link.payment_id IS NULL
      AND (link.naver_pay_payment_id, link.smartstore_product_order_id)
        IS DISTINCT FROM (EXCLUDED.naver_pay_payment_id, EXCLUDED.smartstore_product_order_id)
  `, [storeId, smartstoreProductOrderId, naverPayPaymentId]);
}
