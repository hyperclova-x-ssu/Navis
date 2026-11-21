import { useSyncExternalStore } from 'react';
import { useWidgetDataStore } from '../../../data/react';
import { deriveOpenOrders, TODAY } from '../../../data/widget-data';
import type { IngredientRow, InventoryModel, SuppliersModel } from '../../../data/widget-data';
import { useBundle } from '../../../i18n';
import { MiniTable, StatusChip } from '../../../ui';
import { Flash, byNearestDue, relativeDay, useSupplyText, type SupplyText } from './shared';

const bundle={id:'widget.mgmt-supply.mini',ko:{
  'supply.mini.stock':'원자재','supply.mini.name':'이름','supply.mini.stockQty':'현재 재고','supply.mini.safe':'안전 재고','supply.mini.status':'상태','supply.mini.used':'오늘 사용량',
  'supply.mini.orders':'발주 내역','supply.mini.date':'발주 일자','supply.mini.item':'발주 품목','supply.mini.qty':'주문 수량','supply.mini.due':'입고 예정일','supply.mini.orderStatus':'발주 상태',
  'supply.mini.sufficient':'충분','supply.mini.out':'품절','supply.mini.restock':'보충 필요','supply.mini.expiry':'당일 소진','supply.mini.pending':'입고 대기','supply.mini.partial':'일부 입고','supply.mini.complete':'입고 완료','supply.mini.canceled':'취소','supply.mini.issue':'입고 확인 필요',
  'supply.mini.summary':'발주 제안 {n}건 · 이번 달 발주 {amount}',
},en:{},'zh-Hans':{},'zh-Hant':{}};
export function orderedStock(model:InventoryModel,x:SupplyText):IngredientRow[]{
  const rank=(r:IngredientRow)=>r.trackExpiry?3:r.outOfStock?0:r.needsRestock?1:2;
  return [...model.ingredients].sort((a,b)=>rank(a)-rank(b)||(a.stock??0)/(a.threshold||Infinity)-(b.stock??0)/(b.threshold||Infinity)||x.text(a.name??{key:a.nameKey}).localeCompare(x.text(b.name??{key:b.nameKey}),'ko')||a.itemId.localeCompare(b.itemId));
}
/** These are the public kit MiniTable. The adapter supplies column drop priorities to useFit. */
export function StockMiniTable({model}:{model:InventoryModel}){
  const x=useSupplyText(),{t}=useBundle(bundle);
  return <div className="ms-mini" data-mini-columns="0,0,820,0,830" data-mini-row-priority="600"><MiniTable label={t('supply.mini.stock')} rows={orderedStock(model,x).slice(0,5)} getRowId={r=>r.itemId} columns={[
    {id:'name',label:t('supply.mini.name'),render:r=>x.text(r.name??{key:r.nameKey})},
    {id:'stock',label:t('supply.mini.stockQty'),numeric:true,render:r=><Flash value={r.stock}>{r.stock===null?'—':x.format.quantity(r.stock,r.unit)}</Flash>},
    {id:'safe',label:t('supply.mini.safe'),numeric:true,render:r=><Flash value={r.threshold}>{r.threshold===null?'—':x.format.quantity(r.threshold,r.unit)}</Flash>},
    {id:'status',label:t('supply.mini.status'),render:r=><Flash value={`${r.outOfStock}:${r.needsRestock}:${r.trackExpiry}`}><StatusChip tone={r.outOfStock?'danger':r.needsRestock?'warning':r.trackExpiry?'neutral':'success'}>{t(r.trackExpiry?'supply.mini.expiry':r.outOfStock?'supply.mini.out':r.needsRestock?'supply.mini.restock':'supply.mini.sufficient')}</StatusChip></Flash>},
    {id:'used',label:t('supply.mini.used'),numeric:true,render:r=><Flash value={r.usedToday}>{x.format.quantity(r.usedToday,r.unit)}</Flash>},
  ]}/></div>;
}
export function OrderMiniTable(){
  const store=useWidgetDataStore(),snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const x=useSupplyText(),{t}=useBundle(bundle);
  return <div className="ms-mini" data-mini-columns="820,0,830,0,0" data-mini-row-priority="600"><MiniTable label={t('supply.mini.orders')} rows={[...deriveOpenOrders(snapshot,{date:TODAY}).orders].sort(byNearestDue).slice(0,5)} getRowId={r=>r.poId} columns={[
    {id:'date',label:t('supply.mini.date'),render:r=>r.orderedOn?x.format.date(r.orderedOn,'short'):'—'},
    {id:'item',label:t('supply.mini.item'),render:r=>r.lines.map(l=>x.text(l.itemName??{key:l.itemNameKey})).join(' · ')},
    {id:'qty',label:t('supply.mini.qty'),numeric:true,render:r=>r.lines.map(l=>x.format.quantity(l.ordered,l.unit)).join(' · ')},
    {id:'due',label:t('supply.mini.due'),render:r=><Flash value={r.dueDate}>{relativeDay(x,r.dueDate)}</Flash>},
    {id:'status',label:t('supply.mini.orderStatus'),render:r=><Flash value={`${r.status}:${r.overdue}`}><StatusChip tone={r.overdue||r.status==='partial'?'warning':r.status==='complete'?'success':'neutral'}>{t(r.overdue?'supply.mini.issue':r.status==='scheduled'?'supply.mini.pending':r.status==='partial'?'supply.mini.partial':r.status==='complete'?'supply.mini.complete':'supply.mini.canceled')}</StatusChip></Flash>},
  ]}/></div>;
}
export function OrderPanelSummary({model}:{model:SuppliersModel}){
  const x=useSupplyText(),{t}=useBundle(bundle);
  return <p className="ms-caption" data-drop={900}><Flash value={[model.suggestions.length,model.monthTotal]}>{t('supply.mini.summary',{n:model.suggestions.length,amount:x.format.money(model.monthTotal,'full')})}</Flash></p>;
}
