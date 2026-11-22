import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { commercePaths, pn16Operations } from '../../../../packages/naver/contracts/pn16/index.ts';
import { boolean, integer, json, list, object, ownerRequest, text, type NaverTransport, type OwnerContext } from '../../../account/naver/wire.ts';
import { createInventoryNaver } from '../../naver/index.ts';
import { withStoreTransaction } from '../../store-transaction.ts';
import { CardError } from '../01/owner-card.ts';
import { publicationHttp } from '../01/publication-routes.ts';
import { uuid } from './wire.ts';

export type CommerceStockInput = { optionId: number; stockQuantity: number };
export type CommerceOption = { id: number; name: string; stockQuantity: number; price: number; usable: boolean };
export type CommerceStockView = { originProductNo: number; name: string; stockQuantity: number; options: CommerceOption[] };

export function registerCommerceStock(app: FastifyInstance, pool: Pool, gatewayToken: string, transport: NaverTransport) {
  const http = publicationHttp(app, pool, gatewayToken);
  const provider = createInventoryNaver(transport);
  const path = '/items/:id/commerce-stock';

  async function snapshot(db: PoolClient, scope: OwnerContext, itemId: string) {
    const { rows: [link] } = await db.query<{ product: string; revision: number }>(`
      SELECT link.origin_product_no::text AS product, item.revision
      FROM inventory.commerce_link link JOIN inventory.inventory_item item USING (store_id, item_id)
      WHERE store_id=$1 AND item_id=$2 AND item.archived_at IS NULL
    `, [scope.storeId, itemId]);
    if (!link) throw new CardError(404, 'COMMERCE_ITEM_NOT_LINKED');
    return link;
  }

  async function read(scope: OwnerContext, productNo: string): Promise<CommerceStockView> {
    const originProductNo = Number(productNo);
    const page = await provider.products(scope, { originProductNos: [originProductNo], size: 1, page: 1 });
    const product = page.contents.find(row => row.originProductNo === originProductNo);
    if (!product?.channelProducts.some(channel => channel.channelServiceType === 'STOREFARM')) {
      throw new CardError(404, 'COMMERCE_PRODUCT_NOT_FOUND');
    }
    const response = await json(ownerRequest(transport, scope)(pn16Operations.productRead,
      commercePaths.originProduct.replace(':originProductNo', productNo)));
    const origin = object(object(response).originProduct);
    const info = object(object(origin.detailAttribute).optionInfo);
    const options = list(info.optionCombinations, value => {
      const row = object(value);
      return { id: integer(row.id), name: text(row.optionName1), stockQuantity: integer(row.stockQuantity),
        price: integer(row.price), usable: boolean(row.usable) } satisfies CommerceOption;
    });
    return { originProductNo, name: text(origin.name), stockQuantity: integer(origin.stockQuantity), options };
  }

  http.route('GET', path, async (db, scope, request) => {
    const link = await withStoreTransaction(db, scope.storeId,
      client => snapshot(client, scope, uuid(request.params.id, 'itemId')), { readOnly: true });
    return read(scope, link.product);
  });
  http.external({
    snapshot,
    kind: 'commerce-stock', path,
    input(body): CommerceStockInput {
      const value = body as Partial<CommerceStockInput> | null;
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 2
          || typeof value.optionId !== 'number' || !Number.isSafeInteger(value.optionId) || value.optionId < 1
          || typeof value.stockQuantity !== 'number' || !Number.isSafeInteger(value.stockQuantity)
          || value.stockQuantity < 0 || value.stockQuantity > 99_999_999) {
        throw new CardError(400, 'INVALID_OPTION_STOCK');
      }
      return { optionId: value.optionId, stockQuantity: value.stockQuantity };
    },
    async inspect(scope, { optionId, stockQuantity }, link) {
      const product = await read(scope, link.product);
      const current = product.options.find(option => option.id === optionId);
      if (!current) throw new CardError(404, 'COMMERCE_OPTION_NOT_FOUND');
      return {
        expectedRevision: link.revision,
        view: { originProductNo: product.originProductNo, revision: link.revision, current, stockQuantity },
        changed: current.stockQuantity !== stockQuantity,
      };
    },
    async publish(scope, _input, { originProductNo, current, stockQuantity }, receiptId) {
      await provider.updateOptionStock(scope, { key: receiptId }, originProductNo, current, stockQuantity);
      const readBack = await read(scope, String(originProductNo));
      const updated = readBack.options.find(option => option.id === current.id);
      if (updated?.stockQuantity !== stockQuantity || updated.price !== current.price || updated.usable !== current.usable) {
        throw new CardError(502, 'COMMERCE_READ_BACK_FAILED');
      }
      return { state: 'saved', readBack, affectedSources: ['inventory.commerce-stock'] };
    },
  });
}
