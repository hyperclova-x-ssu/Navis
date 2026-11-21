import type { PosDayTotals, PosMethod, PosMethodSplit, PosState } from '../../contracts/pos';
import { selectAccountingDay } from '../../data/iteration7/accounting/selectors';
import { money } from './common';

/** Largest remainder, ties by stable line ID. Used to normalize fixture discounts. */
export function allocatePosAmount(amount: number, weights: readonly { readonly id: string; readonly amount: number }[]): Readonly<Record<string, number>> {
  if (!money(amount) || weights.some(w => !money(w.amount)) || new Set(weights.map(w => w.id)).size !== weights.length) throw new Error('INVALID_AMOUNT');
  const total = weights.reduce((n, w) => n + BigInt(w.amount), 0n);
  if (BigInt(amount) > total) throw new Error('DISCOUNT_EXCEEDS_GROSS');
  return distributePosAmount(amount, weights);
}
/** General proportional allocation, including amounts larger than quantity weights. */
export function distributePosAmount(amount: number, weights: readonly { readonly id: string; readonly amount: number }[]): Readonly<Record<string, number>> {
  if (!money(amount) || weights.some(w => !money(w.amount)) || new Set(weights.map(w => w.id)).size !== weights.length) throw new Error('INVALID_AMOUNT');
  const total = weights.reduce((n, w) => n + BigInt(w.amount), 0n);
  if (!total && amount) throw new Error('INVALID_AMOUNT');
  if (total === 0n) return Object.fromEntries(weights.map(w => [w.id, 0]));
  const rows = weights.map(w => {
    const product = BigInt(amount) * BigInt(w.amount);
    return { id: w.id, amount: Number(product / total), remainder: product % total };
  });
  let left = amount - rows.reduce((n, w) => n + w.amount, 0);
  rows.sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
  for (const row of rows) if (left-- > 0) row.amount++;
  return Object.fromEntries(rows.map(w => [w.id, w.amount]));
}
export function countedPosMethod(splits: readonly PosMethodSplit[]): PosMethod {
  const order: readonly PosMethod[] = ['card', 'easy_pay', 'cash'];
  return [...splits].sort((a, b) => b.amount - a.amount || order.indexOf(a.method) - order.indexOf(b.method))[0].method;
}
export function selectPosSalesByMenu(pos: PosState): Readonly<Record<string, number>> {
  if(pos.money){const rows:Record<string,number>={};for(const r of canonicalPosMoney(pos)!.recognitions)if(r.menuId&&r.businessDate===pos.businessDate)rows[r.menuId]=(rows[r.menuId]??0)+(r.quantity??0);return rows;}

  const result: Record<string, number> = {};
  for (const bill of pos.bills) if (bill.status === 'paid' && bill.recognizedAt) {
    for (const line of bill.settlementLines) result[line.menuId] = (result[line.menuId] ?? 0) + line.recognizedQty;
    for (const row of pos.cancellations.filter(c => c.billId === bill.billId)) for (const a of row.allocations) {
      const menuId = bill.settlementLines.find(l => a.allocationId ? l.allocationId === a.allocationId : pos.billAllocations.some(x => x.allocationId === l.allocationId && x.orderLineId === a.lineId))?.menuId;
      if (menuId) result[menuId] -= a.qty;
    }
  }
  return result;
}
/** Reads the ledger, never its fixture checksum or a separately cached today total. */
export function selectPosDayTotals(pos: PosState): PosDayTotals {
  if(pos.money){
    const state=canonicalPosMoney(pos)!,date=pos.businessDate,day=selectAccountingDay({runId:'',revision:pos.revision,generation:0,businessDate:date,now:date+'T15:45',scenario:'normal',dayClosed:false,state,members:[],products:[],sources:[]},{date});
    const corrections=state.corrections.filter(c=>c.at.startsWith(date));
    const methodCounts={card:0,easy_pay:0,cash:0};for(const p of state.payments.filter(p=>p.at.startsWith(date)&&p.amount>state.corrections.filter(c=>c.settlementId===p.settlementId&&c.kind==='cancel').flatMap(c=>c.realMethodReturns).reduce((n,s)=>n+s.amount,0)))methodCounts[countedPosMethod(p.splits)]++;
    const canceled=corrections.filter(c=>c.kind==='cancel').reduce((n,c)=>n+c.realMethodReturns.reduce((n,s)=>n+s.amount,0),0);
    return {gross:day.sales.gross,discount:day.sales.discount,discountBySource:day.discountBySource,charged:day.deposits.grossReceived-canceled,refund:day.sales.refund,canceled,revenue:day.sales.total,paymentCount:day.realPaymentCount,refundCount:corrections.filter(c=>c.kind==='refund').length,cancelCount:corrections.filter(c=>c.kind==='cancel').length,byMethod:day.sales.byRealMethodSale,methodCounts,pendingReceived:day.deposits.pendingReceived,pendingBillCount:pos.bills.filter(b=>b.status==='open'||b.status==='partial').length};
  }

  let gross = 0, discount = 0, charged = 0, refund = 0, canceled = 0, paymentCount = 0, pendingReceived = 0;
  const discountBySource = { direct: 0, coupon: 0, membership: 0 };
  const byMethod = { card: 0, easy_pay: 0, cash: 0 }, methodCounts = { card: 0, easy_pay: 0, cash: 0 };
  const recognized = new Set(pos.bills.filter(b => b.status === 'paid' && b.recognizedAt).map(b => b.billId));
  for (const bill of pos.bills) if (recognized.has(bill.billId)) {
    for (const line of bill.settlementLines) gross += (line.basePriceAtSale + line.optionPriceAtSale) * line.recognizedQty;
    for (const d of bill.discounts) { discount += d.amount; discountBySource[d.source] += d.amount; }
  }
  for (const payment of pos.payments) {
    if (!recognized.has(payment.billId) || !payment.recognizedAt) { if (payment.status === 'paid') pendingReceived += payment.amount; continue; }
    charged += payment.amount;
    if (payment.status === 'paid') { paymentCount++; methodCounts[payment.countedMethod]++; }
    for (const split of payment.splits) byMethod[split.method] += split.amount;
  }
  for (const row of pos.refunds) if (recognized.has(row.billId)) {
    refund += row.amount;
    for (const split of row.methodAmounts) byMethod[split.method] -= split.amount;
  }
  for (const row of pos.cancellations) if (recognized.has(row.billId) && pos.payments.some(p => p.paymentId === row.paymentId && p.recognizedAt)) {
    canceled += row.amount; charged -= row.amount;
    for (const split of row.methodAmounts) byMethod[split.method] -= split.amount;
    for (const allocation of row.allocations) {
      gross -= allocation.gross; discount -= allocation.discount;
      for (const d of allocation.discountAllocations ?? []) {
        const source = pos.bills.find(b => b.billId === row.billId)?.discounts.find(x => x.discountId === d.discountId)?.source;
        if (source) discountBySource[source] -= d.amount;
      }
    }
  }
  return { gross, discount, discountBySource, charged, refund, canceled, revenue: gross - discount - refund,
    paymentCount, refundCount: pos.refunds.filter(r => recognized.has(r.billId)).length, cancelCount: pos.cancellations.length,
    byMethod, methodCounts, pendingReceived, pendingBillCount: pos.bills.filter(b => b.status === 'open' || b.status === 'partial').length };
}

/** Read-only normalization for retained low-level POS callers that have no session coordinator.
 * Each original payment/correction is included once; application commands persist the same events.
 */
export function canonicalPosMoney(pos:PosState):import('../../data/iteration7/accounting/types').MoneyState|undefined {
  const original=pos.money;if(!original)return;
  const payments=pos.payments.filter(p=>!original.payments.some(m=>m.paymentId===p.paymentId&&m.sourceRef.id===p.billId));
  const returns=[...pos.cancellations.map(c=>({id:c.cancellationId,row:c,kind:'cancel' as const})),...pos.refunds.map(c=>({id:c.refundId,row:c,kind:'refund' as const}))].filter(c=>!original.corrections.some(r=>r.correctionId===c.id||r.correctionId.endsWith(`:legacy-return:${c.id}`)));
  if(!payments.length&&!returns.length)return original;
  const state={...original,settlements:[...original.settlements],payments:[...original.payments],recognitions:[...original.recognitions],corrections:[...original.corrections]};
  for(const p of payments){
    const bill=pos.bills.find(b=>b.billId===p.billId)!;const lines=bill.settlementLines.length?bill.settlementLines:bill.splitPlan?.settlementLines??[];
    const source={purpose:'sale' as const,sourceRef:{kind:'bill',id:p.billId},billId:p.billId,memberId:bill.memberId??null,amountDue:lines.reduce((n,l)=>n+l.qty*(l.basePriceAtSale+l.optionPriceAtSale)-l.discountAllocations.reduce((n,d)=>n+d.amount,0),0),fingerprint:p.paymentId,orderIds:pos.orders.filter(o=>o.originBillId===bill.billId).map(o=>o.orderId),lines:lines.map(l=>({allocationId:l.allocationId,orderLineId:pos.billAllocations.find(a=>a.allocationId===l.allocationId)?.orderLineId??l.allocationId,menuId:l.menuId,quantity:l.qty,unitPrice:l.basePriceAtSale+l.optionPriceAtSale,unitCost:l.unitCostAtSale===null||l.optionCostAtSale===null?null:l.unitCostAtSale+l.optionCostAtSale}))};
    const id=`legacy:${p.paymentId}`;state.settlements.push({settlementId:id,purpose:'sale',sourceRef:source.sourceRef,billId:p.billId,partId:p.partId??null,memberId:bill.memberId??null,at:p.at,amount:p.amount,allocations:p.splits.map((s,i)=>({allocationId:`${id}:${i}`,kind:'method',...s})),status:'paid',sourceSnapshot:source});
    state.payments.push({paymentId:original.payments.some(m=>m.paymentId===p.paymentId)?`${p.billId}:${p.paymentId}`:p.paymentId,settlementId:id,purpose:'sale',sourceRef:source.sourceRef,at:p.at,amount:p.amount,splits:p.splits});
  }
  for(const bill of pos.bills.filter(b=>b.status==='paid'&&b.recognizedAt&&!state.recognitions.some(r=>r.sourceId===b.billId))){
    const shares=paymentSettlementShares(pos,bill);
    for(const share of shares){const payment=state.payments.find(p=>(p.paymentId===share.paymentId||p.paymentId===`${bill.billId}:${share.paymentId}`)&&p.sourceRef.id===bill.billId);if(!payment)continue;const settlement=state.settlements.find(s=>s.settlementId===payment.settlementId)!;
      const amounts=distributePosAmount(share.net,payment.splits.map((s,i)=>({id:String(i),amount:s.amount})));
      payment.splits.forEach((split,i)=>{const discountBySource={direct:0,coupon:0,membership:0};if(i===0)for(const a of share.discountAllocations){const d=bill.discounts.find(d=>d.discountId===a.discountId);if(d)discountBySource[d.source]+=a.amount;}
        state.recognitions.push({recognitionId:`legacy:${share.paymentId}:${share.allocationId}:${i}`,source:'menu',sourceId:bill.billId,businessDate:pos.businessDate,at:bill.recognizedAt!,amount:amounts[String(i)],cost:i?0:share.unitCost===null?null:share.unitCost*share.qty,settlementCategory:split.method,settlementId:payment.settlementId,settlementAllocationId:settlement.allocations[i].allocationId,menuId:share.menuId,orderLineId:share.orderLineId,billAllocationId:share.allocationId,quantity:i?0:share.qty,gross:i?0:share.gross,discountBySource,originalRecognitionId:null});});
    }
  }
  for(const {id,row,kind}of returns){
    const p=state.payments.find(p=>(p.paymentId===row.paymentId||p.paymentId===`${row.billId}:${row.paymentId}`)&&p.sourceRef.id===row.billId);if(!p)continue;
    const related=state.recognitions.filter(r=>r.settlementId===p.settlementId&&!r.originalRecognitionId);
    if(!related.length){state.corrections.push({correctionId:id,settlementId:p.settlementId,at:row.at,kind,amount:row.amount,realMethodReturns:row.methodAmounts,originalAllocationEffects:[],accountEffects:[],membershipEffects:[],recognitionEffects:[],lineEffects:[]});continue;}
    const weighted=distributePosAmount(row.amount,related.map(r=>({id:r.recognitionId,amount:Math.max(0,r.amount+state.recognitions.filter(c=>c.originalRecognitionId===r.recognitionId).reduce((n,c)=>n+c.amount,0))})));
    if(!related.length){state.corrections.push({correctionId:id,settlementId:p.settlementId,at:row.at,kind,amount:row.amount,realMethodReturns:row.methodAmounts,originalAllocationEffects:[],accountEffects:[],membershipEffects:[],recognitionEffects:[],lineEffects:[]});continue;}
    const effects=related.map(r=>{const selected=kind==='cancel'&&'allocations'in row?row.allocations.find(a=>a.allocationId===r.billAllocationId||a.lineId===r.orderLineId):undefined;
      return {...r,recognitionId:`legacy:${id}:${r.recognitionId}`,businessDate:pos.businessDate,at:row.at,amount:-weighted[r.recognitionId],quantity:selected?-(selected.qty*(r.quantity??0)/Math.max(1,related.filter(x=>x.billAllocationId===r.billAllocationId).reduce((n,x)=>n+(x.quantity??0),0))):0,gross:selected?-(selected.gross*(r.gross??0)/Math.max(1,related.filter(x=>x.billAllocationId===r.billAllocationId).reduce((n,x)=>n+(x.gross??0),0))):0,cost:selected&&r.cost!==null?-(selected.cost??0):0,discountBySource:kind==='cancel'&&selected?{direct:-(r.discountBySource?.direct??0),coupon:-(r.discountBySource?.coupon??0),membership:-(r.discountBySource?.membership??0)}:{direct:0,coupon:0,membership:0},originalRecognitionId:r.recognitionId};});
    state.recognitions.push(...effects);state.corrections.push({correctionId:id,settlementId:p.settlementId,at:row.at,kind,amount:row.amount,realMethodReturns:row.methodAmounts,originalAllocationEffects:[],accountEffects:[],membershipEffects:[],recognitionEffects:effects,lineEffects:[]});
  }
  return state;
}
import { paymentSettlementShares } from './settlement';
