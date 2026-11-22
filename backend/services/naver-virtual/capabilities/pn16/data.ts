import type { PoolClient } from 'pg'
import type { CommerceSellerOrder, CommerceStockReceipt } from '../../../../packages/naver/contracts/pn16/index.ts'
import type { PersonaSeedContext } from '../../seed.ts'

export const sellerId = 'ansungjalbu-smartstore'
export const houseBlendProductNo = 10001
export const houseBlendChannelNo = 20001
export const houseBlendOptionNo = 100001
export const houseBlendSellerCode = 'HOUSE-BLEND'

const objects = 'pn16_object'
const products = 'pn16_product'
const orders = 'pn16_product_order'
const tokens = 'pn16_commerce_token'
const rls = [objects, products, orders, tokens].map((table) => `
  ALTER TABLE naver_virtual.${table} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE naver_virtual.${table} FORCE ROW LEVEL SECURITY;
  CREATE POLICY pn16_scope ON naver_virtual.${table} TO nvirtual_run, nvirtual_mig
    USING (account_id = (SELECT current_setting('app.persona_account_id', true)))
    WITH CHECK (account_id = (SELECT current_setting('app.persona_account_id', true)));
`).join('')

export const migration = {
  id: '001_storage_and_commerce',
  up: `
    CREATE TABLE naver_virtual.${objects} (
      account_id text NOT NULL,
      bucket text NOT NULL,
      key text NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 1024),
      bytes bytea NOT NULL CHECK (octet_length(bytes) <= 16777216),
      etag text NOT NULL,
      metadata jsonb NOT NULL,
      modified_at timestamptz NOT NULL,
      PRIMARY KEY (account_id, bucket, key)
    );
    CREATE TABLE naver_virtual.${products} (
      account_id text NOT NULL,
      seller_id text NOT NULL,
      origin_no bigint NOT NULL,
      channel_no bigint NOT NULL,
      seller_code text NOT NULL,
      origin jsonb NOT NULL,
      PRIMARY KEY (account_id, seller_id, origin_no),
      UNIQUE (account_id, seller_id, channel_no),
      UNIQUE (account_id, seller_id, seller_code)
    );
    CREATE TABLE naver_virtual.${orders} (
      account_id text NOT NULL,
      seller_id text NOT NULL,
      order_no text NOT NULL,
      detail jsonb NOT NULL,
      PRIMARY KEY (account_id, seller_id, order_no)
    );
    CREATE TABLE naver_virtual.${tokens} (
      account_id text NOT NULL,
      workload text NOT NULL,
      client_id text NOT NULL,
      seller_id text NOT NULL,
      grant_type text NOT NULL CHECK (grant_type IN ('SELF', 'SELLER')),
      token text NOT NULL,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (account_id, workload, client_id, seller_id, token)
    );
    ${rls}
    GRANT SELECT, INSERT, UPDATE (bytes, etag, metadata, modified_at), DELETE ON naver_virtual.${objects} TO nvirtual_run;
    GRANT SELECT, UPDATE (origin) ON naver_virtual.${products} TO nvirtual_run;
    GRANT SELECT ON naver_virtual.${orders} TO nvirtual_run;
    GRANT SELECT, INSERT, DELETE ON naver_virtual.${tokens} TO nvirtual_run;
    DO $provision$
      DECLARE extension_schema text;
      BEGIN
        SELECT n.nspname INTO extension_schema FROM pg_extension e
          JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto';
        IF extension_schema NOT IN ('naver_virtual', 'public') OR extension_schema IS NULL THEN
          RAISE EXCEPTION 'PN16 requires pgcrypto provisioned in naver_virtual or public';
        END IF;
        EXECUTE format(
          'CREATE FUNCTION naver_virtual.pn16_bcrypt(text, text) RETURNS text LANGUAGE sql STRICT RETURN %I.crypt($1, $2)',
          extension_schema
        );
      END;
    $provision$;
    REVOKE ALL ON FUNCTION naver_virtual.pn16_bcrypt(text, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION naver_virtual.pn16_bcrypt(text, text) TO nvirtual_run;
  `,
  down: `
    DROP FUNCTION naver_virtual.pn16_bcrypt(text, text);
    DROP TABLE naver_virtual.${tokens}, naver_virtual.${orders}, naver_virtual.${products}, naver_virtual.${objects};
  `,
}

function cafeOrder(day: string, sequence: string, status: 'PAYED' | 'DELIVERED', name: string): CommerceSellerOrder {
  const id = day.replaceAll('-', '') + sequence
  const orderedAt = `${day}T09:30:00+09:00`
  return {
    order: { orderId: id, orderDate: orderedAt, paymentDate: orderedAt },
    productOrder: {
      productOrderId: id + '01', productOrderStatus: status,
      productId: String(houseBlendChannelNo), originalProductId: String(houseBlendProductNo),
      productName: name, itemNo: String(houseBlendOptionNo), quantity: 1, totalPaymentAmount: 12000,
    },
  }
}

export async function seed(client: PoolClient, { accountId, cafe, previousGeneration }: PersonaSeedContext) {
  if (previousGeneration) {
    for (const table of [objects, products, orders, tokens]) {
      await client.query(`DELETE FROM naver_virtual.${table} WHERE account_id = $1`, [accountId])
    }
  }
  const name = '하우스 블렌드 원두'
  const origin: CommerceStockReceipt['originProduct'] = {
    name, statusType: 'SALE', salePrice: 12000, stockQuantity: 23,
    detailContent: '<p>안숭잘부 카페 하우스 블렌드 원두</p>',
    images: { representativeImage: { url: 'https://example.invalid/ansungjalbu/house-blend.jpg' } },
    detailAttribute: {
      optionInfo: {
        optionCombinations: [
          { id: houseBlendOptionNo, optionName1: '200g', stockQuantity: 18, price: 0, usable: true },
          { id: houseBlendOptionNo + 1, optionName1: '500g', stockQuantity: 5, price: 13000, usable: true },
        ],
      },
    },
  }
  await client.query(
    `INSERT INTO naver_virtual.${products} (account_id, seller_id, origin_no, channel_no, seller_code, origin)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [accountId, sellerId, houseBlendProductNo, houseBlendChannelNo, houseBlendSellerCode, origin],
  )
  const previousDay = new Date(Date.parse(`${cafe.businessDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
  const samples = [cafeOrder(cafe.businessDate, '00010', 'PAYED', name), cafeOrder(previousDay, '00011', 'DELIVERED', name)]
  for (const detail of samples) {
    await client.query(
      `INSERT INTO naver_virtual.${orders} (account_id, seller_id, order_no, detail)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [accountId, sellerId, detail.productOrder.productOrderId, detail],
    )
  }
}
