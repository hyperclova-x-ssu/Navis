import { boolean, commandHeaders, integer, invalidWire, json, list, NaverError, object, ownerRequest, query, text,
  type NaverTransport, type OwnerApproval, type OwnerContext } from '../../account/naver/wire.ts';

const menu = '/partner-assumed/v1/place/menu';
const commerce = '/external/v1/products';
const jsonHeaders = { 'content-type': 'application/json' };

function menuItem(value: unknown) {
  const row = object(value);
  return { name: text(row.name), price: integer(row.price) };
}
function optionView(value: unknown) {
  const row = object(value);
  return { id: integer(row.id), stockQuantity: integer(row.stockQuantity), price: integer(row.price), usable: boolean(row.usable) };
}

type MenuItem = ReturnType<typeof menuItem>;
type CurrentOption = ReturnType<typeof optionView>;
type Search = {
  originProductNos?: number[]; channelProductNos?: number[]; sellerManagementCode?: string;
  productStatusTypes?: string[]; page?: number; size?: number;
};

export function createInventoryNaver(transport: NaverTransport) {
  return {
    // https://new.smartplace.naver.com/introduction/solution-market/payNPos
    async menu(ctx: OwnerContext) {
      return list(await json(ownerRequest(transport, ctx)('pn01.menu.read', menu)), menuItem);
    },
    async publishMenu(ctx: OwnerContext, card: OwnerApproval, patch: Partial<MenuItem>, currentName?: string) {
      const { name, price } = patch;
      if ((!currentName && (name === undefined || price === undefined)) || (name === undefined && price === undefined)
        || (name !== undefined && (!name.trim() || name.length > 100))
        || (price !== undefined && (!Number.isSafeInteger(price) || price < 0 || price > 2147483647))) {
        throw new NaverError(400, 'INVALID_MENU_ITEM');
      }
      return list(await json(ownerRequest(transport, ctx)('pn01.menu.update', menu + query({ name: currentName }), {
        headers: commandHeaders(card), body: JSON.stringify({ name, price }),
        approvalScope: { actorId: ctx.actorId, currentName },
      })), menuItem);
    },
    // https://apicenter.commerce.naver.com/docs/commerce-api/current/search-product
    async products(ctx: OwnerContext, filter: Search) {
      const { originProductNos, channelProductNos, sellerManagementCode, productStatusTypes, page, size } = filter;
      const selectors = [
        [originProductNos, 'PRODUCT_NO'], [channelProductNos, 'CHANNEL_PRODUCT_NO'], [sellerManagementCode, 'SELLER_CODE'],
      ].filter(([value]) => value !== undefined);
      if (selectors.length > 1) throw new NaverError(400, 'INVALID_COMMERCE_SEARCH');
      const searchKeywordType = selectors[0]?.[1];
      const row = object(await json(ownerRequest(transport, ctx)('pn16.commerce.products.search', commerce + '/search', {
        headers: jsonHeaders,
        body: JSON.stringify({ searchKeywordType, originProductNos, channelProductNos, sellerManagementCode, productStatusTypes, page, size }),
        approvalScope: { actorId: ctx.actorId },
      })));
      return {
        page: integer(row.page), size: integer(row.size), totalPages: integer(row.totalPages), totalElements: integer(row.totalElements),
        first: boolean(row.first), last: boolean(row.last),
        contents: list(row.contents, value => {
          const item = object(value);
          return { originProductNo: integer(item.originProductNo), channelProducts: list(item.channelProducts, value => {
            const channel = object(value);
            return {
              channelProductNo: integer(channel.channelProductNo), channelServiceType: text(channel.channelServiceType),
              name: text(channel.name), statusType: text(channel.statusType), salePrice: integer(channel.salePrice),
              stockQuantity: integer(channel.stockQuantity), sellerManagementCode: text(channel.sellerManagementCode),
            };
          }) };
        }),
      };
    },
    // https://apicenter.commerce.naver.com/docs/commerce-api/current/update-options-product
    async updateOptionStock(ctx: OwnerContext, card: OwnerApproval, originProductNo: number, current: CurrentOption, stockQuantity: number) {
      if (![originProductNo, current.id, current.price, stockQuantity].every(Number.isSafeInteger)
        || originProductNo < 1 || current.id < 1 || stockQuantity < 0 || stockQuantity > 99_999_999 || typeof current.usable !== 'boolean') {
        throw new NaverError(400, 'INVALID_OPTION_STOCK');
      }
      const { id, price, usable } = current;
      const result = object(await json(ownerRequest(transport, ctx)('pn16.commerce.options.update',
        commerce + '/origin-products/' + originProductNo + '/option-stock', {
          headers: commandHeaders(card),
          body: JSON.stringify({ optionInfo: { optionCombinations: [{ id, stockQuantity, price, usable }] } }),
          approvalScope: { actorId: ctx.actorId, originProductNo, optionId: id },
        })));
      const optionInfo = object(object(object(result.originProduct).detailAttribute).optionInfo);
      const options = list(optionInfo.optionCombinations, optionView);
      const updated = options.find(option => option.id === id);
      if (result.originProductNo !== originProductNo || updated?.stockQuantity !== stockQuantity
        || updated.price !== price || updated.usable !== usable) return invalidWire();
      return { originProductNo, options };
    },
  };
}
