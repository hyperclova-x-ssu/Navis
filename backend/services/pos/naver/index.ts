import { approval, checked, choice, commandHeaders, integer, invalidWire, json, list, NaverError, object, ownerRequest,
  query, selector, text, type NaverTransport, type OwnerApproval, type OwnerContext } from '../../account/naver/wire.ts';

const orderBase = '/partner-assumed/v1/orders';
const pay = '/naverpay-partner/naverpay/payments';
const settlementBase = '/naverpaysettle-payment/naverpaysettle/v1/settlements/by-case';
type CancelForm = {
  paymentId: string; cancelReason: string; cancelRequester: '1' | '2';
  cancelAmount: number; taxScopeAmount: number; taxExScopeAmount: number;
  merchantPayTransactionKey?: string; environmentDepositAmount?: number;
  doCompareRest?: 0 | 1; expectedRestAmount?: number;
};
function orderView(value: unknown) {
  const row = object(value);
  return {
    orderNumber: text(row.orderNumber), preparationMinutes: row.preparationMinutes === null ? null : integer(row.preparationMinutes),
    status: choice(row.status, ['received', 'preparing', 'picked-up']),
  };
}
function form(fields: Record<string, string | number | undefined>) {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) parameters.set(key, String(value));
  return parameters;
}
async function payBody(response: Response, key?: string) {
  const replay = response.status === 409 && key && response.headers.get('x-naverpay-idempotency-key') === key;
  if (!response.ok && !replay) await checked(response);
  let payload: unknown;
  try { payload = await response.json(); } catch { return invalidWire(); }
  const row = object(payload);
  if (row.code !== 'Success') throw new NaverError(409, 'NPAY_OPERATION_REJECTED');
  return object(row.body);
}

export function createPosNaver(transport: NaverTransport) {
  async function order(ctx: OwnerContext, ref: string) {
    return orderView(await json(ownerRequest(transport, ctx)('pn02.orders.read', orderBase + '/' + selector(ref))));
  }
  async function payCommand(ctx: OwnerContext, card: OwnerApproval, action: 'approve' | 'cancel', input: Parameters<typeof form>[0]) {
    const key = approval(card, action === 'cancel');
    if (key.length > 64) throw new NaverError(400, 'INVALID_NPAY_IDEMPOTENCY_KEY');
    return payBody(await ownerRequest(transport, ctx)('pn09.pay.' + action,
      pay + (action === 'approve' ? '/v2.2/apply/payment' : '/v1/cancel'), {
        headers: { 'X-NaverPay-Idempotency-Key': key },
        body: form(input), approvalScope: { actorId: ctx.actorId, paymentId: input.paymentId },
      }), key);
  }
  return {
    // https://new.smartplace.naver.com/introduction/solution-market/payNPos
    async orders(ctx: OwnerContext) {
      return list(await json(ownerRequest(transport, ctx)('pn02.orders.list', orderBase)), orderView);
    },
    order,
    async fulfillOrder(ctx: OwnerContext, card: OwnerApproval, ref: string,
      action: { kind: 'prepare'; preparationMinutes: number } | { kind: 'pickup' }) {
      const { kind } = action;
      if (kind === 'prepare' && (!Number.isSafeInteger(action.preparationMinutes) || action.preparationMinutes < 1)) {
        throw new NaverError(400, 'INVALID_PREPARATION_TIME');
      }
      const response = await checked(await ownerRequest(transport, ctx)('pn02.orders.' + kind,
        orderBase + '/' + selector(ref) + '/' + kind, {
          headers: commandHeaders(card),
          body: JSON.stringify(kind === 'prepare' ? { preparationMinutes: action.preparationMinutes } : {}),
          approvalScope: { actorId: ctx.actorId, orderNumber: ref },
        }));
      await response.body?.cancel();
      return order(ctx, ref);
    },
    // https://docs.pay.naver.com/docs/onetime-payment/payment/apply/
    async approvePayment(ctx: OwnerContext, card: OwnerApproval, paymentId: string) {
      const body = await payCommand(ctx, card, 'approve', { paymentId: selector(paymentId) });
      const detail = object(body.detail);
      if (body.paymentId !== paymentId || detail.paymentId !== paymentId || detail.admissionState !== 'SUCCESS') return invalidWire();
      return {
        paymentId, payHistId: text(detail.payHistId), admissionState: 'SUCCESS' as const,
        totalPayAmount: integer(detail.totalPayAmount), admissionYmdt: text(detail.admissionYmdt),
      };
    },
    // https://docs.pay.naver.com/docs/onetime-payment/payment/cancel/
    async cancelPayment(ctx: OwnerContext, card: OwnerApproval, input: CancelForm) {
      approval(card, true);
      const { paymentId, cancelAmount, cancelReason, cancelRequester, taxScopeAmount, taxExScopeAmount,
        merchantPayTransactionKey, environmentDepositAmount, doCompareRest, expectedRestAmount } = input;
      if (![cancelAmount, taxScopeAmount, taxExScopeAmount, environmentDepositAmount ?? 0].every(
        value => Number.isSafeInteger(value) && value >= 0)
        || cancelAmount <= 0 || taxScopeAmount + taxExScopeAmount + (environmentDepositAmount ?? 0) !== cancelAmount
        || !cancelReason.trim() || !['1', '2'].includes(cancelRequester)) throw new NaverError(400, 'INVALID_NPAY_CANCELLATION');
      const body = await payCommand(ctx, card, 'cancel', {
        paymentId: selector(paymentId), cancelAmount, cancelReason, cancelRequester, taxScopeAmount, taxExScopeAmount,
        merchantPayTransactionKey, environmentDepositAmount, doCompareRest, expectedRestAmount,
      });
      if (body.paymentId !== paymentId) return invalidWire();
      return { paymentId, payHistId: text(body.payHistId), cancelYmdt: text(body.cancelYmdt), totalRestAmount: integer(body.totalRestAmount) };
    },
    // https://docs.pay.naver.com/docs/settlement/settlement-api/settle-by-case/
    async settlements(ctx: OwnerContext, lookup: 'payment-id' | 'pay-hist-id', id: string, pageNumber?: number) {
      if (lookup !== 'payment-id' && lookup !== 'pay-hist-id') throw new NaverError(400, 'INVALID_NPAY_LOOKUP');
      const body = await payBody(await ownerRequest(transport, ctx)('pn09.pay.settlement',
        settlementBase + '/' + lookup + '/' + selector(id) + query({ pageNumber })));
      return {
        responseCount: integer(body.responseCount), currentPage: integer(body.currentPage),
        ...(body.totalCount !== undefined && { totalCount: integer(body.totalCount) }),
        ...(body.totalPageCount !== undefined && { totalPageCount: integer(body.totalPageCount) }),
        list: list(body.list, value => {
          const row = object(value);
          return {
            paymentId: text(row.paymentId), payHistId: text(row.payHistId), settleType: text(row.settleType),
            payDate: text(row.payDate), settleBasisDate: text(row.settleBasisDate),
            settleExpectDate: text(row.settleExpectDate), settleCompleteDate: text(row.settleCompleteDate),
            paySettleAmount: integer(row.paySettleAmount), totalCommissionAmount: integer(row.totalCommissionAmount),
            totalPayCommissionAmount: integer(row.totalPayCommissionAmount), settleExpectAmount: integer(row.settleExpectAmount),
          };
        }),
      };
    },
    // https://apicenter.commerce.naver.com/docs/commerce-api/current/seller-get-product-orders-pay-order-seller
    async commerceOrders(ctx: OwnerContext, productOrderIds: readonly string[]) {
      if (!productOrderIds.length || productOrderIds.length > 300 || new Set(productOrderIds).size !== productOrderIds.length) {
        throw new NaverError(400, 'INVALID_COMMERCE_ORDER_IDS');
      }
      if (productOrderIds.some(id => !/^\d{1,32}$/.test(id))) throw new NaverError(400, 'INVALID_COMMERCE_ORDER_IDS');
      const ids = new Set(productOrderIds);
      const row = object(await json(ownerRequest(transport, ctx)('pn16.commerce.orders.detail', '/external/v1/pay-order/seller/product-orders/query', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productOrderIds: [...ids] }), approvalScope: { actorId: ctx.actorId, productOrderIds: [...ids] },
      })));
      return list(row.data, value => {
        const product = object(object(value).productOrder);
        const productOrderId = text(product.productOrderId);
        if (!ids.has(productOrderId)) return invalidWire();
        return { productOrderId, productOrderStatus: text(product.productOrderStatus) };
      });
    },
  };
}
