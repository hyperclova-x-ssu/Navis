export const pn16Operations = {
  objectPut: 'pn16.object.put',
  objectGet: 'pn16.object.get',
  objectDelete: 'pn16.object.delete',
  commerceToken: 'pn16.commerce.token',
  productSearch: 'pn16.commerce.products.search',
  productRead: 'pn16.commerce.products.read',
  optionStock: 'pn16.commerce.options.update',
  orderDetail: 'pn16.commerce.orders.detail',
} as const

// Commerce v2.91.0. Base https://api.commerce.naver.com/external.
export const commercePaths = {
  token: '/external/v1/oauth2/token',
  products: '/external/v1/products/search',
  originProduct: '/external/v2/products/origin-products/:originProductNo',
  optionStock: '/external/v1/products/origin-products/:originProductNo/option-stock',
  orders: '/external/v1/pay-order/seller/product-orders/query',
} as const

// https://apicenter.commerce.naver.com/docs/commerce-api/current/exchange-sellers-auth
export interface CommerceToken {
  access_token: string
  expires_in: number
  token_type: 'Bearer'
}

// https://apicenter.commerce.naver.com/docs/commerce-api/current/search-product
export const productStatuses = [
  'WAIT', 'SALE', 'OUTOFSTOCK', 'UNADMISSION', 'REJECTION', 'SUSPENSION', 'CLOSE', 'PROHIBITION', 'DELETE',
] as const
export type ProductStatus = typeof productStatuses[number]

export interface CommerceProductPage {
  contents: Array<{
    originProductNo: number
    channelProducts: Array<{
      originProductNo: number
      channelProductNo: number
      channelServiceType: 'STOREFARM'
      name: string
      sellerManagementCode: string
      statusType: ProductStatus
      salePrice: number
      stockQuantity: number
    }>
  }>
  page: number
  size: number
  totalElements: number
  totalPages: number
  first: boolean
  last: boolean
}

// https://apicenter.commerce.naver.com/docs/commerce-api/current/update-options-product
export interface CommerceOptionCombination {
  id: number
  stockQuantity: number
  price: number
  usable: boolean
}

export interface CommerceStockReceipt {
  originProductNo: number
  smartstoreChannelProductNo: number
  originProduct: {
    statusType: ProductStatus
    name: string
    detailContent: string
    images: { representativeImage: { url: string } }
    salePrice: number
    stockQuantity: number
    detailAttribute: { optionInfo: { optionCombinations: Array<CommerceOptionCombination & { optionName1: string }> } }
  }
}

// https://apicenter.commerce.naver.com/docs/commerce-api/current/read-origin-product-product
export type CommerceOriginProduct = Pick<CommerceStockReceipt, 'originProduct'>;

// https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller
export interface CommerceSellerOrder {
  order: { orderId: string; orderDate: string; paymentDate: string }
  productOrder: {
    productOrderId: string
    productOrderStatus: 'PAYED' | 'DELIVERED'
    productId: string
    originalProductId: string
    productName: string
    itemNo: string
    quantity: number
    totalPaymentAmount: number
  }
}

export interface CommerceOrderDetail {
  timestamp: string
  traceId: string
  data: CommerceSellerOrder[]
}
