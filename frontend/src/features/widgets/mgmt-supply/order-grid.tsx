import { useId, useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetDetailProps } from '../../../contracts';
import type { SupplierOrderForm } from '../../assistant/domains/suppliers';
import { useRealPort, useWidgetDataStore } from '../../../data/react';
import { isIsoDate } from '../../../data/db/time';
import { TODAY, deriveOpenOrders, deriveStock, deriveSuggestions, type SuppliersModel } from '../../../data/widget-data';
import { useBundle } from '../../../i18n';
import { ActionButton, AnchoredPopover, DateStepper, DataGrid, DetailTabs, FieldFrame, Icon, InlineForm, NumberField, QuantityStepper, Spinner, StatusChip, useKitT, type GridColumn, type GridFocus, type GridSort } from '../../../ui';
import { SupplierMessage } from './purchase-message';
import { PurchaseGrid, SupplierGrid } from './purchase-grid';
import { notifyPurchase, useFormClose, usePurchaseCommand, usePurchaseKey } from './purchase-grid.commands';
import { Flash, GridValueSlot, addIsoDays, byNearestDue, sortGridRows, unitLabel, useSupplyText, useTextScale, useViewMemory } from './shared';
type OrderRow = ReturnType<typeof deriveOpenOrders>['orders'][number];
const ko={'supply.order.orderAnyway':'그래도 발주하기','supply.order.suggestions':'발주 제안','supply.order.none':'지금 발주할 품목이 없어요','supply.order.covered':'모자란 품목은 이미 발주했어요 · 입고 대기 {n}건','supply.order.order':'발주하기','supply.order.items':'발주 품목','supply.order.suppliers':'발주사','supply.order.orders':'발주 내역','supply.order.date':'발주 일자','supply.order.item':'발주 품목','supply.order.qty':'주문 수량','supply.order.total':'총 주문 금액','supply.order.due':'입고 예정일','supply.order.remaining':'받은·남은 수량','supply.order.status':'발주 상태','supply.order.received':'받은 수량','supply.order.record':'입고 기록하기','supply.order.cancel':'발주 취소하기','supply.order.add':'발주 추가하기','supply.order.minimum':'최소 주문 수량','supply.order.price':'단가','supply.order.step':'주문 단위','supply.order.lead':'입고 예정','supply.order.contact':'담당','supply.order.phone':'연락처','supply.order.memo':'메모','supply.order.invalid':'0보다 큰 숫자를 넣어 주세요','supply.order.search':'발주 품목 이름으로 찾아보세요','supply.order.empty':'등록된 발주 내역이 없어요','supply.order.close':'닫기','supply.order.pending':'입고 대기','supply.order.partial':'일부 입고','supply.order.complete':'입고 완료','supply.order.canceled':'취소','supply.order.issue':'입고 확인 필요','supply.order.minimumError':'최소 {n}{unit}부터 주문할 수 있어요','supply.order.stepError':'{n}{unit} 단위로 주문해 주세요','supply.order.expected':'도착 예정','supply.order.maxReason':'남은 수량보다 많이 기록할 수 없어요','supply.order.noResults':'찾는 항목이 없어요','supply.order.changeDue':'{name} 입고 예정일 바꾸기','supply.order.day':'날짜'} as const;
const bundle={id:'widget.mgmt-supply.orders-v5',ko:{...ko,
 'supply.order.cancelPrompt':'남은 입고를 취소할까요?', 'supply.order.cancelConfirm':'발주 취소 확인',
 'supply.order.saving':'저장하는 중이에요', 'supply.order.saveOrder':'예정 발주 기록',
 },en:{'supply.order.cancelPrompt':'Cancel the outstanding delivery?', 'supply.order.cancelConfirm':'Confirm cancellation',
 'supply.order.saving':'Saving', 'supply.order.saveOrder':'Record planned order'},'zh-Hans':{},'zh-Hant':{}};
export function useOrderText(){return useBundle(bundle);}
/** One value per line, aligned across the item, quantity and received cells of a multi-item order (DS 12.1: never one joined, clipped string). */
function Lines({items,wrap=false}:{items:readonly string[];wrap?:boolean}){return <span className="ms-lines" data-wrap={wrap||undefined}>{items.map((text,i)=><span key={i}>{text}</span>)}</span>;}
function Receipt({order,host,reviewingMessage=false}:{order:OrderRow;host:WidgetDetailProps['host'];reviewingMessage?:boolean}){
 const x=useSupplyText(),{t}=useBundle(bundle),{run,pending}=usePurchaseCommand(),store=useWidgetDataStore();
 const line=order.lines.find(l=>l.remaining>0);
 const [qty,setQty]=useState(line?.remaining??0),[touched,setTouched]=useState(false);
 const key=usePurchaseKey('receipt');
 const [done,setDone]=useState(false),[error,setError]=useState('');
 const [cancelRevision,setCancelRevision]=useState<number>();
 const pressed=useRef(false);
 if(!line||!order.open)return null;
 const quantity=Math.min(qty,line.remaining);

 function recordReceipt(polId: string) {
  if(pressed.current)return;
  pressed.current=true;
  setError('');
  run({type:'suppliers.recordReceipt',polId,qty:quantity,idempotencyKey:key},result=>{
   if(result.ok){setDone(true);notifyPurchase(host,result,'data.notice.receiptRecorded');return;}
   pressed.current=false;
   setError(x.tk(result.messageKey));
  });
 }

 function cancelOrder() {
  if(store.getSnapshot().revision!==cancelRevision){
   setCancelRevision(undefined);
   setError(x.tk('data.real.error.STALE_REVISION'));
   return;
  }
  run({type:'suppliers.cancelOrder',poId:order.poId},result=>{
   setCancelRevision(undefined);
   if(result.ok)notifyPurchase(host,result,'data.notice.itemUpdated');
   else setError(x.tk(result.messageKey));
  });
 }

 return <div>
  <QuantityStepper label={t('supply.order.received')} value={quantity} onChange={v=>{setTouched(true);setQty(v);}} min={1} max={line.remaining} unit={unitLabel(x,line.unit)} maxReason={touched?t('supply.order.maxReason'):undefined} remaining={`${t('supply.order.remaining')} ${x.format.quantity(line.remaining,line.unit)}`}/>
  <ActionButton variant={reviewingMessage?'secondary':'default'} disabled={done||cancelRevision!==undefined||quantity<1} loading={pending&&cancelRevision===undefined} onClick={()=>recordReceipt(line.polId)}>{t('supply.order.record')}</ActionButton>
  {cancelRevision===undefined ? <ActionButton variant="ghost" disabled={pending} onClick={()=>{setError('');setCancelRevision(store.getSnapshot().revision);}}>{t('supply.order.cancel')}</ActionButton>
   : <div role="group" aria-label={t('supply.order.cancelConfirm')}>
    <p>{t('supply.order.cancelPrompt')}</p>
    <ActionButton variant="destructive" loading={pending} onClick={cancelOrder}>{t('supply.order.cancelConfirm')}</ActionButton>
    <ActionButton variant="secondary" disabled={pending} onClick={()=>setCancelRevision(undefined)}>{x.t('common.close')}</ActionButton>
   </div>}
  {error?<p role="alert">{error}</p>:null}
 </div>;
}
function minimumOrder(item: { minimumQty: number; orderStep: number }) {
 const steps = Math.max(1, Math.ceil(item.minimumQty / item.orderStep - 1e-9));
 return Number((steps * item.orderStep).toPrecision(15));
}

function AddOrder({purchaseItemId,qty:initial,dueDate,suggestionItemId,host,onClose}:{purchaseItemId:string;qty:number;dueDate?:string;suggestionItemId?:string;host:WidgetDetailProps['host'];onClose:()=>void}){
 const {t}=useBundle(bundle),x=useSupplyText(),kit=useKitT(),{http,pending,run}=usePurchaseCommand(),store=useWidgetDataStore();
 const itemField = useId();
 const [id,setId]=useState(purchaseItemId),[qty,setQty]=useState<number | null>(initial),[error,setError]=useState(''),[quantityError,setQuantityError]=useState(''),[again,setAgain]=useState(false);
 const snapshot=store.getSnapshot();
 const purchase=snapshot.tables.purchaseItem.find(p=>p.purchaseItemId===id),item=snapshot.tables.inventoryItem.find(i=>i.itemId===purchase?.itemId),unitCode=purchase?.purchaseUnit??item?.unit;
 const formatQuantity = (value: number) => unitCode ? x.format.quantity(value, unitCode) : x.format.number(value);
 const step = purchase?.orderStep ?? 1;
 const key=usePurchaseKey('order');
 const activeDueDate = id === purchaseItemId ? dueDate : undefined;
 const close=useFormClose(onClose);
 const clearDuplicate=()=>{setAgain(false);setError('');setQuantityError('');};
 const changeQuantity = (value: number | null) => { setQty(value); clearDuplicate(); };
 const submit=(confirmDuplicate:boolean)=>{
  if (!purchase) return;
  const n=qty ?? 0;
  if(!Number.isFinite(n)||n<=0){setQuantityError(t('supply.order.invalid'));return;}
  if(n<purchase.minimumQty){setQuantityError(t('supply.order.minimumError',{n:formatQuantity(purchase.minimumQty),unit:''}));return;}
  if(Math.abs(n/step-Math.round(n/step))>1e-9){setQuantityError(t('supply.order.stepError',{n:formatQuantity(step),unit:''}));return;}
  setError('');setQuantityError('');
  run({type:'suppliers.createOrder',purchaseItemId:id,qty:n,...(activeDueDate?{dueDate:activeDueDate}:{}),...(suggestionItemId&&id===purchaseItemId?{suggestionItemId}:{}),idempotencyKey:key,...(confirmDuplicate?{confirmDuplicate:true}:{})}, result=>{
   if(!result.ok){
    const message = x.tk(result.messageKey);
    if (result.field === 'qty' && result.reason !== 'LIKELY_DUPLICATE_ORDER') setQuantityError(message);
    else setError(message);
    setAgain(result.reason==='LIKELY_DUPLICATE_ORDER');return;
   }
   notifyPurchase(host,result,'data.notice.itemUpdated');close();
  });
 };
 const adjust = (delta: number) => changeQuantity(Math.max(0, Number(((qty ?? 0) + delta).toPrecision(15))));
 return <div ref={node=>{const form=node?.querySelector('form'); if(form)form.noValidate=true;}}><InlineForm title={t('supply.order.add')} onClose={close} closeLabel={t('supply.order.close')} saveLabel={http?t('supply.order.saveOrder'):x.t('common.saveAction')} saving={pending} saveDisabled={!purchase} onSave={()=>submit(false)}>
  <div className="ms-order-fields">
   <FieldFrame label={t('supply.order.item')} fieldId={itemField}>
    <select id={itemField} className="ui-text-input" value={id} disabled={pending} onChange={event=>{
     const next=snapshot.tables.purchaseItem.find(row=>row.purchaseItemId===event.currentTarget.value);
     if (next) { setId(next.purchaseItemId); changeQuantity(minimumOrder(next)); }
    }}>
     {snapshot.tables.purchaseItem.map(row=>{
      const stock=snapshot.tables.inventoryItem.find(candidate=>candidate.itemId===row.itemId);
      return <option value={row.purchaseItemId} key={row.purchaseItemId}>{stock?x.text(stock.name??{key:stock.nameKey}):row.itemId}</option>;
     })}
    </select>
   </FieldFrame>
   <div className="ms-order-quantity">
    <ActionButton variant="outline" size="icon" aria-label={kit.t('ui.quantity.decrease')} disabled={pending || (qty ?? 0) <= 0} onClick={()=>adjust(-step)}><Icon name="remove"/></ActionButton>
    <NumberField label={t('supply.order.qty')} value={qty} onValueChange={changeQuantity} disabled={pending} min={0} step={step} unit={unitCode?unitLabel(x,unitCode):undefined} error={quantityError || undefined}/>
    <ActionButton variant="outline" size="icon" aria-label={kit.t('ui.quantity.increase')} disabled={pending || !purchase} onClick={()=>adjust(step)}><Icon name="plus"/></ActionButton>
   </div>
  </div>
  {purchase?<>
   <p className="ms-caption">{t('supply.order.minimum')} {formatQuantity(purchase.minimumQty)} · {t('supply.order.step')} {formatQuantity(step)} · {t('supply.order.price')} {x.format.money(purchase.unitPrice,'full')}</p>
   <p>{t('supply.order.total')} {x.format.money(Math.round((qty ?? 0)*purchase.unitPrice),'full')} · {t('supply.order.expected')} {x.format.date(activeDueDate??addIsoDays(TODAY,purchase.leadDays),'short')}</p>
  </>:null}
  {error?<p className="ms-error" role="alert"><Icon name="error"/>{error}</p>:null}
  {again?<ActionButton variant="secondary" loading={pending} onClick={()=>submit(true)}>{t('supply.order.orderAnyway')}</ActionButton>:null}
 </InlineForm></div>;
}
function DueDateCell({order,host}:{order:OrderRow;host:WidgetDetailProps['host']}){
 const x=useSupplyText(),{t}=useBundle(bundle),{pending,run}=usePurchaseCommand(),anchor=useRef<HTMLButtonElement>(null),active=useRef(false);
 const [open,setOpen]=useState(false),[date,setDate]=useState(order.dueDate??TODAY),[error,setError]=useState('');
 const close=()=>{if(!active.current)return;active.current=false;setOpen(false);anchor.current?.closest<HTMLElement>('[role="gridcell"]')?.focus({preventScroll:true});};
 if(!order.open)return order.dueDate?(x.locale==='ko'?x.format.date(order.dueDate,'short'):order.dueDate):'—';
 return <><button ref={anchor} className="ms-order-due-date" type="button" disabled={pending} aria-label={t('supply.order.changeDue',{name:order.lines.map(l=>x.text(l.itemName??{key:l.itemNameKey})).join(' · ')})} onClick={event=>{event.stopPropagation();setDate(order.dueDate??TODAY);setError('');active.current=true;setOpen(true);}}>{order.dueDate?(x.locale==='ko'?x.format.date(order.dueDate,'short'):order.dueDate):'—'}</button>
 <AnchoredPopover open={open} anchorRef={anchor} onClose={close} focusOnOpen side="bottom" label={t('supply.order.due')}><div onClick={e=>e.stopPropagation()}><InlineForm title={t('supply.order.due')} onClose={close} saveLabel={x.t('common.saveAction')} closeLabel={x.t('common.close')} saving={pending} onSave={()=>{
 run({type:'suppliers.changeDueDate',poId:order.poId,date},result=>{
  if(!result.ok){if(active.current)setError(x.tk(result.messageKey));return;}
  notifyPurchase(host,result,'data.notice.dueDateChanged');close();
 });
 }}><DateStepper label={t('supply.order.due')} text={x.format.date(date,'long')} onPrevious={()=>setDate(addIsoDays(date,-1))} onNext={()=>setDate(addIsoDays(date,1))}/>{error?<p role="alert">{error}</p>:null}</InlineForm></div></AnchoredPopover></>;
}
export function OrderWorkspace({ model, host, initialTab, initialOrder, initialPurchaseItem, initialSupplier, initialSupplierAdd = false, initialOrderAdd = false, initialOrderForm }: {
 model: SuppliersModel; host: WidgetDetailProps['host']; initialTab?: 'orders' | 'items' | 'suppliers'; initialOrder?: string;
 initialPurchaseItem?: string; initialSupplier?: string; initialSupplierAdd?: boolean; initialOrderAdd?: boolean; initialOrderForm?: SupplierOrderForm;
}){
 const {t}=useBundle(bundle),x=useSupplyText(),{http,pending,run}=usePurchaseCommand(),store=useWidgetDataStore(),snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),scale=useTextScale();
 const transport=useRealPort()?.transport;
 const orderActions=(order:OrderRow)=>{
  if(!http||!transport)return <Receipt order={order} host={host}/>;
  const supplier=snapshot.tables.supplier.find(row=>row.supplierId===order.supplierId);
  const channels: ('sms'|'mail')[]=[];
  if(supplier?.phone && /^[0-9]{8,11}$/.test(supplier.phone.replace(/[- ]/g,'')))channels.push('sms');
  if(supplier?.contact && /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(x.text(supplier.contact).trim()))channels.push('mail');
  const reference=`PO-${order.poId.replaceAll('-','').slice(0,12).toUpperCase()}`;
  const copyText=[t('supply.order.order'), ...order.lines.map(line=>
   x.text(line.itemName??{key:line.itemNameKey})+' '+x.format.quantity(line.ordered,line.unit)),
   ...(order.dueDate?[t('supply.order.due')+' '+x.format.date(order.dueDate,'short')]:[]), reference].join('\n');
  return <SupplierMessage transport={transport} poId={order.poId} channels={channels}
    sendable={order.status==='scheduled'&&order.lines.length>0} copyText={copyText}
    beforeActions={reviewing=><Receipt order={order} host={host} reviewingMessage={reviewing}/>}/>;
 };
 const [dueError,setDueError]=useState<{rowId:string;columnId:string;error:{id:string;message:string}}>();
 const [tab,setTab]=useViewMemory<'orders'|'items'|'suppliers'>('orders.tab',()=>initialTab??(initialSupplierAdd?'suppliers':'orders')),[query,setQuery]=useViewMemory('orders.query',()=>''),[sort,setSort]=useViewMemory<GridSort>('orders.sort',()=>null),[focus,setFocus]=useViewMemory<GridFocus>('orders.focus',()=>null),[expanded,setExpanded]=useViewMemory<ReadonlySet<string>>('orders.expanded',()=>new Set(initialOrder?[initialOrder]:[])),[form,setForm]=useState<SupplierOrderForm|null>(()=>initialOrderForm??(initialOrderAdd?{id:store.getSnapshot().tables.purchaseItem[0]?.purchaseItemId??'',qty:1}:null));
 const suggestions=deriveSuggestions(snapshot,{date:TODAY});
 const restock=deriveStock(snapshot,{date:TODAY}).rows.filter(r=>r.needsRestock),open=deriveOpenOrders(snapshot,{date:TODAY}).open;
 const allCovered=restock.length>0&&restock.every(r=>open.some(o=>o.lines.some(l=>l.itemId===r.itemId&&l.remaining>0)));
 const name=(o:OrderRow)=>o.lines.map(l=>x.text(l.itemName??{key:l.itemNameKey})).join(', ');
 const columns:GridColumn<OrderRow>[]=[{id:'date',header:t('supply.order.date'),kind:'text',minWidth:150,value:r=>r.orderedOn??'',render:r=>r.orderedOn?(x.locale==='ko'?x.format.date(r.orderedOn,'short'):r.orderedOn):'—',accessibleValue:r=>r.orderedOn?(x.locale==='ko'?x.format.date(r.orderedOn,'short'):r.orderedOn):'—',sortable:true},{id:'item',header:t('supply.order.item'),kind:'text',minWidth:260,value:name,render:r=><Lines wrap items={r.lines.map(l=>x.text(l.itemName??{key:l.itemNameKey}))}/>,sortable:true},{id:'qty',header:t('supply.order.qty'),kind:'computed',minWidth:150,value:r=>r.lines.map(l=>x.format.quantity(l.ordered,l.unit)).join(', '),render:r=><Lines items={r.lines.map(l=>x.format.quantity(l.ordered,l.unit))}/>},{id:'total',header:t('supply.order.total'),kind:'computed',minWidth:160,value:r=>r.total,render:r=>x.format.money(r.total,'full')},{id:'due',header:t('supply.order.due'),kind:'text',minWidth:160,value:r=>r.dueDate??'',accessibleValue:r=>r.dueDate?(x.locale==='ko'?x.format.date(r.dueDate,'short'):r.dueDate):'—',editable:r=>r.open,sortable:true,render:r=><DueDateCell order={r} host={host}/>},{id:'remaining',header:t('supply.order.remaining'),kind:'computed',minWidth:160,value:r=>r.lines.map(l=>`${x.format.quantity(l.received,l.unit)} / ${x.format.quantity(l.remaining,l.unit)}`).join(', '),render:r=><Flash slot={`suppliers:order:${r.poId}:remaining`} value={r.lines.map(l=>[l.received,l.remaining])}><Lines items={r.lines.map(l=>`${x.format.quantity(l.received,l.unit)} / ${x.format.quantity(l.remaining,l.unit)}`)}/></Flash>},
  // At 125%, reserve room for two chips, their icons and the cell padding.
  {id:'status',header:t('supply.order.status'),kind:'status',minWidth:scale===125?328:264,render:r=><Flash slot={`suppliers:order:${r.poId}:status`} value={`${r.status}:${r.overdue}`}><StatusChip tone={r.status==='complete'?'success':r.status==='partial'?'warning':'neutral'}>{t(r.status==='scheduled'?'supply.order.pending':r.status==='partial'?'supply.order.partial':r.status==='complete'?'supply.order.complete':'supply.order.canceled')}</StatusChip>{r.overdue?<StatusChip tone="warning">{t('supply.order.issue')}</StatusChip>:null}</Flash>,value:r=>`${t(r.status==='scheduled'?'supply.order.pending':r.status==='partial'?'supply.order.partial':r.status==='complete'?'supply.order.complete':'supply.order.canceled')}${r.overdue?` · ${t('supply.order.issue')}`:''}`}];
 // The rows are the widget model's orders: the same ones the panel counts, including the overdue example of the 특수 preview.
 // `SuppliersModel.orders` is typed as the narrow panel row, but the projector builds it from deriveOpenOrders, so each one is the full row.
 let rows=(model.orders as readonly OrderRow[]).filter(r=>`${name(r)} ${x.text(r.supplierName??{key:r.supplierNameKey})}`.toLowerCase().includes(query.trim().toLowerCase()));rows=sortGridRows(rows,columns,sort,r=>r.poId,byNearestDue);
 const grid=<>
  {pending?<p role="status"><Spinner /> {t('supply.order.saving')}</p>:null}
  <DataGrid id="orders-grid" label={t('supply.order.orders')} rows={rows} getRowId={r=>r.poId} getRowLabel={name} columns={columns}
   query={query} searchLabel={x.locale==='ko'?t('supply.order.search'):undefined} searchPlaceholder={x.locale==='ko'?t('supply.order.search'):undefined} onQueryChange={setQuery}
   sort={sort} onSortChange={setSort} focus={focus} onFocusChange={setFocus} selectedRowId={[...expanded][0]??null} expandedRowIds={expanded}
   onExpandedChange={setExpanded} onSelectionChange={id=>setExpanded(id?new Set([id]):new Set())} renderExpanded={r=><div key={r.poId}>{orderActions(r)}</div>}
   addAction={{id:'add',label:t('supply.order.add'),disabled:!snapshot.tables.purchaseItem.length,onPress:()=>{
    const item=snapshot.tables.purchaseItem[0];
    if (item) setForm({id:item.purchaseItemId,qty:minimumOrder(item)});
   }}}
   renderAddRow={()=>form?<AddOrder key={form.id} purchaseItemId={form.id} qty={form.qty} dueDate={form.dueDate} suggestionItemId={form.suggestionItemId} host={host}
    onClose={()=>setForm(current=>current===form?null:current)}/>:null}
   error={dueError} onErrorDismiss={()=>setDueError(undefined)}
   onCommit={edit=>{
    if(pending||!isIsoDate(edit.raw))return {ok:false,error:{id:edit.editToken,message:pending?t('supply.order.saving'):x.tk('data.error.dateInvalid')}};
    let error: {id:string;message:string}|undefined;
    setDueError(undefined);
    run({type:'suppliers.changeDueDate',poId:edit.rowId,date:edit.raw},result=>{
     if(result.ok){notifyPurchase(host,result,'data.notice.dueDateChanged');return;}
     const note={id:edit.editToken,message:x.tk(result.messageKey)};
     if(http)setDueError({rowId:edit.rowId,columnId:edit.columnId,error:note});
     else error=note;
    });
    return error?{ok:false,error}:{ok:true};
   }} noResultsContent={t('supply.order.noResults')} emptyContent={t('supply.order.empty')}/>
  {rows.map(r=><GridValueSlot key={r.poId} gridId="orders-grid" rowId={r.poId} columnId="due" slot={`suppliers:order:${r.poId}:due`} value={r.dueDate}/>)}
 </>;
 const items=<PurchaseGrid host={host} initialRowId={initialPurchaseItem}/>;
 const suppliers=<SupplierGrid host={host} initialAdd={initialSupplierAdd} initialRowId={initialSupplier}/>;
 return <><section><h3>{t('supply.order.suggestions')}</h3>{suggestions.length?suggestions.map(s=>{const item=snapshot.tables.inventoryItem.find(i=>i.itemId===s.itemId),supplier=model.suppliers.find(v=>v.supplierId===s.supplierId);return <div key={s.itemId}>{item?x.text(item.name??{key:item.nameKey}):''} {x.format.quantity(s.qty,s.unit)} · {x.format.number(s.total)}원 · {supplier?x.text(supplier.name??{key:supplier.nameKey}):''} · {x.locale==='ko'?x.format.date(s.dueDate,'short'):s.dueDate} <ActionButton onClick={()=>{setTab('orders');setForm({id:s.purchaseItemId,qty:s.qty,suggestionItemId:s.itemId});}}>{t('supply.order.order')}</ActionButton></div>}):<p>{allCovered&&x.locale==='ko'?t('supply.order.covered',{n:open.length}):t('supply.order.none')}</p>}</section><DetailTabs label={t('supply.order.orders')} value={tab} onValueChange={setTab} tabs={[{value:'items',label:t('supply.order.items')},{value:'suppliers',label:t('supply.order.suppliers')},{value:'orders',label:t('supply.order.orders')}]} panels={{orders:grid,items,suppliers}}/></>;
}
