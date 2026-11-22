import { productStatuses } from '../../../../packages/naver/contracts/pn16/index.ts'
import type { CommerceOptionCombination, ProductStatus } from '../../../../packages/naver/contracts/pn16/index.ts'

function record(value: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const object = value as Record<string, unknown>
  if (Object.keys(object).every((key) => names.includes(key))) return object
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function numbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 500 && value.every((item) => integer(item, 1))
}

const tokenFields = ['client_id', 'timestamp', 'grant_type', 'client_secret_sign', 'type', 'account_id']

export function tokenRequest(form: unknown) {
  if (!(form instanceof URLSearchParams)) return
  const fields = [...form.keys()]
  if (new Set(fields).size !== fields.length || fields.some((name) => !tokenFields.includes(name))) return
  const clientId = form.get('client_id')
  const rawTimestamp = form.get('timestamp')
  const signedSecret = form.get('client_secret_sign')
  const type = form.get('type')
  const sellerId = form.get('account_id')
  if (
    !clientId || !/^[A-Za-z0-9_-]{1,48}$/.test(clientId) || !rawTimestamp || !/^\d{1,15}$/.test(rawTimestamp)
    || !signedSecret || signedSecret.length > 128 || form.get('grant_type') !== 'client_credentials'
    || (type !== 'SELF' && type !== 'SELLER') || (type === 'SELLER' && !sellerId)
    || (sellerId !== null && (!/^[A-Za-z0-9_.@-]{1,160}$/.test(sellerId) || type === 'SELF'))
  ) return
  return { clientId, timestamp: Number(rawTimestamp), signedSecret, type, sellerId }
}

const searchFields = [
  'searchKeywordType', 'originProductNos', 'channelProductNos', 'sellerManagementCode',
  'productStatusTypes', 'page', 'size',
]

export function productSearch(value: unknown) {
  const input = record(value, searchFields)
  if (!input) return
  const { searchKeywordType, originProductNos, channelProductNos, sellerManagementCode,
    productStatusTypes, page = 1, size = 50 } = input
  const selectorFields = {
    PRODUCT_NO: 'originProductNos', CHANNEL_PRODUCT_NO: 'channelProductNos', SELLER_CODE: 'sellerManagementCode',
  } as const
  const provided = Object.values(selectorFields).filter((field) => Object.hasOwn(input, field))
  if (
    (searchKeywordType === undefined && provided.length !== 0)
    || (searchKeywordType !== undefined && (
      typeof searchKeywordType !== 'string' || !Object.hasOwn(selectorFields, searchKeywordType)
      || provided.length !== 1 || provided[0] !== selectorFields[searchKeywordType as keyof typeof selectorFields]
    ))
    || (originProductNos !== undefined && !numbers(originProductNos))
    || (channelProductNos !== undefined && !numbers(channelProductNos))
    || (sellerManagementCode !== undefined && (
      typeof sellerManagementCode !== 'string' || sellerManagementCode.length < 1 || sellerManagementCode.length > 160
    ))
    || (productStatusTypes !== undefined && (
      !Array.isArray(productStatusTypes) || productStatusTypes.length > productStatuses.length
      || !productStatusTypes.every((status) => productStatuses.includes(status))
    ))
    || !integer(page, 1, 2147483647) || !integer(size, 1, 500)
  ) return
  return { originProductNos, channelProductNos, sellerManagementCode, page, size,
    productStatusTypes: productStatusTypes as ProductStatus[] | undefined }
}

export function stockUpdate(value: unknown): CommerceOptionCombination[] | undefined {
  const input = record(value, ['optionInfo'])
  const optionInfo = record(input?.optionInfo, ['optionCombinations'])
  const items = optionInfo?.optionCombinations
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) return
  const updates: CommerceOptionCombination[] = []
  const ids = new Set<number>()
  for (const value of items) {
    const item = record(value, ['id', 'stockQuantity', 'price', 'usable'])
    if (!item) return
    const { id, stockQuantity = 0, price = 0, usable = true } = item
    if (
      !integer(id, 1) || ids.has(id) || !integer(stockQuantity, 0, 99999999)
      || !integer(price, -999999990, 999999990) || typeof usable !== 'boolean'
    ) return
    ids.add(id)
    updates.push({ id, stockQuantity, price, usable })
  }
  return updates
}

export function orderQuery(value: unknown): string[] | undefined {
  const input = record(value, ['productOrderIds', 'quantityClaimCompatibility'])
  const ids = input?.productOrderIds
  if (
    !Array.isArray(ids) || ids.length < 1 || ids.length > 300
    || !ids.every((id) => typeof id === 'string' && /^\d{1,32}$/.test(id))
    || (input?.quantityClaimCompatibility !== undefined && typeof input.quantityClaimCompatibility !== 'boolean')
  ) return
  return [...new Set(ids)]
}
