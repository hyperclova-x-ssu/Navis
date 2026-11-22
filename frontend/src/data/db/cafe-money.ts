import { cafeMemberId } from './cafe-identity';
import type { PosState } from '../../contracts/pos';
import { canonicalPosMoney } from '../../pos/domain/money';
import { emptyMoneyState } from '../iteration7/accounting';
import type { MemberAccountTxn, MembershipTerms, MoneyState, SalesRecognition } from '../iteration7/accounting/types';
import { membershipProducts } from '../iteration7/memberships';
import { seedCatalog, seedOperations, seedSupplement, seedToday } from './cafe-fixtures';
import { YESTERDAY } from './time';

const products = new Map(membershipProducts.map(product => [product.productId, product]));
const menu = new Map<string, (typeof seedCatalog.menu)[number]>(seedCatalog.menu.map(row => [row.menuId, row]));

export function cafeOpeningMoney(pos: PosState): MoneyState {
  if (pos.businessDate !== seedToday.pos.businessDate) return canonicalPosMoney({ ...pos, money: emptyMoneyState() })!;
  const accountTxns = seedSupplement.balances.flatMap(row => {
    const opening = (account: MemberAccountTxn['account'], amount: number) => ({
      txnId: `sample-opening:${account}:${row.memberId}`, memberId: cafeMemberId(row.memberId),
      account, amount, kind: 'opening' as const, at: `${YESTERDAY}T08:00`,
      settlementId: null, allocationId: null, sourceRef: null, originalTxnId: null, reason: '',
      provenance: row.provenance,
    });
    return [opening('charge', row.chargeBalance), opening('receivable', row.receivableBalance)].filter(txn => txn.amount > 0);
  });
  const memberships: MembershipTerms[] = [
    ...seedOperations.memberships.map(row => ({ ...row, openingUses: 0 })),
    ...seedSupplement.activePasses.map(row => ({ ...row, openingUses: products.get(row.productId)!.totalUses! - row.usesLeft })),
  ].map(row => ({
    ...products.get(row.productId)!, membershipId: row.membershipId, memberId: cafeMemberId(row.memberId), startsOn: row.startsOn, endsOn: row.endsOn,
    saleSettlementId: `opening-pass:${row.membershipId}`, openingUses: row.openingUses,
    ...('provenance' in row ? { provenance: row.provenance } : {}),
  }));
  const uses = seedOperations.membershipUses.map(row => ({
    useId: row.useId, membershipId: row.membershipId, at: row.usedAt, canceledAt: row.canceledAt,
    sourceRef: { kind: 'history', id: row.membershipId }, coveredQuantities: [], recognizedAmount: 0, membershipDiscount: 0,
  }));
  const state = canonicalPosMoney({ ...pos, money: { ...emptyMoneyState(), accountTxns, memberships, uses } })!;
  const orders = new Map(pos.orders.flatMap(order => order.lines.map(line => [line.orderLineId, line] as const)));
  const allocations = new Map(pos.billAllocations.map(line => [line.allocationId, line]));
  const recognized = new Set(state.recognitions.map(row => row.sourceId));
  const zeroDue: SalesRecognition[] = pos.bills.filter(bill => bill.recognizedAt && !recognized.has(bill.billId)).flatMap(bill =>
    bill.settlementLines.map(line => {
      const discountBySource = { direct: 0, coupon: 0, membership: 0 };
      for (const share of line.discountAllocations) {
        const original = bill.discounts.find(discount => discount.discountId === share.discountId);
        if (original) discountBySource[original.source] += share.amount;
      }
      const gross = line.recognizedQty * (line.basePriceAtSale + line.optionPriceAtSale);
      const cost = line.unitCostAtSale === null || line.optionCostAtSale === null ? null : line.recognizedQty * (line.unitCostAtSale + line.optionCostAtSale);
      return {
        recognitionId: `recognized:${line.allocationId}`, source: 'menu', sourceId: bill.billId,
        businessDate: pos.businessDate, at: bill.recognizedAt!, amount: 0, cost, gross, discountBySource, originalRecognitionId: null,
        settlementCategory: 'membership_count',
        menuId: line.menuId, quantity: line.recognizedQty, billAllocationId: line.allocationId,
        orderLineId: allocations.get(line.allocationId)?.orderLineId,
      };
    }),
  );
  return {
    ...state, recognitions: [...state.recognitions, ...zeroDue],
    settlements: state.settlements.map(settlement => {
      const source = settlement.sourceSnapshot;
      if (!source) return settlement;
      const lines = source.lines.map(line => ({
        ...line,
        recipe: [...menu.get(line.menuId)?.recipeBase ?? [], ...orders.get(line.orderLineId)?.optionsAtOrder.flatMap(option => option.extraRecipe) ?? []],
      }));
      return { ...settlement, sourceSnapshot: { ...source, lines } };
    }),
  };
}
