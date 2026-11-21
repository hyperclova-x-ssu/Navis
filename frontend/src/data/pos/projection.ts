import type { CustomOrderRead, CustomMoneyEffects, CustomPlanResult } from '../iteration7/custom-orders';
import { selectPosDrawer } from '../../pos/closing';
import type { PosState } from '../../contracts/pos';
import { allocatePosAmount, distributePosAmount, canonicalPosMoney, selectPosDayTotals, selectPosSalesByMenu } from '../../pos/domain/money';
import { createPosSeed } from '../../pos/seed';
import { selectAccountingDay, selectAccountingPeriod, selectAccountingDrawer, emptyMoneyState } from '../iteration7/accounting';
import { membershipProducts } from '../iteration7/memberships';
import type { MoneyRead, MoneySource, MoneyPlan, SalesRecognition } from '../iteration7/accounting/types';
import { maskCustomer } from '../derive/members';
import { selectPosDataRead } from './catalog';
import { adaptPosSettlementSource } from '../../pos/domain/iteration7';
import { getPaymentBillId } from '../../pos/loyalty/selectors';
import { addDays, LAST_MONTH_END, LAST_MONTH_START, TODAY } from '../db/time';
import { seedCatalog } from '../db/generated/catalog';
import { seedHistory } from '../db/generated/history';
import { seedToday } from '../db/generated/today';
import { cafeOpeningMoney } from '../db/cafe-money';
import { businessNow } from '../../pos/clock';
import type { DataSnapshot, DataTables, DailySales, MenuDaily } from '../db/types';
import type { Payment, PaymentLine } from '../db/management-types';
import { deepFreeze } from '../db/freeze';
import { DataQueryError, requireDate, toBase } from '../derive/common';
import { projectMoneyMembers, projectPosLoyalty } from './loyalty';
import { canceledSettlement, paymentSettlementShares } from '../../pos/domain/settlement';

const cafeAllocations = new Set(seedToday.pos.billAllocations.map(line => line.allocationId));
const cafeRecipes = new Map<string, (typeof seedCatalog.menu)[number]['recipeBase']>(seedCatalog.menu.map(menu => [menu.menuId, menu.recipeBase]));
const sameCutoff = seedHistory.comparison;
const fullComparisonDay = seedHistory.days.find(day => day.date === sameCutoff.date);
const qtyByCutoff = new Map(sameCutoff.menu.map(([menuId, qty]) => [menuId, qty]));
const remainingMenuQty = new Map(fullComparisonDay?.menu.map(([menuId, qty]) => [menuId, Math.max(0, qty - (qtyByCutoff.get(menuId) ?? 0))]));

/** Recorded lines consume their sale-time recipe. Live catalog edits affect future lines. */
export function projectPosUsage(pos: PosState, tables: DataTables, date: string) {
  const soldQty = date === pos.businessDate ? moneySalesByMenu(pos) : {};
  const byItem: Record<string, number> = {}, byMenu: Record<string, Record<string, number>> = {};
  const orderLines = new Map(pos.orders.flatMap(order => order.lines.map(line => [line.orderLineId, line] as const)));
  const allocations = new Map(pos.billAllocations.map(line => [line.allocationId, line.orderLineId]));
  const moneyRecipes = new Map<string, NonNullable<MoneySource['lines'][number]['recipe']>>();
  for (const settlement of pos.money?.settlements ?? []) {
    for (const line of settlement.sourceSnapshot?.lines ?? []) {
      if (line.recipe) moneyRecipes.set(line.allocationId, line.recipe);
    }
  }
  const asOfTimes: string[] = [];
  for (const bill of pos.bills) {
    if (date !== pos.businessDate || bill.status !== 'paid' || !bill.recognizedAt) continue;
    for (const line of bill.settlementLines) {
      const qty = line.recognizedQty - canceledSettlement(pos, bill.billId, line.allocationId).qty;
      if (qty <= 0) continue;
      asOfTimes.push(bill.recognizedAt.slice(11, 16));
      const options = orderLines.get(allocations.get(line.allocationId) ?? '')?.optionsAtOrder ?? [];
      // Imported cafe lines can be read before the accounting snapshots are attached.
      const cafeRecipe = cafeAllocations.has(line.allocationId) ? cafeRecipes.get(line.menuId) : undefined;
      const recipe = moneyRecipes.get(line.allocationId) ?? [
        ...(cafeRecipe ?? tables.recipeLine.filter(part => part.menuId === line.menuId).map(part => ({ itemId: part.itemId, quantityBase: toBase(part.quantity, part.unit) ?? 0 }))),
        ...options.flatMap(option => option.extraRecipe),
      ];
      for (const part of recipe) {
        const amount = part.quantityBase * qty;
        const own = byMenu[line.menuId] ??= {};
        own[part.itemId] = (own[part.itemId] ?? 0) + amount;
        byItem[part.itemId] = (byItem[part.itemId] ?? 0) + amount;
      }
    }
  }
  const asOf = asOfTimes.sort().at(-1) ?? businessNow().slice(11, 16);
  const usageRows = Object.entries(byMenu).flatMap(([menuId, items]) => Object.entries(items).map(([itemId, quantityBase]) => ({
    rowId: `usage:${date}:${menuId}:${itemId}`, menuId, itemId, soldQty: soldQty[menuId] ?? 0, quantityBase, asOf,
  })));
  return { byItem, byMenu, usageRows, soldQty, asOf };
}

/** Estimate the rest of the cafe demo day from last week's sales after the same cutoff. */
export function projectPosRemainingUsage(pos: PosState, tables: DataTables, date: string): Readonly<Record<string, number>> {
  const byItem: Record<string, number> = {};
  if (date !== pos.businessDate || date !== seedToday.pos.businessDate) return byItem;
  const closing = tables.dayClosing.filter(row => row.businessDate === date && row.scenario === 'normal').at(-1);
  if (closing?.status === 'closed') return byItem;

  const selling = new Set(tables.menuItem.filter(menu => !menu.deletedAt && menu.saleStatus !== 'sold_out').map(menu => menu.menuId));
  for (const part of tables.recipeLine) {
    const qty = remainingMenuQty.get(part.menuId) ?? 0;
    if (!qty || !selling.has(part.menuId)) continue;
    const amount = (toBase(part.quantity, part.unit) ?? 0) * qty;
    byItem[part.itemId] = (byItem[part.itemId] ?? 0) + amount;
  }
  return byItem;
}

/** API-243: no checksum or management "today" aggregate is an input. */
export function projectPosDay({ pos, data, scenario, date }: { readonly pos: PosState; readonly data: DataSnapshot; readonly scenario: 'normal' | 'empty' | 'error'; readonly date: string }) {
  requireDate(date);
  if (scenario === 'error') throw new DataQueryError('VALIDATION', 'scenario');
  const active = scenario === 'empty' || date !== pos.businessDate ? { ...pos, bills: [], payments: [], refunds: [], cancellations: [] } : pos;
  const methodTotals = selectM2DayTotals(active, scenario === 'empty' || date !== pos.businessDate ? 'empty' : 'normal');
  const paid = active.bills.filter(b => b.status === 'paid' && b.recognizedAt);
  const bills = new Map(paid.map(b => [b.billId, b]));
  const orders = new Map(pos.orders.flatMap(o => o.lines.map(l => [l.orderLineId, l] as const)));
  const allocationLines = new Map(pos.billAllocations.map(a => [a.allocationId, a.orderLineId]));
  // Join once per day projection, rather than scanning every allocation for every payment/order/line.
  const billsByOrderLine = new Map<string, Set<string>>();
  for (const allocation of active.billAllocations) {
    const ids = billsByOrderLine.get(allocation.orderLineId) ?? new Set<string>();
    ids.add(allocation.billId); billsByOrderLine.set(allocation.orderLineId, ids);
  }
  const orderNosByBill = new Map<string, number[]>();
  for (const order of active.orders) {
    const ids = new Set(order.lines.flatMap(line => [...(billsByOrderLine.get(line.orderLineId) ?? [])]));
    for (const id of ids) {
      const numbers = orderNosByBill.get(id) ?? [];
      numbers.push(order.orderNo); orderNosByBill.set(id, numbers);
    }
  }
  const paymentRows: Payment[] = [], paymentLines: PaymentLine[] = [];
  const menus = new Map<string, { qty: number; netSales: number; cost: number | null }>();
  const lineNet = new Map<string, number>();
  const menuByLine = new Map<string, string>();
  for (const bill of paid) {
    for (const line of bill.settlementLines) {
      const canceled = canceledSettlement(pos, bill.billId, line.allocationId);
      const qty = line.recognizedQty - canceled.qty;
      const amount = (line.basePriceAtSale + line.optionPriceAtSale) * line.recognizedQty - canceled.gross;
      const off = line.discountAllocations.reduce((n, d) => n + d.amount, 0) - canceled.discount;
      const net = amount - off, orderLineId = allocationLines.get(line.allocationId) ?? line.allocationId;
      lineNet.set(orderLineId, (lineNet.get(orderLineId) ?? 0) + net); menuByLine.set(orderLineId, line.menuId);
      const menu = menus.get(line.menuId) ?? { qty: 0, netSales: 0, cost: 0 };
      menu.qty += qty; menu.netSales += net;
      menu.cost = !qty ? menu.cost : menu.cost === null || line.unitCostAtSale === null || line.optionCostAtSale === null ? null : menu.cost + qty * (line.unitCostAtSale + line.optionCostAtSale);
      menus.set(line.menuId, menu);
    }
  }
  for (const bill of paid) {
    const payments = active.payments.filter(p => p.billId === bill.billId && p.recognizedAt);
    const shares = paymentSettlementShares(active, bill);
    for (const payment of payments) {
      const own = shares.filter(l => l.paymentId === payment.paymentId);
      const canceled = payment.status === 'canceled';
      for (const line of own) paymentLines.push({ paymentLineId: `${payment.paymentId}:${line.allocationId}`, paymentId: payment.paymentId, menuId: line.menuId,
        qty: canceled ? 0 : line.qty, unitPriceAtSale: line.unitPrice, unitCostAtSale: line.unitCost,
        grossAmount: canceled ? 0 : line.gross, discountAmount: canceled ? 0 : line.discount });
      const discount = own.reduce((n, l) => n + l.discount, 0);
      const returns = active.refunds.filter(r => r.paymentId === payment.paymentId).reduce((n, r) => n + r.amount, 0);
      const cancels = active.cancellations.filter(r => r.paymentId === payment.paymentId).reduce((n, r) => n + r.amount, 0);
      paymentRows.push({ paymentId: payment.paymentId, businessDate: date, time: payment.at.slice(11, 16), seq: payment.seq,
        method: payment.countedMethod, methodSplits: canceled ? payment.splits.map(s => ({ ...s, amount: 0 })) : payment.splits,
        billId: payment.billId, transactionNo: payment.transactionNo, approvalNo: payment.approvalNo,
        orderNos: orderNosByBill.get(payment.billId) ?? [],
        kind: 'payment', gross: canceled ? 0 : payment.amount + discount, discount: canceled ? 0 : discount, refundAmount: 0,
        originalAmount: payment.amount, status: canceled ? 'canceled' : returns ? returns + cancels >= payment.amount ? 'refunded' : 'partially_refunded' : cancels ? 'partially_canceled' : 'paid',
        restockRetail: active.cancellations.some(c => c.paymentId === payment.paymentId && c.restockRetail),
        cashReceipt: [...active.cashReceipts].reverse().find(r => r.paymentId === payment.paymentId && r.status === 'issued') ?? [...active.cashReceipts].reverse().find(r => r.paymentId === payment.paymentId) ?? null,
        summary: { key: 'data.management.paymentSummary' } });
    }
  }
  for (const cancellation of active.cancellations) {
    if (!bills.has(cancellation.billId) || active.payments.find(p => p.paymentId === cancellation.paymentId)?.status === 'canceled') continue;
    paymentRows.push({ paymentId: cancellation.cancellationId, refundOf: cancellation.paymentId, businessDate: date, time: cancellation.at.slice(11, 16), seq: cancellation.seq,
      billId: cancellation.billId, transactionNo: active.payments.find(p => p.paymentId === cancellation.paymentId)?.transactionNo,
      orderNos: orderNosByBill.get(cancellation.billId) ?? [],
      method: cancellation.methodAmounts[0]?.method ?? 'card', methodSplits: cancellation.methodAmounts.map(s => ({ ...s, amount: -s.amount })), kind: 'cancel',
      gross: -cancellation.allocations.reduce((n, a) => n + a.gross, 0), discount: -cancellation.allocations.reduce((n, a) => n + a.discount, 0), refundAmount: 0,
      restockRetail: cancellation.restockRetail, summary: { key: 'data.management.cancelSummary' } });
    for (const a of cancellation.allocations) {
      const menuId = orders.get(a.lineId)?.menuId; if (!menuId) continue;
      paymentLines.push({ paymentLineId: `${cancellation.cancellationId}:${a.allocationId ?? a.lineId}`, paymentId: cancellation.cancellationId, menuId,
        qty: -a.qty, unitPriceAtSale: orders.get(a.lineId)!.unitPriceAtOrder, unitCostAtSale: a.cost === null || !a.qty ? null : a.cost / a.qty,
        grossAmount: -a.gross, discountAmount: -a.discount });
    }
  }
  for (const refund of active.refunds) {
    if (!bills.has(refund.billId)) continue;
    paymentRows.push({ paymentId: refund.refundId, refundOf: refund.paymentId, businessDate: date, time: refund.at.slice(11, 16), seq: refund.seq,
      billId: refund.billId, transactionNo: active.payments.find(p => p.paymentId === refund.paymentId)?.transactionNo,
      orderNos: orderNosByBill.get(refund.billId) ?? [],
      method: refund.methodAmounts[0]?.method ?? 'card', methodSplits: refund.methodAmounts.map(s => ({ ...s, amount: -s.amount })),
      kind: 'refund', gross: 0, discount: 0, refundAmount: refund.amount, summary: { key: 'data.management.refundSummary' } });
    const weights = pos.billAllocations.filter(a => a.billId === refund.billId).map(a => ({ id: a.orderLineId, amount: lineNet.get(a.orderLineId) ?? 0 }));
    const amounts = refund.lineAmounts.length ? Object.fromEntries(refund.lineAmounts.map(l => [l.orderLineId, l.amount])) : allocatePosAmount(refund.amount, weights);
    for (const [lineId, amount] of Object.entries(amounts)) {
      const menuId = menuByLine.get(lineId); if (!menuId || !amount) continue;
      const menu = menus.get(menuId)!; menu.netSales -= amount;
      lineNet.set(lineId, (lineNet.get(lineId) ?? 0) - amount);
      const line = orders.get(lineId);
      paymentLines.push({ paymentLineId: `${refund.refundId}:${lineId}`, paymentId: refund.refundId, menuId, qty: refund.lineAmounts.find(l => l.orderLineId === lineId)?.qty ?? 0,
        unitPriceAtSale: line?.unitPriceAtOrder ?? 0, unitCostAtSale: null, refundAmount: amount });
    }
  }
  const menuDailyToday: MenuDaily[] = [...menus].map(([menuId, m]) => ({ businessDate: date, menuId, qty: m.qty, netSales: m.netSales, unitCost: m.cost === null || !m.qty ? null : m.cost / m.qty, ...(m.cost !== null ? { totalCost: m.cost } : {}) }));
  const dailySalesToday: DailySales = { businessDate: date, gross: methodTotals.gross, discount: methodTotals.discount, refund: methodTotals.refund,
    card: methodTotals.byMethod.card, cash: methodTotals.byMethod.cash, easyPay: methodTotals.byMethod.easy_pay };
  if(pos.money && scenario!=='empty' && date===pos.businessDate){
    const state=pos.money, summary=selectAccountingDay({runId:'',revision:0,generation:0,businessDate:date,now:businessNow(),scenario:'normal',dayClosed:false,state,members:[],products:[],sources:[]},{date});
    const rows=new Map<string,{qty:number;netSales:number;cost:number|null}>();
    for(const r of state.recognitions.filter(r=>r.businessDate===date && r.menuId)){const row=rows.get(r.menuId!)??{qty:0,netSales:0,cost:0};row.qty+=r.quantity??0;row.netSales+=r.amount;row.cost=row.cost===null||r.cost===null?null:row.cost+r.cost;rows.set(r.menuId!,row);}
    return deepFreeze({paymentRows,paymentLines,dailySalesToday:{...dailySalesToday,recognizedNet:summary.sales.total},menuDailyToday:[...rows].map(([menuId,r])=>({businessDate:date,menuId,qty:r.qty,netSales:r.netSales,unitCost:r.qty&&r.cost!==null?r.cost/r.qty:r.cost,...(r.cost!==null?{totalCost:r.cost}:{})})),usage:projectPosUsage(active,data.tables,date),salesByMenu:moneySalesByMenu(active),methodTotals,pendingReceived:methodTotals.pendingReceived});
  }
  return deepFreeze({ paymentRows, paymentLines, dailySalesToday, menuDailyToday, usage: projectPosUsage(active, data.tables, date),
    salesByMenu: moneySalesByMenu(active), methodTotals, pendingReceived: methodTotals.pendingReceived });
}

const baselineSales = selectPosSalesByMenu(createPosSeed());
/** Refresh all read adapters; apply only the change since the last published POS to retail. */
export function projectPosTables(tables: DataTables, pos: PosState, previousPos?: PosState): DataTables {
  tables = projectMoneyMembers(!previousPos&&pos.money?tables:projectPosLoyalty(tables, pos, previousPos),pos);
  const day = projectPosDay({ pos, data: { revision: 0, seq: 0, tables }, scenario: 'normal', date: pos.businessDate });
  const previous = previousPos ? moneySalesByMenu(previousPos) : baselineSales;
  const deltaByItem: Record<string, number> = {};
  for (const m of tables.menuItem) if (m.kind === 'retail' && m.itemId) deltaByItem[m.itemId] = (deltaByItem[m.itemId] ?? 0) + (day.salesByMenu[m.menuId] ?? 0) - (previous[m.menuId] ?? 0);
  return { ...tables,
    payment: [...tables.payment.filter(p => p.businessDate !== pos.businessDate), ...day.paymentRows],
    paymentLine: [...tables.paymentLine.filter(l => tables.payment.some(p => p.paymentId === l.paymentId && p.businessDate !== pos.businessDate)), ...day.paymentLines],
    dailySales: [...tables.dailySales.filter(d => d.businessDate !== pos.businessDate), day.dailySalesToday],
    menuDaily: [...tables.menuDaily.filter(d => d.businessDate !== pos.businessDate), ...day.menuDailyToday],
    inventoryStock: tables.inventoryStock.map(s => s.channel === 'store' && deltaByItem[s.itemId] && s.qty !== null ? { ...s, qty: s.qty - deltaByItem[s.itemId] } : s),
    inventoryItem: tables.inventoryItem.map(i => deltaByItem[i.itemId] && i.sales7d ? { ...i, sales7d: { ...i.sales7d, store: i.sales7d.store + deltaByItem[i.itemId] } } : i),
  };
}

/** Initialize the run's accounting source from its POS transactions. */
export function initializeCustomPos(pos: PosState): PosState {
  if (pos.money) return pos;
  return deepFreeze({ ...pos, money: cafeOpeningMoney(pos) });
}
const customReadCache = new WeakMap<DataSnapshot, CustomOrderRead>();
export function selectCustomOrderRead(snapshot: DataSnapshot): CustomOrderRead {
  let read = customReadCache.get(snapshot);
  if (!read) {
    const pos = snapshot.pos;
    read = deepFreeze({ revision: snapshot.revision, accounting:pos?.money, tables: { ...snapshot.tables, reservation:snapshot.tables.reservation.map(r=>r.kind==='pickup'?r:r.kind==='visit'?r as import('../db/types').Reservation & {readonly kind:'visit'}:{...r,kind:'visit' as const}), member: snapshot.tables.memberProfile },
      money: { settlements: pos?.customSettlements ?? [], payments: pos?.customPayments ?? [], recognitions: pos?.customRecognitions ?? [], corrections: pos?.customCorrections ?? [] }, businessDate: pos?.businessDate });
    customReadCache.set(snapshot, read);
  }
  return read;
}
export function applyCustomMoney(pos: PosState, effects: CustomMoneyEffects): PosState {
  if(pos.money && [effects.settlements,effects.payments,effects.recognitions,effects.corrections].some(rows=>rows.length)){
    const state=pos.money;
    return synchronizeCustomMoney({...pos,revision:pos.revision+1,money:{...state,
      settlements:[...state.settlements,...effects.settlements.map(s=>({...s,sourceSnapshot:{sourceRef:s.sourceRef,purpose:'custom_order' as const,memberId:s.memberId,amountDue:s.amount,fingerprint:s.settlementId,lines:[],orderIds:[],paymentTiming:s.paymentTiming}}))],
      payments:[...state.payments,...effects.payments],recognitions:[...state.recognitions,...effects.recognitions],
      corrections:[...state.corrections,...effects.corrections.map(c=>({...c,kind:c.kind==='cancellation'?'cancel' as const:'refund' as const,originalAllocationEffects:state.settlements.find(s=>s.settlementId===c.settlementId)?.allocations.map(a=>({allocationId:a.allocationId!,amount:Math.floor(c.amount*a.amount/(state.settlements.find(s=>s.settlementId===c.settlementId)?.amount??1))}))??[],accountEffects:[],membershipEffects:[],lineEffects:[]}))]}});
  }
  if (![effects.settlements, effects.payments, effects.recognitions, effects.corrections].some(rows => rows.length)) return pos;
  return { ...pos, revision: pos.revision + 1, customSettlements: [...(pos.customSettlements ?? []), ...effects.settlements],
    customPayments: [...(pos.customPayments ?? []), ...effects.payments], customRecognitions: [...(pos.customRecognitions ?? []), ...effects.recognitions], customCorrections: [...(pos.customCorrections ?? []), ...effects.corrections] };
}
export function customTables(tables: DataTables, plan: Extract<CustomPlanResult, {ok:true}>): DataTables {
  return { ...tables, customTemplate: plan.tables.customTemplate, customOrder: plan.tables.customOrder,
    reservation: plan.tables.reservation as DataTables['reservation'], appliedKeys: plan.tables.appliedKeys ?? tables.appliedKeys };
}
/** Sales follow handover; real-method deposits follow approval/return, independently. */
export function selectM2DayTotals(pos: PosState, scenario: 'normal' | 'empty' = 'normal') {
  const base = selectPosDayTotals(scenario === 'empty' ? { ...pos, bills: [], payments: [], refunds: [], cancellations: [] } : pos);
  if (pos.money) {
    const state = scenario === 'empty' ? emptyMoneyState() : pos.money;
    const read = { runId:'',revision:pos.revision,generation:0,businessDate:pos.businessDate,now:businessNow(),scenario:'normal',dayClosed:false,state,members:[],products:[],sources:[],drawer:pos.drawer } as const;
    const day = selectAccountingDay(read,{date:pos.businessDate});
    return {...base,gross:day.sales.gross,discount:day.sales.discount,discountBySource:day.discountBySource,refund:day.sales.refund,revenue:day.sales.total,charged:day.deposits.grossReceived,
      paymentCount:day.realPaymentCount,refundCount:state.corrections.filter(c=>c.kind==='refund'&&c.at.startsWith(pos.businessDate)).length,cancelCount:state.corrections.filter(c=>c.kind==='cancel'&&c.at.startsWith(pos.businessDate)).length,
      byMethod:day.sales.byRealMethodSale,methodCounts:base.methodCounts,
      customPickup:day.sales.customPickup,deposits:day.deposits,pendingReceived:day.deposits.pendingReceived};
  }
  const date = pos.businessDate;
  const recognition = scenario === 'empty' ? [] : (pos.customRecognitions ?? []).filter(r => r.businessDate === date);
  const payments = scenario === 'empty' ? [] : (pos.customPayments ?? []).filter(r => r.at.startsWith(date));
  const corrections = scenario === 'empty' ? [] : (pos.customCorrections ?? []).filter(r => r.at.startsWith(date));
  const customPickup = recognition.reduce((n,r) => n+r.amount,0);
  const customGross = recognition.reduce((n,r) => n+Math.max(0,r.amount),0);
  const customRefund = -recognition.reduce((n,r) => n+Math.min(0,r.amount),0);
  const depositsByMethod = {card:0,easy_pay:0,cash:0};
  if(scenario!=='empty') {
    for(const payment of pos.payments)for(const split of payment.splits)depositsByMethod[split.method]+=split.amount;
    for(const correction of [...pos.cancellations,...pos.refunds])for(const split of correction.methodAmounts)depositsByMethod[split.method]-=split.amount;
  }
  for (const p of payments) for (const split of p.splits) depositsByMethod[split.method] += split.amount;
  for (const c of corrections) for (const split of c.realMethodReturns) depositsByMethod[split.method] -= split.amount;
  const byMethod = { ...base.byMethod };
  for (const r of recognition) {
    const settlement = pos.customSettlements?.find(s => s.sourceRef.id === r.sourceId);
    const correction = pos.customCorrections?.find(c=>c.recognitionEffects.some(effect=>effect.recognitionId===r.recognitionId));
    const splits = r.amount < 0 && correction ? correction.realMethodReturns : settlement?.allocations ?? [];
    const allocations = allocatePosAmount(Math.abs(r.amount), splits.map(s => ({ id:s.method, amount:s.amount })));
    for (const s of splits) byMethod[s.method] += (allocations[s.method] ?? 0) * Math.sign(r.amount);
  }
  return { ...base, gross: base.gross+customGross, refund: base.refund+customRefund, revenue: base.revenue+customPickup, byMethod,
    paymentCount: base.paymentCount+payments.length, refundCount: base.refundCount+corrections.filter(c=>c.kind==='refund').length,
    methodCounts: {card:base.methodCounts.card+payments.filter(p=>p.splits.some(s=>s.method==='card')).length,easy_pay:base.methodCounts.easy_pay+payments.filter(p=>p.splits.some(s=>s.method==='easy_pay')).length,cash:base.methodCounts.cash+payments.filter(p=>p.splits.some(s=>s.method==='cash')).length},
    customPickup, deposits: { total: Object.values(depositsByMethod).reduce((n,v)=>n+v,0), byMethod: depositsByMethod } };
}
/** Reuses the menu drawer and adds only custom cash receipts/returns. */
export function selectM2Drawer(pos: PosState, scenario: 'normal' | 'empty' = 'normal') {
  if(pos.money)return selectAccountingDrawer({runId:'',revision:pos.revision,generation:0,businessDate:pos.businessDate,now:businessNow(),scenario:'normal',dayClosed:false,state:scenario==='empty'?emptyMoneyState():pos.money,members:[],products:[],sources:[],drawer:pos.drawer});
  const drawer = selectPosDrawer(pos, scenario), totals = selectM2DayTotals(pos, scenario);
  const customApproved = scenario === 'empty' ? 0 : (pos.customPayments ?? []).filter(p=>p.at.startsWith(pos.businessDate)).flatMap(p=>p.splits).filter(s=>s.method==='cash').reduce((n,s)=>n+s.amount,0);
  const returns = scenario === 'empty' ? [] : (pos.customCorrections ?? []).filter(c=>c.at.startsWith(pos.businessDate));
  const canceled=returns.filter(c=>c.kind==='cancellation').flatMap(c=>c.realMethodReturns).filter(s=>s.method==='cash').reduce((n,s)=>n+s.amount,0);
  const refunded=returns.filter(c=>c.kind==='refund').flatMap(c=>c.realMethodReturns).filter(s=>s.method==='cash').reduce((n,s)=>n+s.amount,0);
  const customCash = totals.deposits.byMethod.cash - selectPosDayTotals(scenario === 'empty' ? { ...pos, bills: [], payments: [], refunds: [], cancellations: [] } : pos).byMethod.cash;
  return { ...drawer, approvedCash:drawer.approvedCash+customApproved,cashPayments:drawer.cashPayments+customApproved,cashCanceled:drawer.cashCanceled+canceled,cashRefunded:drawer.cashRefunded+refunded,cashReturned:drawer.cashReturned+canceled+refunded, cashNet: drawer.cashNet+customCash, expected: drawer.expected+customCash,
    difference: drawer.actual === null ? null : drawer.actual-(drawer.expected+customCash) };
}

/** Base adapter avoids recursive member/POS joins; all balances stay in the money source. */
export function moneyReadBase(snapshot:DataSnapshot,scenario:MoneyRead['scenario']='normal'):MoneyRead {
  const pos=snapshot.pos, t=snapshot.tables,date=pos?.businessDate??TODAY;
  const closing=t.dayClosing.filter(c=>c.businessDate===date&&c.scenario==='normal').at(-1);
  return {runId:snapshot.runId??'run',revision:snapshot.revision,generation:closing?.generation??0,businessDate:date,now:businessNow(),scenario,dayClosed:closing?.status==='closed',state:pos?canonicalPosMoney(pos)??emptyMoneyState():emptyMoneyState(),sources:[],
    members:t.memberProfile.flatMap(p=>{const c=t.marketing.mktCustomer.find(c=>c.customerId===p.customerId&&!c.deletedAt&&c.variant===null);if(!c)return [];const masked=maskCustomer(c);return [{memberId:p.memberId,name:typeof masked.name==='string'?masked.name:'예시 회원',phone:masked.phone}];}),
    products:membershipProducts,drawer:pos?.drawer,expenses:t.expense.filter(e=>e.businessDate===date&&e.status==='confirmed').reduce((n,e)=>n+e.amount,0)};
}
const moneyReadCache=new WeakMap<DataSnapshot,Map<string,MoneyRead>>();
export function selectMoneyRead(snapshot:DataSnapshot,scenario:MoneyRead['scenario']='normal'):MoneyRead {
  let variants=moneyReadCache.get(snapshot);if(!variants)moneyReadCache.set(snapshot,variants=new Map());const hit=variants.get(scenario);if(hit)return hit;
  const base=moneyReadBase(snapshot,scenario),pos=snapshot.pos;
  const sources:MoneySource[]=[];
  if(pos){
    const read={runId:base.runId,runRevision:snapshot.revision,pos,posRevision:pos.revision,posUi:{tab:'order' as const,approval:null,cartUndo:null},dataRevision:snapshot.revision,settings:snapshot.tables.shopSettings,scenario,data:selectPosDataRead(snapshot)};
    const live=new Set(pos.bills.filter(b=>['open','partial'].includes(b.status)).map(b=>b.billId));live.add(getPaymentBillId(read));
    for(const id of live){
      let source=adaptPosSettlementSource(read,id,base.now);const bill=pos.bills.find(b=>b.billId===id),contributions:NonNullable<MoneySource['membershipContributions']>[number][]=[];
      if(bill?.splitPlan){const quote=quotePaymentBill(read,id,base.now),additions=new Map<string,number>();
        for(const d of quote.discounts.filter(d=>d.source==='membership')){const part=quote.parts.find(p=>!p.lineQtyAllocations||p.lineQtyAllocations.some(a=>a.allocationId===(d.allocationId??d.targetAllocationIds?.[0])&&a.qty>0));if(part)additions.set(part.partId,(additions.get(part.partId)??0)+d.amount);}
        source={...source,parts:quote.parts.map(p=>({partId:p.partId,amount:p.amount+(additions.get(p.partId)??0),...(p.lineQtyAllocations?{allocationIds:p.lineQtyAllocations.map(a=>a.allocationId)}:{})}))};
      }
      for(const discount of bill?.discounts.filter(d=>d.source==='membership'&&d.fixedAllocations&&d.membershipId&&d.useId)??[]){
        const terms=base.state.memberships.find(m=>m.membershipId===discount.membershipId);if(!terms)continue;
        const fragments=pos.bills.flatMap(b=>b.discounts.filter(d=>d.useId===discount.useId).flatMap(d=>(d.fixedAllocations??[]).map(a=>({id:`${b.billId}:${a.allocationId}`,amount:a.amount}))));
        const uses=(terms.openingUses ?? 0)+base.state.uses.filter(u=>u.membershipId===terms.membershipId&&!u.canceledAt&&u.useId!==discount.useId).length;
        const scheduled=terms.kind==='count'?Math.floor(terms.soldPrice/terms.totalUses!)+(uses===terms.totalUses!-1?terms.soldPrice%terms.totalUses!:0):0;
        const recognized=distributePosAmount(scheduled,fragments);
        for(const a of discount.fixedAllocations??[])if(source.lines.some(l=>l.allocationId===a.allocationId))contributions.push({useId:discount.useId!,membershipId:terms.membershipId,allocationId:a.allocationId,quantity:1,recognizedAmount:recognized[`${id}:${a.allocationId}`],membershipDiscount:a.amount});
      }
      sources.push(contributions.length?{...source,membershipContributions:contributions}:source);
    }
    for(const s of base.state.settlements){
      if(s.purpose!=='sale'||!s.sourceSnapshot||sources.some(o=>o.sourceRef.id===s.sourceRef.id))continue;
      const lines=s.sourceSnapshot.lines.map(l=>{const order=pos.orders.find(o=>o.lines.some(line=>line.orderLineId===l.orderLineId));return {...l,name:l.name??order?.lines.find(line=>line.orderLineId===l.orderLineId)?.nameAtOrder,prepared:order?order.preparation!=='accepted':s.sourceSnapshot!.prepared??false};});
      const prepared=lines.some(l=>l.prepared);
      sources.push({...s.sourceSnapshot,lines,prepared,wholeBillDiscount:pos.bills.find(b=>b.billId===s.billId)?.discounts.some(d=>d.scope==='bill')??s.sourceSnapshot.wholeBillDiscount});
    }
    for(const order of snapshot.tables.customOrder){
      const valid=order.customerDecision==='approved'&&order.approvedQuoteRevision===order.quoteRevision&&order.stage!=='canceled';
      sources.push({sourceRef:{kind:'custom_order',id:order.customOrderId},purpose:'custom_order',memberId:order.memberId,amountDue:order.quoteAmount??0,fingerprint:JSON.stringify(order),lines:[],orderIds:[],paymentTiming:order.paymentTiming,canSubmit:valid,issues:valid?[]:[{ok:false,code:'CONFLICT',reason:'QUOTE_CHANGED',messageKey:'data.custom.error.QUOTE_CHANGED'}]});
    }
  }
  const read=deepFreeze({...base,sources});variants.set(scenario,read);return read;
}
export interface AccountingTransactionRead {
  readonly id:string;readonly at:string;readonly purpose:import('../iteration7/accounting/types').SettlementPurpose;readonly kind:'receipt'|'cancel'|'refund';readonly amount:number;readonly salesAmount:number;
  readonly methods:readonly {readonly method:import('../iteration7/accounting/types').RealMethod;readonly amount:number}[];
  readonly settlementKinds:readonly ('charge'|'receivable'|'membership_count'|'membership_period')[];readonly settlementId:string;readonly paymentId?:string;readonly originalId?:string;readonly sourceRef?:{readonly kind:string;readonly id:string};
}
export type AccountingViewRead={
  readonly status:'ready';readonly period:{readonly start:string;readonly end:string};readonly summary:import('../iteration7/accounting/types').AccountingDay;
  readonly transactions:readonly AccountingTransactionRead[];readonly drawer?:ReturnType<typeof selectAccountingDrawer>;
  readonly unknownCostSales?:import('../iteration7/accounting/types').AccountingDay['unknownCostSales'];
  readonly legacySales?:number;
  readonly depositCoverage?:{readonly start:string;readonly end:string;readonly complete:boolean};
}|{readonly status:'loading'|'empty'|'error'|'unavailable';readonly period:{readonly start:string;readonly end:string}};
const accountingViews=new WeakMap<DataSnapshot,{readonly views:readonly AccountingViewRead[];readonly history:readonly AccountingViewRead[]}>();
export function selectAccountingPresentation(snapshot:DataSnapshot){
  const hit=accountingViews.get(snapshot);if(hit)return hit;const read=selectMoneyRead(snapshot),date=read.businessDate;
  const transactions:AccountingTransactionRead[]=read.state.settlements.map(s=>{const payment=read.state.payments.find(p=>p.settlementId===s.settlementId);return {id:s.settlementId,at:s.at,purpose:s.purpose,kind:'receipt',amount:payment?.amount??0,salesAmount:read.state.recognitions.filter(r=>r.settlementId===s.settlementId&&!r.originalRecognitionId).reduce((n,r)=>n+r.amount,0),methods:payment?.splits??[],settlementKinds:[...new Set(s.allocations.flatMap(a=>a.kind==='method'?[]:[a.kind]))],settlementId:s.settlementId,...(payment?{paymentId:payment.paymentId}:{}),sourceRef:s.sourceRef};});
  for(const c of read.state.corrections){const s=read.state.settlements.find(s=>s.settlementId===c.settlementId)!;const p=read.state.payments.find(p=>p.settlementId===s.settlementId);transactions.push({id:c.correctionId,at:c.at,purpose:s.purpose,kind:c.kind,amount:-c.realMethodReturns.reduce((n,m)=>n+m.amount,0),salesAmount:c.recognitionEffects.reduce((n,r)=>n+r.amount,0),methods:c.realMethodReturns.map(m=>({...m,amount:-m.amount})),settlementKinds:[...new Set(s.allocations.flatMap(a=>a.kind==='method'?[]:[a.kind]))],settlementId:s.settlementId,paymentId:p?.paymentId,originalId:s.settlementId,sourceRef:s.sourceRef});}
  const month={start:date.slice(0,7)+'-01',end:date};
  const historical = read.businessDate === seedToday.pos.businessDate ? seedHistory.days : [];
  const view = (period: { start: string; end: string }): AccountingViewRead => {
    const expenses = snapshot.tables.expense.filter(e => e.status === 'confirmed' && e.businessDate >= period.start && e.businessDate <= period.end).reduce((n, e) => n + e.amount, 0);
    const current = selectAccountingPeriod({ ...read, expenses }, period);
    const rows = historical.filter(r => r.date >= period.start && r.date <= period.end);
    const sum = (get: (r: typeof seedHistory.comparison) => number) => rows.reduce((n, r) => n + get(r), 0);
    const net = sum(r => r.net);
    const byMethod = {
      card: sum(r => r.byMethod.card), cash: sum(r => r.byMethod.cash), easy_pay: sum(r => r.byMethod.easy_pay),
    };
    const methodsWith = (existing: typeof byMethod) => ({
      card: existing.card + byMethod.card, cash: existing.cash + byMethod.cash, easy_pay: existing.easy_pay + byMethod.easy_pay,
    });
    const discountBySource = {
      direct: current.discountBySource.direct + sum(r => r.discountBySource.direct),
      coupon: current.discountBySource.coupon + sum(r => r.discountBySource.coupon),
      membership: current.discountBySource.membership + sum(r => r.discountBySource.membership),
    };
    const total = current.sales.total + net;
    const deposits = current.deposits;
    const importedReturns = sum(r => r.refund + r.canceled);
    const includesToday = date >= period.start && date <= period.end;
    const complete = rows.length + Number(includesToday) === Math.round((Date.parse(period.end) - Date.parse(period.start)) / 86_400_000) + 1;
    const summary = {
      ...current, discountBySource,
      sales: { ...current.sales, total, discountBySource, byRealMethodSale: methodsWith(current.sales.byRealMethodSale),
        gross: current.sales.gross + sum(r => r.gross), discount: current.sales.discount + sum(r => r.discount), refund: current.sales.refund + sum(r => r.refund) },
      deposits: { ...deposits, total: deposits.total + net, byMethod: methodsWith(deposits.byMethod), byPurpose: { ...deposits.byPurpose, sale: deposits.byPurpose.sale + net },
        returned: deposits.returned + importedReturns, grossReceived: deposits.grossReceived + net + importedReturns },
      orderCount: current.orderCount + sum(r => r.orders - r.cancelCount), realPaymentCount: current.realPaymentCount + sum(r => r.paymentCount - r.cancelCount),
      cost: current.cost + sum(r => r.cost), expenses, profit: total - expenses,
    };
    const isToday = period.start === date && period.end === date;
    return { status: 'ready', period, summary, transactions: transactions.filter(t => t.at.slice(0, 10) >= period.start && t.at.slice(0, 10) <= period.end),
      unknownCostSales: summary.unknownCostSales, ...(isToday ? { drawer: selectAccountingDrawer(read) } : { depositCoverage: { start: rows[0]?.date ?? date, end: includesToday ? date : rows.at(-1)?.date ?? date, complete } }) };
  };
  const views = [
    view({ start: date, end: date }), view(month), view({ start: addDays(date, -6), end: date }),
    view({ start: addDays(date, -29), end: date }), view({ start: LAST_MONTH_START, end: LAST_MONTH_END }),
  ];
  const history: AccountingViewRead[]=snapshot.tables.dayClosing.filter(c => c.scenario === 'normal' && c.status === 'closed').map(c => {
    const period = { start: c.businessDate, end: c.businessDate };
    if (!c.accountingSnapshot) return view(period);
    return { status: 'ready', period, summary: c.accountingSnapshot, transactions: [], drawer: c.drawerSnapshot, unknownCostSales: c.accountingSnapshot.unknownCostSales };
  });
  const value=deepFreeze({views,history});accountingViews.set(snapshot,value);return value;
}

export function moneySalesByMenu(pos:PosState):Readonly<Record<string,number>> {
  if(!pos.money)return selectPosSalesByMenu(pos);
  const quantities:Record<string,number>={};for(const r of pos.money.recognitions)if(r.menuId&&r.businessDate===pos.businessDate)quantities[r.menuId]=(quantities[r.menuId]??0)+(r.quantity??0);return quantities;
}
/** Commit the planner's source effects and POS order/stock publication in one reference. */
export function applyMoneyPlanToPos(read:import('../../contracts/pos').PosReadSnapshot,plan:Extract<MoneyPlan,{ok:true}>):PosState {
  let state=plan.nextState;
  let pos:PosState={...read.pos,money:state,revision:read.pos.revision+1};
  const completion=plan.value;
  const settlement=completion.settlementId?state.settlements.find(s=>s.settlementId===completion.settlementId):undefined;
  if(settlement?.purpose==='sale' && plan.effects.settlements.length){
    const billId=settlement.billId!,bill=paymentBill(read,billId)!,quote=quotePaymentBill(read,billId,state.attempt?.quote?read.pos.businessDate+'T15:45':businessNow());
    let orderIds=quote.orderIds,lines=quote.settlementLines,discounts=quote.discounts;
    const uses=state.uses.filter(u=>u.sourceRef.id===billId && !u.canceledAt);
    discounts=discounts.map(d=>d.source==='membership'?{...d,amount:uses.find(u=>u.membershipId===d.membershipId)?.membershipDiscount??d.amount,useId:uses.find(u=>u.membershipId===d.membershipId)?.useId??d.useId}:d);
    lines=lines.map(l=>({...l,discountAllocations:[...l.discountAllocations.filter(a=>quote.discounts.find(d=>d.discountId===a.discountId)?.source!=='membership'),...uses.filter(u=>u.coveredQuantities.some(c=>c.allocationId===l.allocationId)).map(u=>({discountId:discounts.find(d=>d.useId===u.useId)?.discountId??`money:${u.useId}`,amount:u.membershipDiscount}))]}));
    const remap=new Map<string,string>(),orderLineMap=new Map<string,string>();
    if(completion.settled && bill.cartId){
      const orderNo=nextOrderNumber(read.pos),orderId=`O-${String(orderNo).padStart(3,'0')}`;
      const order:import('../../contracts/pos').PosOrder={orderId,orderNo,originBillId:billId,orderedAt:businessNow(),seq:pos.seq+1,type:read.pos.cart.type,memo:read.pos.cart.memo,preparation:'accepted',preparedAt:null,completedAt:null,completedInRun:false,
        lines:quote.lines.map((l,i)=>{const orderLineId=`${orderId}:L-${i+1}`,allocationId=`${billId}:${orderLineId}`;remap.set(l.lineId,allocationId);orderLineMap.set(l.lineId,orderLineId);return {orderLineId,menuId:l.menuId,nameAtOrder:l.name,qty:l.qty,unitPriceAtOrder:l.unitPrice,optionsAtOrder:l.options.map(o=>({optionId:o.optionId,name:o.name,extraPrice:o.extraPrice,extraRecipe:o.extraRecipe})),request:l.request,canceledQty:0};})};
      orderIds=[orderId];pos={...pos,orders:[...pos.orders,order],billAllocations:[...pos.billAllocations,...order.lines.map((l,i)=>({billId,allocationId:remap.get(quote.lines[i].lineId)!,orderLineId:l.orderLineId,qty:l.qty}))]};
      const mapLine=(id:string)=>remap.get(id)??id;
      lines=lines.map(l=>({...l,allocationId:mapLine(l.allocationId)}));
      discounts=discounts.map(d=>({...d,...(d.allocationId?{allocationId:mapLine(d.allocationId)}:{}),...(d.targetAllocationIds?{targetAllocationIds:d.targetAllocationIds.map(mapLine)}:{}),...(d.fixedAllocations?{fixedAllocations:d.fixedAllocations.map(a=>({...a,allocationId:mapLine(a.allocationId)}))}:{})}));
      state={...state,settlements:state.settlements.map(s=>s.billId!==billId?s:{...s,allocations:s.allocations.map(a=>({...a,...(a.billAllocationId?{billAllocationId:mapLine(a.billAllocationId)}:{}),...(a.orderLineId?{orderLineId:orderLineMap.get(a.orderLineId)??a.orderLineId}:{})})),sourceSnapshot:s.sourceSnapshot?{...s.sourceSnapshot,orderIds,lines:s.sourceSnapshot.lines.map(l=>({...l,allocationId:mapLine(l.allocationId),orderLineId:orderLineMap.get(l.orderLineId)??l.orderLineId})),parts:s.sourceSnapshot.parts?.map(p=>({...p,allocationIds:p.allocationIds?.map(mapLine)}))}:undefined}),recognitions:state.recognitions.map(r=>r.sourceId!==billId?r:{...r,billAllocationId:r.billAllocationId?mapLine(r.billAllocationId):undefined,orderLineId:r.orderLineId?orderLineMap.get(r.orderLineId)??r.orderLineId:undefined}),uses:state.uses.map(u=>u.sourceRef.id!==billId?u:{...u,coveredQuantities:u.coveredQuantities.map(c=>({...c,allocationId:mapLine(c.allocationId)}))})};
    }
    const partPaid=(id:string)=>state.settlements.some(s=>s.billId===billId&&s.partId===id&&!state.corrections.some(c=>c.settlementId===s.settlementId&&c.amount===s.amount));
    const nextBill={...bill,discounts,settlementLines:completion.settled?lines:[],status:completion.settled?'paid' as const:'partial' as const,...(completion.settled?{recognizedAt:businessNow(),settledAt:businessNow()}:{}),...(bill.splitPlan?{splitPlan:{...bill.splitPlan,settlementLines:lines,parts:bill.splitPlan.parts.map(p=>({...p,status:partPaid(p.partId)?'paid' as const:'unpaid' as const,...(p.lineQtyAllocations?{lineQtyAllocations:p.lineQtyAllocations.map(a=>({...a,allocationId:remap.get(a.allocationId)??a.allocationId}))}:{})})),lines:bill.splitPlan.lines.map(l=>({...l,lineId:remap.get(l.lineId)??l.lineId}))}}:{})};
    pos={...pos,money:state,seq:pos.seq+1,bills:[...pos.bills.filter(b=>b.billId!==billId),nextBill],cart:bill.cartId?completion.settled?{...pos.cart,revision:pos.cart.revision+1,lines:[],memo:'',lock:null}:{...pos.cart,revision:pos.cart.revision+1,lock:billId}:pos.cart,
      tableSessions:completion.settled&&bill.tableId?[...pos.tableSessions.filter(s=>s.tableId!==bill.tableId),{tableId:bill.tableId,billId,cleaning:true}]:pos.tableSessions};
    for(const payment of plan.effects.payments){const number=pos.payments.length+1;pos={...pos,payments:[...pos.payments,{...payment,billId,partId:settlement.partId??undefined,seq:pos.seq,transactionNo:`거래-${pos.businessDate.replaceAll('-','')}-${number}`,approvalNo:`예시-${number}`,countedMethod:payment.splits.reduce((a,b)=>a.amount>=b.amount?a:b).method,status:'paid',recognizedAt:completion.settled?businessNow():null}],receipts:[...pos.receipts,{paymentId:payment.paymentId,billId}]};}
    if(completion.settled)pos={...pos,payments:pos.payments.map(p=>p.billId===billId&&p.status==='paid'?{...p,recognizedAt:businessNow()}:p)};
  }
  // Quantity returns affect physical menu/recipe use only when the planner permits restoration.
  for(const correction of plan.effects.corrections){
    const original=state.settlements.find(s=>s.settlementId===correction.settlementId);if(original?.purpose!=='sale')continue;
    const billId=original.billId!;
    const canceled=correction.lineEffects.map(l=>({lineId:l.orderLineId,allocationId:l.allocationId,qty:-l.quantity,gross:-(correction.recognitionEffects.filter(r=>r.billAllocationId===l.allocationId).reduce((n,r)=>n+(r.gross??0),0)),discount:-(correction.recognitionEffects.filter(r=>r.billAllocationId===l.allocationId).reduce((n,r)=>n+Object.values(r.discountBySource??{}).reduce((n,d)=>n+d,0),0)),cost:-(correction.recognitionEffects.filter(r=>r.billAllocationId===l.allocationId).reduce((n,r)=>n+(r.cost??0),0))}));
    const payment=state.payments.find(p=>p.settlementId===original.settlementId);
    const fullyReturned=!!payment&&state.corrections.filter(c=>c.settlementId===original.settlementId).flatMap(c=>c.realMethodReturns).reduce((n,m)=>n+m.amount,0)>=payment.amount;
    if(fullyReturned)pos={...pos,cashReceipts:pos.cashReceipts.map(r=>r.paymentId===payment!.paymentId&&r.status==='issued'?{...r,status:'canceled' as const}:r)};
    pos={...pos,payments:pos.payments.map(p=>p.paymentId===payment?.paymentId&&correction.kind==='cancel'&&state.corrections.filter(c=>c.settlementId===original.settlementId).flatMap(c=>c.realMethodReturns).reduce((n,s)=>n+s.amount,0)>=p.amount?{...p,status:'canceled' as const}:p),seq:pos.seq+1,...(correction.kind==='cancel'?{cancellations:[...pos.cancellations,{cancellationId:correction.correctionId,paymentId:payment?.paymentId??original.settlementId,billId,at:correction.at,seq:pos.seq+1,amount:correction.amount,methodAmounts:correction.realMethodReturns,allocations:canceled,reason:'',restockRetail:canceled.length>0}]}:{refunds:[...pos.refunds,{refundId:correction.correctionId,paymentId:payment?.paymentId??original.settlementId,billId,at:correction.at,seq:pos.seq+1,amount:correction.amount,methodAmounts:correction.realMethodReturns,lineAmounts:[],reason:''}]}),orders:pos.orders.map(o=>({...o,lines:o.lines.map(l=>({...l,canceledQty:l.canceledQty+(canceled.find(c=>c.lineId===l.orderLineId)?.qty??0)}))}))};
  }
  return synchronizeCustomMoney(pos);
}
import { paymentBill, quotePaymentBill } from '../../pos/loyalty/selectors';
import { nextOrderNumber } from '../../pos/tables/commands';

/** Read adapters only: custom lifecycle retains its M2 shape while money lives in pos.money. */
export function synchronizeCustomMoney(pos:PosState):PosState {
  if(!pos.money)return pos;const state=pos.money;
  const settlements=state.settlements.filter(s=>s.purpose==='custom_order').map(s=>({...s,purpose:'custom_order' as const,sourceRef:{kind:'custom_order' as const,id:s.sourceRef.id},billId:null,partId:null,allocations:s.allocations.flatMap(a=>a.kind==='method'&&a.method?[{allocationId:a.allocationId,kind:'method' as const,method:a.method,amount:a.amount}]:[]),paymentTiming:s.sourceSnapshot?.paymentTiming??'advance' as const}));
  const ids=new Set(settlements.map(s=>s.settlementId));
  const recognitions=state.recognitions.filter((r):r is SalesRecognition&{source:'custom_pickup';cost:null;settlementCategory:'custom_pickup'}=>r.source==='custom_pickup');
  return {...pos,customSettlements:settlements,customPayments:state.payments.filter(p=>ids.has(p.settlementId)).map(p=>({...p,purpose:'custom_order',sourceRef:{kind:'custom_order',id:p.sourceRef.id}})),customRecognitions:recognitions,
    customCorrections:state.corrections.filter(c=>ids.has(c.settlementId)).map(c=>({...c,customOrderId:settlements.find(s=>s.settlementId===c.settlementId)!.sourceRef.id,kind:c.kind==='cancel'?'cancellation':'refund',recognitionEffects:c.recognitionEffects.filter((r):r is typeof recognitions[number]=>r.source==='custom_pickup')}))};
}
